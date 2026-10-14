/**
 * atomcode-bridge — Cordis plugin (Host half, tools-only).
 *
 * Repositioned build (v0.3): the "model provider takeover" half of the
 * original upstream design (LlmAdapter over the daemon /chat) is REMOVED.
 * A full autonomous agent (own tool loop, own system prompt, bypass
 * approval) plugged into DSH's one-completion socket breaks DSH's tool
 * loop, punches through its permission model, and re-feeds O(N²) tokens
 * per conversation turn. What remains is the honest shape of this bridge:
 *
 *  1. `atomcode_ask` — side-conversation relay. One message goes to the
 *     local AtomCode daemon (`POST /chat`, SSE); the whole autonomous turn
 *     comes back as one answer. `continue: true` resumes the previously
 *     recorded side conversation (session map keyed by working_dir, stored
 *     at ~/.dsh/state/dsh-atomcode-bridge/), so the model never carries ids.
 *  2. `atomcode_review` — one-shot code review. Wraps the CLI's
 *     `atomcode review` (git range / PR / diff-file / custom task) with
 *     round + wall-clock fuses and `--no-web` for proxy-gated hosts;
 *     returns the structured `--json` findings.
 *
 * KNOWN LIMITATIONS (v0.3):
 *   - atomcode_review requires a **direct** `[providers.<name>]` entry with
 *     `base_url` in `~/.atomcode/config.toml`; account-resolved models
 *     (AtomGit gateway) are NOT seen by the review CLI. The tool description
 *     is dynamically downgraded on mount if config inspection shows
 *     unavailability. Daemon-side `atomcode_ask` is NOT affected — it embeds
 *     the gateway signing.
 *   - The `sessions.json` file uses a profile-scoped key prefix so cross-
 *     profile (web + desktop) writes do not collide.
 *
 * Cross-platform: paths resolve from `os.homedir()`, the binary is found
 * via $ATOMCODE_BIN / config / PATH (atomcode.exe on Windows). The daemon
 * conversation runs over global `fetch`; the review runs the CLI directly.
 * No shell pipelines, no hardcoded accounts, no host LLM dependency — this
 * plugin only consumes the `tools` service.
 *
 * @module dsh-atomcode-bridge
 */
import {
  DEFAULT_PORT,
  askChat,
  health,
  spawnDaemon,
} from './daemon.js';
import { createSessionStore, defaultStatePath } from './sessions.js';
import { runReview, checkReviewProvision } from './review.js';

/**
 * Host-side status endpoint helpers (read-only, same-origin).
 * Mirrors the dsh-connect-sensenova-token-plan snapshot route contract so the
 * plugin detail-page client can poll live startup/usage stats.
 */
function writeJson(res, status, body, headers) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(headers || {}) });
  res.end(JSON.stringify(body));
}

/** Reject cross-origin reads: the panel and the host share one origin. */
function sameOrigin(request) {
  const reqHeaders = request && request.headers;
  const host = reqHeaders ? reqHeaders.host || reqHeaders.Host : undefined;
  const origin = reqHeaders ? reqHeaders.origin || reqHeaders.Origin : undefined;
  if (!origin) return true; // non-browser / same-origin fetch omits Origin
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Profile key used to namespace session keys (e.g. "web" or "desktop"). */
function detectProfileKey() {
  // DSH sets DSH_PROFILE in the host process environment; fall back to the
  // fiber entry id for the profile name heuristic.
  const env = process.env.DSH_PROFILE || '';
  if (env && (env === 'web' || env === 'desktop' || env === 'headless')) return env;
  // Attempt to detect from argv: "dsh web" -> "web", "dsh desktop" -> "desktop"
  const argv = process.argv.join(' ');
  if (/dsh.*\bdesktop\b/i.test(argv)) return 'desktop';
  if (/dsh.*\bweb\b/i.test(argv)) return 'web';
  return '';
}

/** Snapshot body consumed by the plugin detail-page client. */
function buildStatsBody(stats) {
  return {
    ok: true,
    name: 'dsh-atomcode-bridge',
    displayName: 'DSH AtomCode Bridge',
    version: '0.3.0',
    uptimeMs: Date.now() - stats.startedAt,
    daemon: {
      up: stats.daemonUp,
      port: stats.port,
      autoStart: stats.autoStart,
      spawnTried: stats.spawnTried,
      lastCheckedAt: stats.lastHealthAt,
    },
    binary: {
      configured: stats.binaryConfigured,
      env: stats.binaryEnv,
      source: stats.binaryConfigured ? 'config' : stats.binaryEnv ? 'env' : 'auto',
    },
    config: {
      approvalMode: stats.approvalMode,
      defaultWorkingDir: stats.defaultWorkingDir,
      reviewAvailable: stats.reviewAvailable,
      reviewReason: stats.reviewReason,
    },
    sessions: { tracked: stats.sessionsTracked },
    ask: stats.ask,
    review: stats.review,
  };
}

export const name = 'atomcode-bridge';
export const inject = ['tools', 'webServer'];

/**
 * Config arrives unvalidated from the Loader patch (the sibling bridge
 * `dsh-connect-sensenova-token-plan` ships no DSH Config schema either);
 * each field is defaulted and type-guarded here so a malformed row
 * degrades to safe defaults instead of failing the mount. Recognized keys:
 *   port (13459) · auto_start (true) · binary ('') · approval_mode ('bypass')
 *   working_dir ('') · state_path ('') · review_no_web (true)
 *   review_max_rounds (35) · review_max_duration_secs (900)
 *   ask_max_rounds (0 = unlimited) · session_key_prefix ('' = auto-detect)
 */
export function apply(ctx, rawConfig = {}) {
  // The Loader hands config values through as `{ get() }` boxes; unwrap
  // first (same normalization dsh-connect-qoder performs).
  const config = {};
  for (const [key, value] of Object.entries(rawConfig ?? {})) {
    config[key] = value && typeof value.get === 'function' ? value.get() : value;
  }

  const port = Number.isInteger(config.port) && config.port > 0 ? config.port : DEFAULT_PORT;
  const autoStart = config.auto_start !== false;
  const binary = typeof config.binary === 'string' && config.binary !== '' ? config.binary : undefined;
  const approvalMode =
    typeof config.approval_mode === 'string' && config.approval_mode !== ''
      ? config.approval_mode
      : 'bypass';
  const defaultWorkingDir =
    typeof config.working_dir === 'string' && config.working_dir !== '' ? config.working_dir : undefined;
  const askMaxRounds =
    Number.isInteger(config.ask_max_rounds) && config.ask_max_rounds > 0
      ? config.ask_max_rounds
      : 0; // 0 = unlimited (the daemon's own loop governs)
  const sessionKeyPrefix =
    typeof config.session_key_prefix === 'string' && config.session_key_prefix !== ''
      ? config.session_key_prefix
      : detectProfileKey();
  const sessions = createSessionStore(
    typeof config.state_path === 'string' && config.state_path !== ''
      ? config.state_path
      : defaultStatePath(),
    sessionKeyPrefix,
  );
  const reviewNoWeb = config.review_no_web !== false;
  const reviewMaxRounds =
    Number.isInteger(config.review_max_rounds) && config.review_max_rounds > 0
      ? config.review_max_rounds
      : 35;
  const reviewMaxDurationSecs =
    Number.isInteger(config.review_max_duration_secs) && config.review_max_duration_secs > 0
      ? config.review_max_duration_secs
      : 900;

  const binaryEnv =
    typeof process.env.ATOMCODE_BIN === 'string' && process.env.ATOMCODE_BIN !== ''
      ? process.env.ATOMCODE_BIN
      : undefined;

  // Probe review CLI availability at mount time (best-effort: no live spawn).
  const reviewProvision = checkReviewProvision();

  const log = (message) => ctx.logger?.warn(`[atomcode-bridge] ${message}`);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Live status snapshot, mirrored by the plugin detail-page client over the
   * read-only `/api/atomcode-bridge/stats` route. Counters accumulate for the
   * life of the plugin mount; `daemonUp`/`lastHealthAt` are refreshed on each
   * stats poll (5s cache) and on every ask dispatch.
   */
  const stats = {
    startedAt: Date.now(),
    port,
    autoStart,
    binaryConfigured: !!binary,
    binaryEnv,
    approvalMode,
    defaultWorkingDir: defaultWorkingDir ?? null,
    daemonUp: false,
    spawnTried: false,
    lastHealthAt: 0,
    reviewAvailable: reviewProvision.available,
    reviewReason: reviewProvision.reason,
    sessionsTracked: 0,
    ask: { calls: 0, ok: 0, err: 0, msTotal: 0, tokens: 0 },
    review: { calls: 0, ok: 0, err: 0, msTotal: 0 },
  };

  /** Refresh daemon liveness with a short cache (used by both ask + stats). */
  async function refreshHealth(force = false) {
    if (!force && Date.now() - stats.lastHealthAt < 5000) return stats.daemonUp;
    try {
      stats.daemonUp = await health(port);
    } catch {
      stats.daemonUp = false;
    }
    stats.lastHealthAt = Date.now();
    return stats.daemonUp;
  }

  /** Daemon liveness with a one-time detached spawn (the ask path only). */
  async function ensureDaemon() {
    if (await refreshHealth()) return true;
    if (autoStart && !stats.spawnTried) {
      stats.spawnTried = true;
      await spawnDaemon({
        port,
        ...(binary ? { binary } : {}),
        ...(defaultWorkingDir ? { workingDir: defaultWorkingDir } : {}),
        log,
      });
      for (let i = 0; i < 20; i++) {
        await sleep(1500);
        if (await refreshHealth(true)) return true;
      }
    }
    return false;
  }

  const tools = ctx.get('tools');
  if (tools === undefined) return; // inject declares it; belt and braces.

  // ── atomcode_ask：侧边对话（daemon 自主回合 + 会话连续性） ──────────────
  const disposeAsk = tools.register({
    name: 'atomcode_ask',
    description:
      '把一条消息转发给本机 AtomCode（终端 AI 编程助手，官方二进制）的 daemon 执行一个完整自主回合（它自带工具循环，bypass 无人值守放行），取回整轮回复。' +
      '用于"帮我问 AtomCode / 让 AtomCode 处理 / 侧边咨询"场景；拿到结果后把 reply 转达给用户。' +
      'continue=true 接续本工作目录上一次侧边对话（自动恢复 session，无需记 id）；默认开新线。' +
      '整回合可能数分钟。',
    // Declare timeoutMs so the DSH tool timeout policy can see this tool.
    // askChat's own timeout (timeout_secs param) is the actual wire budget;
    // 30min here mirrors askChat's default and keeps the host guard from
    // killing mid-turn.
    timeoutMs: 30 * 60 * 1000,
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '转发给 AtomCode 的消息（通常是用户最新一句话的原文）' },
        continue: { type: 'boolean', description: '可选：接续上一次侧边对话（默认 false，开新会话）' },
        session_id: { type: 'string', description: '可选：显式接续某个 AtomCode 会话（优先于 continue）' },
        provider: { type: 'string', description: '可选：点名 AtomCode provider/模型（如 "AtomGit-qwen3.8-27b"）；缺省用其默认模型' },
        working_dir: { type: 'string', description: '可选：回合的工作目录，同时是侧边对话的会话键；缺省用插件配置' },
        timeout_secs: { type: 'number', description: '可选：整回合超时秒数，默认 1800' },
        max_rounds: { type: 'number', description: '可选：agent 工具调用轮数上限（默认不限，走 daemon 自带治理）' },
      },
      required: ['message'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reply: { type: 'string' },
          session_id: { type: 'string' },
          continued: { type: 'boolean' },
          tokens: { type: 'number' },
          tool_calls: { type: 'number' },
          round_count: { type: 'number' },
          tools: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, success: { type: 'boolean' } },
              required: ['name', 'success'],
              additionalProperties: false,
            },
          },
          stop_reason: { type: 'string' },
          provider: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok', 'reply', 'session_id', 'continued', 'tokens', 'tool_calls', 'tools', 'stop_reason', 'provider', 'error'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [];
        if (value.ok) {
          lines.push(value.continued ? 'AtomCode 接续回复（侧边对话）:' : 'AtomCode 回复:', value.reply || '(空回复)', '');
          const meta = [];
          meta.push(`session_id=${value.session_id}`);
          meta.push(`tokens=${value.tokens}`);
          if (value.round_count != null && value.round_count > 0) meta.push(`rounds=${value.round_count}`);
          meta.push(`tool_calls=${value.tool_calls}`);
          meta.push(`stop_reason=${value.stop_reason}`);
          meta.push(`provider=${value.provider}`);
          lines.push(`[${meta.join(' ')}]`);
        } else {
          lines.push(`AtomCode 调用失败: ${value.error}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const empty = (error) => ({
        ok: false,
        reply: '',
        session_id: '',
        continued: false,
        tokens: 0,
        tool_calls: 0,
        round_count: 0,
        tools: [],
        stop_reason: '',
        provider: typeof args.provider === 'string' ? args.provider : 'default',
        error,
      });
      const workDir =
        typeof args.working_dir === 'string' && args.working_dir.trim() !== ''
          ? args.working_dir
          : defaultWorkingDir;
      const sessionKey = workDir ? workDir.replace(/[/\\]+$/, '') : 'default';

      let sessionId =
        typeof args.session_id === 'string' && args.session_id.trim() !== ''
          ? args.session_id.trim()
          : args.continue === true
            ? sessions.get(sessionKey)
            : undefined;
      const continued = sessionId !== undefined;

      const t0 = Date.now();
      stats.ask.calls += 1;
      if (!(await ensureDaemon())) {
        stats.ask.err += 1;
        stats.ask.msTotal += Date.now() - t0;
        return empty(
          `AtomCode daemon 不可用（http://127.0.0.1:${port} 未监听${autoStart ? '，自动拉起也失败' : ''}）`,
        );
      }
      const timeoutMs =
        Number.isFinite(args.timeout_secs) && args.timeout_secs > 0
          ? Math.floor(args.timeout_secs) * 1000
          : 30 * 60 * 1000;
      const maxRounds = Number.isFinite(args.max_rounds) && args.max_rounds > 0
        ? Math.floor(args.max_rounds)
        : askMaxRounds;
      const result = await askChat({
        message: String(args.message || ''),
        port,
        approvalMode,
        timeoutMs,
        ...(maxRounds > 0 ? { maxRounds } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(typeof args.provider === 'string' && args.provider !== '' ? { provider: args.provider } : {}),
        ...(workDir ? { workingDir: workDir } : {}),
        ...(exec?.signal ? { signal: exec.signal } : {}),
      });
      stats.ask.msTotal += Date.now() - t0;
      if (result.ok) {
        stats.ask.ok += 1;
        if (Number.isFinite(result.tokens)) stats.ask.tokens += result.tokens;
      } else {
        stats.ask.err += 1;
      }
      if (result.ok && result.sessionId) sessions.set(sessionKey, result.sessionId);
      return {
        ok: result.ok,
        reply: result.reply.slice(0, 200_000),
        session_id: result.sessionId,
        continued,
        tokens: result.tokens,
        tool_calls: result.toolCalls,
        round_count: result.roundCount ?? 0,
        tools: result.tools,
        stop_reason: result.stopReason,
        provider: result.provider,
        error: result.error,
      };
    },
  });

  // ── atomcode_review：one-shot 代码评审（CLI 子命令） ─────────────────────
  // Dynamically build the description: if the local config has no direct
  // [providers.<name>] entry with base_url that the review CLI can resolve,
  // prefix with a status warning.
  const reviewBaseDesc =
    '让本机 AtomCode（官方二进制）对一次代码变更做 one-shot 结构化评审：默认评未提交改动；也可给 base 分支 / GitHub PR / diff 文本 / 自定义任务。' +
    '有界的一次性 agent 运行（轮数 + 墙钟双保险丝，默认关 web 搜索），完成返回 --json 结构化 findings。可能数分钟；把结论摘要转达用户，findings 原文在 report。';
  const reviewDesc = reviewProvision.available
    ? reviewBaseDesc
    : `注意：本机 AtomCode 配置下 review CLI 不可用（${reviewProvision.reason}），只能走 daemon 侧的 atomcode_ask 做侧边咨询。` + reviewBaseDesc;

  const disposeReview = tools.register({
    name: 'atomcode_review',
    // timeoutMs: the review CLI has its own max_duration fuse; set 30min so
    // the host guard never kills before the CLI's own fuse.
    timeoutMs: 30 * 60 * 1000,
    description: reviewDesc,
    parameters: {
      type: 'object',
      properties: {
        working_dir: { type: 'string', description: '仓库根目录（--repo）' },
        task: { type: 'string', description: '可选：自定义任务文本，替代 diff 评审（问题/目标代码/上下文都写进来）' },
        base: { type: 'string', description: '可选：base git ref，评审 <base>...HEAD；缺省评未提交改动' },
        staged: { type: 'boolean', description: '可选：只评已暂存改动（git diff --staged）' },
        pr: { type: 'number', description: '可选：GitHub PR 号（需本机 gh CLI）' },
        diff_text: { type: 'string', description: '可选：原始 diff 文本（写临时文件走 --diff-file；适合非 git 场景/CI 产物）' },
        provider: { type: 'string', description: '可选：点名 AtomCode provider/模型（缺省用其默认模型）' },
        max_rounds: { type: 'number', description: '可选：评审 agent 轮数保险丝（默认取插件配置，通常 35）' },
        max_duration_secs: { type: 'number', description: '可选：墙钟保险丝秒数（默认取插件配置，通常 900）' },
        enable_web: { type: 'boolean', description: '可选：允许评审用 web_search（默认 false，适配受限网络）' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          report: { type: 'string' },
          error: { type: 'string' },
          exit_code: { type: 'number', description: '进程退出码；-1 表示进程未能启动' },
          duration_ms: { type: 'number' },
        },
        required: ['ok', 'report', 'error', 'exit_code', 'duration_ms'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [];
        if (value.ok) {
          lines.push(`AtomCode 评审完成（${Math.round(value.duration_ms / 1000)}s）:`, value.report || '(空 findings)');
        } else {
          lines.push(`AtomCode 评审失败: ${value.error}`);
          if (value.report) lines.push('--- 部分输出 ---', value.report.slice(0, 5000));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const workDir =
        typeof args.working_dir === 'string' && args.working_dir.trim() !== ''
          ? args.working_dir
          : defaultWorkingDir;
      const t0 = Date.now();
      stats.review.calls += 1;
      const result = await runReview({
        workingDir: workDir,
        ...(typeof args.task === 'string' && args.task.trim() !== '' ? { task: args.task } : {}),
        ...(typeof args.base === 'string' && args.base.trim() !== '' ? { base: args.base } : {}),
        ...(args.staged === true ? { staged: true } : {}),
        ...(Number.isFinite(args.pr) && args.pr > 0 ? { pr: args.pr } : {}),
        ...(typeof args.diff_text === 'string' && args.diff_text.trim() !== '' ? { diffText: args.diff_text } : {}),
        ...(typeof args.provider === 'string' && args.provider !== '' ? { provider: args.provider } : {}),
        maxRounds: Number.isFinite(args.max_rounds) ? args.max_rounds : reviewMaxRounds,
        maxDurationSecs: Number.isFinite(args.max_duration_secs) ? args.max_duration_secs : reviewMaxDurationSecs,
        noWeb: args.enable_web === true ? false : reviewNoWeb,
        ...(binary ? { binary } : {}),
        ...(exec?.signal ? { signal: exec.signal } : {}),
        log,
      });
      stats.review.msTotal += Date.now() - t0;
      if (result.ok) stats.review.ok += 1;
      else stats.review.err += 1;
      return {
        ok: result.ok,
        report: result.report.slice(0, 200_000),
        error: result.error,
        exit_code: result.exitCode ?? -1,
        duration_ms: result.durationMs,
      };
    },
  });

  // ── 插件详情页统计接口（只读，同源轮询） ─────────────────────────────────
  const disposeStats = ctx.webServer.register({
    kind: 'exact',
    path: '/api/atomcode-bridge/stats',
    handler: async (request, response) => {
      if (request && request.method && request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();
        return;
      }
      if (!sameOrigin(request)) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('forbidden');
        return;
      }
      // Reflect the live tracked-session count on read.
      stats.sessionsTracked = sessions.count();
      await refreshHealth();
      writeJson(response, 200, buildStatsBody(stats), { 'cache-control': 'no-store' });
    },
  });

  // Teardown only runs when the plugin unmounts: `ctx.effect(fn)` executes `fn`
  // at setup and treats its RETURN VALUE as the cleanup, so the disposers must
  // be returned (not invoked in the body — that would unregister the tools
  // immediately). Matches the dsh-connect-sensenova-token-plan pattern.
  ctx.effect(() => {
    return () => {
      disposeAsk();
      disposeReview();
      if (typeof disposeStats === 'function') disposeStats();
    };
  });
}
