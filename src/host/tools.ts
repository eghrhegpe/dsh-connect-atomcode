/**
 * The two tools this plugin registers — `atomcode_ask` (a full autonomous
 * daemon turn with side-conversation continuity) and `atomcode_review` (a
 * one-shot code review through the CLI subcommand).
 *
 * Extracted from `src/host/index.ts` (v0.4.3 split). They live together because
 * they share the one `tools.register` surface and the one `runtime`; each tool
 * still owns its description string end to end, which is why the two
 * `providerHint` strings are built HERE next to the `register()` calls that
 * consume them — a description separated by hundreds of lines from the code it
 * describes goes quietly stale with nothing failing.
 *
 * @module dsh-connect-atomcode/host/tools
 */
import { askChat, TOOLS_CAP } from './daemon.ts';
import {
  checkReviewProvision,
  FINDINGS_CAP,
  probeLocalEndpoint,
  PROVIDER_FIX,
  runReview,
  selectReviewProvider,
} from './review.ts';
import { isLoopbackBaseUrl } from '../shared/loopback.ts';
import { describeDaemonDown } from './stats.ts';
import {
  HOST_TOOL_TIMEOUT_MS,
  HOST_TOOL_TIMEOUT_SECS,
  MAX_REVIEW_DURATION_SECS,
  resolveDurationSecs,
  resolveMaxRounds,
} from './config.ts';
import type { HostConfig } from './config.ts';
import type { Runtime } from './runtime.ts';
import { resolve } from 'node:path';

/**
 * The active DSH session's working directory as exposed by the host on the
 * tool-call context — a READY-TO-USE auto-fill hook.
 *
 * The DSH host does not pass the session's cwd to plugin tools yet, so this
 * returns `undefined` today and the fallback ladders below behave exactly as
 * before (tests pass `exec = {}`, so it stays a no-op there). The moment the
 * host exposes that cwd on the tool-call context (this reads `exec.cwd`; the
 * field name is the one to align with the host), `working_dir` auto-fills with
 * the repo the user actually has open. Safe for BOTH tools: it is the user's
 * repo, not the host process's launch directory — 红线 8 only excludes the
 * host cwd, never the session cwd.
 */
function hostSessionCwd(exec: any): string | undefined {
  return exec && typeof exec.cwd === 'string' && exec.cwd.trim() !== '' ? exec.cwd : undefined;
}

/**
 * `atomcode_ask` — one full autonomous daemon turn, with side-conversation
 * continuity.
 *
 * The description is assembled HERE rather than at the mount site: `providerHint`
 * names the live state of `default_provider`, so it and the `register()` call that
 * consumes it belong in the same scope. They used to be separated by hundreds of
 * lines, which is how a description goes quietly stale against the code it
 * describes with nothing failing.
 *
 * @returns {() => void} the tool’s disposer.
 */
export function mountAskTool({
  tools,
  config,
  runtime,
}: {
  tools: any;
  config: HostConfig;
  runtime: Runtime;
}) {
  const {
    port,
    autoStart,
    approvalMode,
    defaultWorkingDir,
    defaultProvider,
    askMaxRounds,
  } = config;
  const {
    stats,
    sessions,
    resolveProvider,
    ensureDaemon,
  } = runtime;

  // Said out loud in BOTH tool descriptions. The most common wrong move against
  // this bridge is assuming `provider` takes a model id — it does not: AtomCode
  // 5.x names its model PROFILES ("AtomGit-glm5.3-flash"), and that profile name
  // is what /chat's `provider` and config.toml's `default_provider` both hold.
  // Telling the model before the call beats a wrong-provider turn (红线 1's
  // "inform before, not after" discipline, applied to model selection).
  // The parenthetical names the state of `default_provider`, so it belongs TO that
  // rung — not after the last one. Appending it to "AtomCode 自己的默认档位" made the
  // ladder read "… > 默认档位（当前…） > 默认档位", i.e. the same rung twice, and this
  // string is the model's ONLY input about the order (红线 8: describe the ladder,
  // never its outcome). Rung counts are pinned by test/ask-glue.test.mjs.
  const providerHint =
    '换模型：provider 参数收的是 AtomCode 的模型档位名（daemon GET /models 里的 provider 字段，' +
    '如 "AtomGit-glm5.3-flash"；不是裸模型 id "glm5.3-flash"）。' +
    '优先级：本参数 > 详情页面板上选的档位 > 插件配置 default_provider' +
    (defaultProvider ? `（当前 default_provider="${defaultProvider}"）` : '（当前未配 default_provider）') +
    ' > AtomCode 自己的默认档位；返回里的 provider= 是 daemon 报的真实生效值。';

  // ── atomcode_ask：侧边对话（daemon 自主回合 + 会话连续性） ──────────────
  const disposeAsk = tools.register({
    name: 'atomcode_ask',
    description:
      '把一条消息转发给本机 AtomCode（终端 AI 编程助手，官方二进制）的 daemon 执行一个完整自主回合（它自带工具循环，approval_mode 默认 bypass 无人值守放行），取回整轮回复。' +
      '用于"帮我问 AtomCode / 让 AtomCode 处理 / 侧边咨询"场景；拿到结果后把 reply 转达给用户。' +
      'continue=true 接续本工作目录上一次侧边对话（自动恢复 session，无需记 id）；默认开新线。续线接到死会话时用 reset_session=true 重新开线。' +
      '整回合可能数分钟。' +
      providerHint,
    // Declare timeoutMs so the DSH tool timeout policy can see this tool.
    // askChat's own timeout (timeout_secs param) is the actual wire budget;
    // the shared constant keeps this declaration and the clamp in execute()
    // (and review's registration) one number, not three copies of `30 * 60 *
    // 1000` that can drift from what the parameter descriptions promise.
    timeoutMs: HOST_TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '转发给 AtomCode 的消息（通常是用户最新一句话的原文）' },
        continue: { type: 'boolean', description: '可选：接续本工作目录上一次侧边对话（默认 false，开新会话）。注意：会话按 working_dir 记忆，同一仓库的两次不相干对话会共用同一条侧边线' },
        session_id: { type: 'string', description: '可选：显式接续某个 AtomCode 会话（优先于 continue）' },
        reset_session: { type: 'boolean', description: '可选：清掉本工作目录记录的侧边会话（续线接到一条已过期的 daemon 会话、或想彻底开新线时用；不影响本回合）' },
        provider: { type: 'string', description: '可选：点名 AtomCode 模型档位，传它就换本次回合用的模型。名字以 daemon GET /models 的 provider 字段为准（如 "AtomGit-glm5.3-flash"），不要传裸模型 id（"glm5.3-flash"）。留空时按顺序取：面板上选的档位 → 插件配置 default_provider → AtomCode 自己的默认' },
        working_dir: { type: 'string', description: '可选：回合的工作目录，同时是侧边对话的会话键。缺省优先级：调用参数 > 宿主会话 cwd（宿主尚未暴露该字段，暴露后自动填入）> 插件配置 working_dir > 宿主 home 兜底' },
        timeout_secs: { type: 'number', description: '可选：整回合超时秒数，默认 1800；上限 1800（本工具向宿主声明的超时上限就是 30 分钟），超过按 1800 计——代码里钳制，不是"传了更大的值但悄悄不生效"' },
        max_rounds: { type: 'number', description: '可选：工具调用次数上限（按 daemon SSE 的 tool_start 事件计数；一个 agent 回合可能并行发起多次工具调用，故事件数 ≥ agent 轮数——把它当轮数理解，会在更少的 agent 轮数上就熔断）。默认取插件配置，当前 ' + askMaxRounds + '；上限 1000，超过按 1000 计（钳制在代码里，inflate 关不掉熔断）。传 0 关掉本端熔断，交回 daemon 自带治理——与 atomcode_review 的 max_rounds: 0 同义）。超限时本端中止等待并返回错误，同时向 daemon 发 POST /chat/stop 请求停掉该回合（以 daemon 应答为准；回合刚开始还没拿到 session_id 时无法请求，错误文本会说明这一种情况）' },
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
          truncated: { type: 'boolean', description: 'reply 超过上限被截断（截断处有标记；让 AtomCode 把长内容落盘再读，别只靠这一份摘要）' },
          tokens: { type: 'number' },
          tool_calls: { type: 'number' },
          round_count: { type: 'number', description: '本回合 tool_start 事件数（≥ agent 轮数：同一轮并行发起的工具调用会各计一次）' },
          tools: {
            type: 'array',
            description: `本回合的工具记录，最多 ${TOOLS_CAP} 条（超出部分被省略，见 tools_truncated；tool_calls 仍是真实总数）。success 为 null 表示本端无法判断该次调用成败：daemon 并行发起的工具调用只回 {type:"tool_result",success:..}，不带名字或 id，本端无从知道它属于同一批里的哪一个——此时不猜，一律置 null`,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                success: {
                  type: ['boolean', 'null'],
                  description: '该次工具调用是否成功；null = 并行批次内结果无法归因，成败未知（不是失败）',
                },
              },
              required: ['name', 'success'],
              additionalProperties: false,
            },
          },
          tools_truncated: { type: 'boolean', description: 'tools 数组被截断（只回了前若干条；tool_calls 是真实总数，不代表 tools 就是全部）' },
          stop_reason: { type: 'string' },
          working_dir: {
            type: ['string', 'null'],
            description:
              '本回合实际使用的工作目录（同时是侧边对话的会话键）。null = 本次没有指定：回合跑在 daemon 自己的 cwd 下（通常是用户 home），' +
              '而本工具的 approval_mode 默认 bypass——即在该目录里无人值守放行工具调用。要指定仓库就显式传 working_dir',
          },
          provider: { type: 'string' },
          providerReported: { type: 'boolean', description: 'provider 是否来自 daemon SSE 的 runtime_info（true = 远端实测值；false = daemon 未报，回显本插件请求值、未经远端证实——daemon 升级后若不再发 runtime_info，每回合都会带 false 并标注）' },
          protocol_unknown_types: {
            type: 'array',
            description: '本回合 daemon 发来、本插件不认识的事件类型（空数组 = 词汇表未变，是常态；恒有本字段，故「没观察到漂移」与「没检查漂移」不会混淆）。非空说明 AtomCode 可能已升级或改了事件名。注意：轮数熔断靠计数 tool_start 生效，若被改名的正是这类被计数的事件，熔断会少计甚至完全不触发——此时 round_count 不可信',
            items: { type: 'string' },
          },
          error: { type: 'string' },
        },
        required: ['ok', 'reply', 'session_id', 'continued', 'truncated', 'tokens', 'tool_calls', 'tools', 'tools_truncated', 'stop_reason', 'working_dir', 'provider', 'providerReported', 'protocol_unknown_types', 'error'],
        additionalProperties: false,
      },
      render(_args: any, value: any) {
        const lines = [];
        if (value.ok) {
          lines.push(value.continued ? 'AtomCode 接续回复（侧边对话）:' : 'AtomCode 回复:', value.reply || '(空回复)', '');
          // A completed turn can still carry a mid-stream error event (the
          // daemon reported a problem, then the turn recovered and `done`
          // arrived). That caveat used to be erased at aggregation; showing it
          // here keeps red line 3 honest: the model must see "completed WITH a
          // reported failure", not a bare success.
          if (value.error) {
            lines.push(`[注意：本回合收到 done 但流中带有 error 事件，回复可能残缺: ${value.error}]`, '');
          }
          if (value.truncated) {
            lines.push('[注意：reply 已截断，让 AtomCode 把完整内容写到文件里再读]', '');
          }
          // Same reason as `truncated`: a clipped tool list reads as the full
          // story, and the model would then reason "it called 30 tools" when it
          // called more. `tool_calls` is printed below, so the pair is legible.
          if (value.tools_truncated) {
            lines.push(
              `[注意：tools 只回了前 ${TOOLS_CAP} 条，本回合工具调用不止这些（见 tool_calls）]`,
              '',
            );
          }
          // Same class of caveat, and the one a model is most likely to misread:
          // `success: null` means UNKNOWN (a parallel batch whose results carry
          // no attribution), and reading it as "failed" would re-run work that
          // already succeeded. Say it, with the count, or the null is worse than
          // a wrong boolean — it looks like a value.
          const unattributed = Array.isArray(value.tools)
            ? value.tools.filter((t: any) => t && t.success === null).length
            : 0;
          if (unattributed > 0) {
            lines.push(
              `[注意：tools 里有 ${unattributed} 条 success=null——daemon 并行发起的工具调用结果不带归属标识，` +
                '本端无法判定这些调用的成败（未知，不是失败），不要据此重做]',
              '',
            );
          }
          if (value.providerReported === false) {
            lines.push('[注意：daemon 未报 runtime_info，provider= 是本插件回传请求值、未经远端证实（daemon 可能已升级）]', '');
          }
          // The one thing a turn run without a working_dir never used to say:
          // where its tools actually ran. `null` means the daemon's own cwd (the
          // user's home, in the default launch). Said out loud only when the turn
          // was ALSO unattended (`approval_mode: bypass`, the default) — that
          // pairing is the risk: tools auto-approved in a directory nobody named.
          // review refuses the case outright (红线 8); ask cannot, so it names it.
          // Every turn still carries `working_dir=` in the meta line below.
          if (approvalMode === 'bypass' && (value.working_dir === null || value.working_dir === undefined)) {
            lines.push(
              '[注意：本回合未指定 working_dir，工具在 daemon 自己的 cwd 下执行（通常是用户 home），且 approval_mode=bypass 无人值守放行。' +
                '要限定目录请显式传 working_dir 或配置插件的 working_dir]',
              '',
            );
          }
          // The drift shape NEITHER error path can report, because the turn
          // SUCCEEDED and carried content — so it reads as a clean turn unless
          // said out loud here. It is worse than a plain caveat: the round fuse
          // that bounds this turn counts `tool_start`, so a renamed tool event
          // leaves the fuse silently disarmed while every surface still reports
          // success. Say which of the two it is rather than hedging.
          if (Array.isArray(value.protocol_unknown_types) && value.protocol_unknown_types.length > 0) {
            lines.push(
              `[注意：本回合 daemon 发来本插件不认识的事件类型（${value.protocol_unknown_types.join(', ')}），` +
                'AtomCode 可能已升级或改了事件名。本端轮数熔断靠计数 tool_start 生效——' +
                (value.round_count === 0
                  ? '而本回合轮数为 0：若被改名的是这类事件，熔断此刻已是失效状态。'
                  : '若被改名的是这类事件，熔断会少计，下面的 round_count 偏小。') +
                '可调小 max_rounds 或人工盯防本轮]',
              '',
            );
          }
          const meta = [];
          meta.push(`session_id=${value.session_id}`);
          meta.push(`tokens=${value.tokens}`);
          if (value.round_count != null && value.round_count > 0) meta.push(`rounds=${value.round_count}`);
          meta.push(`tool_calls=${value.tool_calls}`);
          meta.push(`stop_reason=${value.stop_reason}`);
          // Always present, so "which directory did this run in" is never a
          // guess — `null` is printed as what it means rather than as a blank.
          meta.push(
            `working_dir=${
              value.working_dir === null || value.working_dir === undefined
                ? '未指定（daemon 自己的 cwd）'
                : value.working_dir
            }`,
          );
          meta.push(`provider=${value.provider}`);
          lines.push(`[${meta.join(' ')}]`);
        } else {
          lines.push(`AtomCode 调用失败: ${value.error}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: any, exec: any) {
      // Resolved ONCE, before any failure path, so a refused/failed turn still
      // reports which model the bridge was asking for (`empty()` below) instead
      // of a misleading 'default'. Ladder: argument > panel pick > patch field >
      // AtomCode's own default (send nothing).
      const askProvider = resolveProvider('ask', args.provider).name;
      const empty = (error: any) => ({
        ok: false,
        reply: '',
        session_id: '',
        continued: false,
        truncated: false,
        tokens: 0,
        tool_calls: 0,
        round_count: 0,
        tools: [],
        tools_truncated: false,
        stop_reason: '',
        // Reported on FAILURE too: a refused turn has to be able to say which
        // directory it would have run in — the fallback is the daemon's own cwd,
        // and "unspecified" is not the same fact as "this repo".
        working_dir: workDir || null,
        provider: askProvider || 'default',
        providerReported: false,
        protocol_unknown_types: [],
        error,
      });
      // Repo ladder: explicit arg > host session cwd (ready-to-use hook) > plugin
      // config `working_dir` > (nothing -> the daemon's own home fallback).
      const workDir =
        typeof args.working_dir === 'string' && args.working_dir.trim() !== ''
          ? args.working_dir
          : hostSessionCwd(exec) ?? defaultWorkingDir;
      // Normalise the working directory so that `C:\Repo`, `c:\repo` and
      // `C:\repo\` all map to the SAME session key. `resolve` on Windows
      // uppercases the drive letter and collapses trailing slashes; on
      // POSIX it makes the path absolute. Without this, Windows users
      // silently get two session lines for the same repo.
      const sessionKey = workDir ? resolve(workDir) : 'default';

      let sessionId =
        typeof args.session_id === 'string' && args.session_id.trim() !== ''
          ? args.session_id.trim()
          : args.continue === true
            ? sessions.get(sessionKey)
            : undefined;

      // `reset_session` clears the stale mapping WITHOUT ending this turn's own
      // resume. An explicit `session_id` is the caller's own pin and always
      // wins: it is (re)recorded so the NEXT `continue: true` resumes it
      // instead of the stale one. Without a pin, the stale mapping is dropped
      // AND this turn does not resume it — "forget that line, start fresh".
      // This is the escape hatch the old code lacked (its `drop()` had no
      // caller, so a stale id could only be cleared by editing sessions.json).
      if (args.reset_session === true) {
        const pinned =
          typeof args.session_id === 'string' && args.session_id.trim() !== ''
            ? args.session_id.trim()
            : undefined;
        sessions.drop(sessionKey);
        if (pinned) sessions.set(sessionKey, pinned);
        else if (args.continue === true) sessionId = undefined;
      }
      // Computed AFTER the reset, so `continued` describes the session this
      // turn actually replayed (not the one that was just discarded).
      const continued = sessionId !== undefined;

      const t0 = Date.now();
      stats.ask.calls += 1;
      if (!(await ensureDaemon(exec?.signal))) {
        stats.ask.err += 1;
        stats.ask.msTotal += Date.now() - t0;
        // Cancel-during-startup is not a daemon outage; say which it was.
        return empty(
          exec?.signal?.aborted
            ? '已取消：调用方在等待 AtomCode daemon 就绪期间中止了本次调用'
            : `AtomCode daemon 不可用（http://127.0.0.1:${port}：${describeDaemonDown(stats.daemonDownReason)}${autoStart ? '，自动拉起也失败' : ''}）`,
        );
      }
      const timeoutMs =
        Number.isFinite(args.timeout_secs) && args.timeout_secs > 0
          ? // Clamped to the declared host timeout rather than trusted: the
            // description used to promise "上限也是 1800" while the code passed
            // any magnitude through, so an inflated value did not fail safe —
            // it failed as a host-side cancel with no timeout to show for it.
            Math.min(HOST_TOOL_TIMEOUT_SECS, Math.floor(args.timeout_secs)) * 1000
          : HOST_TOOL_TIMEOUT_MS;
      // Same contract as the config field above, and the SAME resolver the review
      // path uses: an explicit 0 is "no fuse", not a missing value. See
      // resolveMaxRounds — the two tools used to disagree about that word.
      const maxRounds = resolveMaxRounds(args.max_rounds, askMaxRounds);
      const result = await askChat({
        message: String(args.message || ''),
        port,
        approvalMode,
        timeoutMs,
        // Forwarded unconditionally, 0 included: dropping it here would be the
        // same "0 is not honoured" bug one layer down.
        maxRounds,
        ...(sessionId ? { sessionId } : {}),
        ...(askProvider ? { provider: askProvider } : {}),
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
      // Accumulate protocol drift for the panel, on EVERY turn rather than only
      // successful ones: drift is a fact about the wire, not a property of the
      // reply, and a failed turn that still named an unknown type is exactly the
      // evidence a later diagnosis needs. Union, never replace — see the bag.
      for (const unknownType of result.unknownTypes) {
        if (!stats.protocolUnknownTypes.includes(unknownType)) stats.protocolUnknownTypes.push(unknownType);
      }
      if (result.ok && result.sessionId) sessions.set(sessionKey, result.sessionId);
      // Truncation is MARKED, never silent: a silently clipped 200KB reply reads
      // to the model like a complete answer, which is how a half-copied report
      // becomes a confidently wrong summary.
      // A turn that RESUMED a stored side conversation and then failed has one
      // thing to say that no daemon error will: the stored id may be the problem.
      // `sessions.set()` only records SUCCESSFUL turns, so a dead id is never
      // overwritten — every later `continue: true` replays it and fails again,
      // forever. The escape hatch exists (`reset_session`), but nothing told the
      // caller it was the move, so the failure reads as transient and gets
      // retried into the same dead id.
      //
      // Deliberately NOT auto-dropping the key: a resumed turn can also fail for
      // reasons that leave the session perfectly alive (our own timeout, a
      // network blip, the round fuse), and dropping it would silently end a
      // conversation the user wanted continued. Name the recovery instead —
      // that is the caller's decision to make, with the evidence in hand.
      const resumeHint =
        '本次接续的是本工作目录记录的侧边会话；若该会话已失效（daemon 重启或空闲退出后常见），' +
        '可用 reset_session=true 清掉它再开一条新线';
      const reportedError =
        !result.ok && continued
          ? result.error
            ? `${result.error}（${resumeHint}）`
            : resumeHint
          : result.error;
      // Truncation is MARKED, never silent: a silently clipped 200KB reply reads
      // to the model like a complete answer, which is how a half-copied report
      // becomes a confidently wrong summary.
      const REPLY_CAP = 200_000;
      const truncated = result.reply.length > REPLY_CAP;
      const reply = truncated
        ? `${result.reply.slice(0, REPLY_CAP)}\n\n[truncated by dsh-connect-atomcode: ${
            result.reply.length - REPLY_CAP
          } more characters; ask AtomCode to write the full text to a file and read that instead]`
        : result.reply;
      return {
        ok: result.ok,
        reply,
        session_id: result.sessionId,
        continued,
        truncated,
        tokens: result.tokens,
        tool_calls: result.toolCalls,
        round_count: result.roundCount ?? 0,
        tools: result.tools,
        tools_truncated: result.toolsTruncated === true,
        stop_reason: result.stopReason,
        working_dir: workDir || null,
        provider: result.provider,
        providerReported: result.providerReported,
        protocol_unknown_types: result.unknownTypes,
        error: reportedError,
      };
    },
  });

  return disposeAsk;
}

/**
 * `atomcode_review` — one-shot code review through the CLI subcommand.
 *
 * Same reason as mountAskTool() for building the description here: the note
 * about which provider will be used has to sit next to the `register()` that
 * ships it, so the two cannot describe different ladders.
 *
 * @returns {() => void} the tool’s disposer.
 */
export function mountReviewTool({
  tools,
  config,
  runtime,
  log,
}: {
  tools: any;
  config: HostConfig;
  runtime: Runtime;
  log: (message: any) => void;
}) {
  const {
    binary,
    reviewDefaultProvider,
    reviewWorkingDir,
    reviewNoWeb,
    reviewMaxRounds,
    reviewMaxDurationSecs,
  } = config;
  const {
    stats,
    resolveProvider,
    reviewProvision,
  } = runtime;

  // ── atomcode_review：one-shot 代码评审（CLI 子命令） ─────────────────────
  // Dynamically build the description: if the local config has no direct
  // [providers.<name>] entry with base_url that the review CLI can resolve,
  // prefix with a status warning.
  const reviewBaseDesc =
    '让本机 AtomCode（官方二进制）对一次代码变更做 one-shot 代码评审：默认评未提交改动；也可给 base 分支 / GitHub PR / diff 文本 / 自定义任务。' +
    '有界的一次性 agent 运行（轮数 + 墙钟双保险丝，默认关 web 搜索），完成时 report 里是 CLI 的 --json 原始文本（findings JSON，可能夹带日志行），需自己读出结论并转达用户。' +
    '通路定位：这是"经标准 OpenAI 兼容端点的有界一次性评审"——CLI 不做 AtomCode 专有签名，' +
    'AtomGit 原生网关对推理端点验签，CLI 够不着；若本机没有可用的标准直连条目（含本地 sidecar），' +
    'Atom 原生登录用户的评审改走 atomcode_ask 的原生 code_review（签名 daemon 通路、滚动窗口额度）。' +
    '注意 working_dir 缺省优先级：调用参数 > 宿主会话 cwd（宿主尚未暴露该字段，暴露后自动填入）> 插件配置 review_working_dir；都没有则直接拒绝（绝不回落宿主进程 cwd）——评某个仓库请显式传 working_dir。' +
    '可能数分钟。';
  const reviewUsableProviders = reviewProvision.providers || [];
  // Four different things can be named here and the model must not confuse them:
  // the per-call `provider` argument, the pick the panel wrote to provider.json,
  // the plugin's `review_default_provider`, and the `default_provider` key INSIDE
  // ~/.atomcode/config.toml (which the CLI consults itself). Spell each one out.
  //
  // Phrased as an ORDER with the refusal made CONDITIONAL, not as a claim about
  // the outcome. A tool description is registered ONCE at mount, while the panel
  // pick is read PER CALL — so any unconditional sentence ("留空即点名它" / "留空会
  // 被要求点名") is a coin flip on being false by the next turn. The first version
  // of this note stated both outcomes at once and an external review caught it;
  // the second version would have gone stale the moment someone touched the
  // dropdown. This form stays true in every state.
  const reviewProviderNote =
    reviewUsableProviders.length === 0
      ? ''
      : `（本机可用的直连 provider：${reviewUsableProviders.join(' / ')}；` +
        'provider 留空时按顺序取：详情页面板选的条目 → 插件配置 review_default_provider' +
        `（当前${reviewDefaultProvider ? `="${reviewDefaultProvider}"` : '未配'}）` +
        ' → config.toml 的 default_provider → 唯一的可用直连条目自动顶上；' +
        '只有前面几档都没配上、而本机又存在多个可用直连条目时才会要求你点名，不会替你猜计费通道）';
  const reviewDesc = reviewProvision.available
    ? reviewBaseDesc + reviewProviderNote
    : `注意：本机 AtomCode 配置下 review CLI 不可用（${reviewProvision.reason}），只能走 daemon 侧的 atomcode_ask 做侧边咨询或让 AtomCode 评审。` +
      reviewBaseDesc;

  const disposeReview = tools.register({
    name: 'atomcode_review',
    // timeoutMs: the review CLI has its own max_duration fuse; the shared
    // constant is the same 30min the host sees for ask, so one number governs
    // both registrations and the clamps derived from it.
    timeoutMs: HOST_TOOL_TIMEOUT_MS,
    description: reviewDesc,
    parameters: {
      type: 'object',
      properties: {
        working_dir: { type: 'string', description: '仓库根目录（--repo）。缺省优先级：调用参数 > 宿主会话 cwd（宿主尚未暴露该字段，暴露后自动填入）> 插件配置 review_working_dir；都没有则报错（绝不回落宿主进程 cwd）而不是悄悄评错仓库' },
        task: { type: 'string', description: '可选：自定义任务文本，替代 diff 评审（问题/目标代码/上下文都写进来）' },
        base: { type: 'string', description: '可选：base git ref，评审 <base>...HEAD；缺省评未提交改动' },
        staged: { type: 'boolean', description: '可选：只评已暂存改动（git diff --staged）' },
        pr: { type: 'number', description: '可选：GitHub PR 号（需本机 gh CLI）' },
        diff_text: { type: 'string', description: '可选：原始 diff 文本（写临时文件走 --diff-file；适合非 git 场景/CI 产物）' },
        provider: { type: 'string', description: '可选：点名 AtomCode provider，原样透传给 review CLI 的 --provider。名字以 ~/.atomcode/config.toml 的 [providers.<name>] 条目为准（这条路径不看 daemon /models，也不是裸模型 id——别传 "glm5.3-flash"）；要换该 provider 用的模型，改它条目里的 model。留空时按顺序取：面板上选的条目 → 插件配置 review_default_provider → config.toml 的 default_provider → 自动选择（见工具描述）' },
        max_rounds: { type: 'number', description: '可选：评审 agent 轮数熔断（默认取插件配置，通常 ' + reviewMaxRounds + '；上限 1000，超过按 1000 计。传 0 关掉轮数熔断，交回 CLI 自己治理——与 atomcode_ask 的 max_rounds: 0 同义；墙钟熔断 max_duration_secs 仍然生效）' },
        max_duration_secs: { type: 'number', description: '可选：墙钟保险丝秒数（默认取插件配置，通常 900）。上限 1740s，超过按 1740s 计——进程级兜底取 maxDuration+60s，再大就越过宿主 30min 工具超时，保险丝会失效而不是变长' },
        enable_web: { type: 'boolean', description: '可选：允许评审用 web_search（默认 false，适配受限网络）' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          report: { type: 'string', description: 'CLI --json 的原始 stdout（可能夹带日志行）。findings 是它的结构化读数；两者同在，原始文本不因解析成功而被丢掉' },
          truncated: { type: 'boolean', description: 'report 超过上限被截断（findings 原文不完整，必要时改用 task 缩小范围）' },
          findings_parsed: {
            type: 'boolean',
            description:
              'report 是否被解析成了结构化 findings。false = 没能解析（原始文本仍在 report 里，需自己读结论），' +
              '此时 findings_count=0 表示"没有解析出结论"，**不是"没有问题"**',
          },
          findings_count: { type: 'number', description: '文档里的 finding 条数（findings 数组被截断时它仍是真实总数）' },
          findings: {
            type: 'array',
            description:
              `结构化 findings，最多 ${FINDINGS_CAP} 条（真实总数见 findings_count）。` +
              'severity/file/line 为 null = 该条目没带这个字段（未知），不是"无"；转达时不要把它写成"无严重程度"',
            items: {
              type: 'object',
              properties: {
                severity: { type: ['string', 'null'] },
                file: { type: ['string', 'null'] },
                line: { type: ['string', 'null'] },
                message: { type: 'string' },
              },
              required: ['severity', 'file', 'line', 'message'],
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
          exit_code: { type: 'number', description: '进程退出码；-1 = 未能启动，或被信号终止（超时/取消）。两种含义共用 -1（被信号杀时真实 code 为 null），具体原因看 error' },
          duration_ms: { type: 'number' },
        },
        required: ['ok', 'report', 'truncated', 'findings_parsed', 'findings_count', 'findings', 'error', 'exit_code', 'duration_ms'],
        additionalProperties: false,
      },
      render(_args: any, value: any) {
        const lines = [];
        if (value.ok) {
          // The digest leads the raw document. Both are printed: the digest is
          // the reliable reading (one line per finding, nothing to grep), and the
          // raw text stays because a finding can carry fields the digest does not
          // normalize. Handing back ONLY the raw --json is what let a missed
          // finding pass as "the review was complete".
          const findings = Array.isArray(value.findings) ? value.findings : [];
          lines.push(
            `AtomCode 评审完成（${Math.round(value.duration_ms / 1000)}s${
              value.findings_parsed ? `，${value.findings_count} 条 findings` : '，findings 未能解析'
            }）:`,
          );
          if (value.findings_parsed && findings.length > 0) {
            for (const finding of findings) {
              const where = [finding.file, finding.line].filter((part) => part !== null && part !== '').join(':');
              lines.push(
                `- ${finding.severity ? `[${finding.severity}] ` : ''}${where ? `${where} — ` : ''}${finding.message}`,
              );
            }
            if (findings.length < value.findings_count) {
              lines.push(`[注意：只列出了前 ${findings.length} 条，共 ${value.findings_count} 条——完整清单见下面的 report 原文]`);
            }
          } else if (value.findings_parsed) {
            lines.push('（findings 文档里没有条目）');
          } else {
            // The one sentence that keeps "not parsed" from reading as "clean".
            lines.push(
              '[注意：--json 原文没能解析成 findings 文档，下面的 report 是原始文本，需自己从中读结论——' +
                'findings_count=0 是"没解析出"，不等于"没有问题"]',
            );
          }
          lines.push('--- report 原文 ---', value.report || '(空 findings)');
          if (value.truncated) lines.push('[注意：findings 已截断，末尾内容不完整]');
        } else {
          lines.push(`AtomCode 评审失败: ${value.error}`);
          if (value.report) lines.push('--- 部分输出 ---', value.report.slice(0, 5000));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: any, exec: any) {
      // Accounting opens ONCE, here, and every refusal below exits through
      // `refuse()`.
      //
      // The four refusals used to repeat `calls += 1; err += 1;` by hand and
      // each one returned `duration_ms: 0` — so `msTotal` only ever counted the
      // calls that got as far as spawning a process, while `calls` counted all
      // of them. The panel's average duration was therefore low by construction
      // (a fast refusal added a denominator and no numerator), and a fifth
      // refusal added later would have inherited the same hole from whichever
      // copy someone read first. One exit cannot forget a line its siblings
      // remember — the same reason `mountRoutes()` returns one disposer for two
      // routes (src/host/routes.ts) and `readQuota` names its cause from one
      // function. The reported `duration_ms` is the real elapsed time now; `0`
      // was never a measurement, just an uninitialised field that looked like
      // one.
      const t0 = Date.now();
      const refuse = (error: string) => {
        stats.review.calls += 1;
        stats.review.err += 1;
        stats.review.msTotal += Date.now() - t0;
        return {
          ok: false,
          report: '',
          truncated: false,
          // "no digest" — never "zero findings": a refused run must not look
          // like a review that found nothing wrong.
          findings_parsed: false,
          findings_count: 0,
          findings: [],
          error,
          exit_code: -1,
          duration_ms: Date.now() - t0,
        };
      };
      // Repo requirement FIRST: a missing repository is the caller's own
      // mistake, and reporting it beats both reviewing the wrong tree and
      // burying it under a config diagnostic. The host process cwd is an
      // implementation detail of how DSH was launched, never the user's repo.
      // Same ladder as ask, different tail: explicit arg > host session cwd
      // (ready-to-use hook) > plugin config `review_working_dir` > REFUSE.
      // The host process cwd stays excluded (红线 8); the session cwd is the
      // repo the user has open, so auto-filling it is never a blind guess.
      const workDir =
        typeof args.working_dir === 'string' && args.working_dir.trim() !== ''
          ? args.working_dir
          : hostSessionCwd(exec) ?? reviewWorkingDir;
      if (!workDir) {
        return refuse(
          'atomcode_review needs a repository: pass working_dir (<repo root>), or set the plugin config ' +
            '`review_working_dir`. Falling back to the host process cwd would review the ' +
            'wrong tree (or nothing) while reporting success.',
        );
      }
      // The mount-time probe is only a hint in the DESCRIPTION; the truth is
      // re-read here, so a config.toml edit after mount is honoured. It is
      // stronger than a description warning: the call is refused before it
      // spawns a process that would fail with a diagnostic aimed at a human.
      const currentProvision = checkReviewProvision();
      if (!currentProvision.available) {
        return refuse(
          `atomcode_review is unavailable on this host: ${currentProvision.reason} ` +
            'Use atomcode_ask instead (the daemon carries the AtomGit gateway signing). ' +
            'If this looks wrong, fix ~/.atomcode/config.toml and retry — this check re-reads it on every call.',
        );
      }
      // Which direct provider will this run use? The CLI's own default is
      // default_provider, which on an AtomGit login host has no base_url ("missing
      // base URL") even when a usable direct entry exists — selection makes that
      // an explicit, single-candidate auto-pick (or a named refusal when several
      // candidates exist, never a guess about which channel to bill).
      // Same ladder as ask, different namespace: argument > panel pick >
      // review_default_provider > the CLI's own auto-selection (红线 8).
      const selection = selectReviewProvider(resolveProvider('review', args.provider).name);
      if (selection.error) {
        return refuse(`atomcode_review: ${selection.error}`);
      }
      if (selection.auto) {
        log(`review provider auto-selected: ${selection.provider} — ${selection.reason}`);
      }
      // A loopback base_url means a local sidecar process (e.g. the
      // atomcode-open-api proxy) is a live dependency: probe it BEFORE spawning
      // so a dead proxy yields this named diagnostic instead of the CLI's opaque
      // "review did not complete (initial pass: Cancelled)". Remote base_urls are
      // deliberately not probed — this host's egress is proxy-gated, and a probe
      // false-negative would refuse a call the CLI could have completed.
      if (selection.baseUrl && isLoopbackBaseUrl(selection.baseUrl)) {
        const probe = await probeLocalEndpoint(selection.baseUrl);
        if (!probe.alive) {
          return refuse(
            `atomcode_review: local provider endpoint ${selection.baseUrl} (provider "${selection.provider}") ` +
              `is not responding (${probe.detail}; tried ${probe.tried.join(', ') || 'no URL'}). ` +
              `${PROVIDER_FIX} ` +
              'Daemon-side atomcode_ask is unaffected (it does not go through this endpoint).',
          );
        }
      }
      // The SAME resolver as the ask path (`resolveMaxRounds`), so one parameter
      // name means one thing across both tools: an explicit 0 reaches
      // buildReviewArgs, which is where it becomes the CLI's own UNLIMITED (the
      // flag is omitted). The wall-clock fuse below keeps its own `> 0` rule —
      // "no round cap" is not "no limit", and that knob was never part of the
      // ambiguity.
      const maxRounds = resolveMaxRounds(args.max_rounds, reviewMaxRounds);
      // The same clamp rule as timeout_secs, one resolver over: a wall-clock
      // fuse above `MAX_REVIEW_DURATION_SECS` does not fail safe, it fails
      // invisible — the process backstop (max+60s) would outlive the host's
      // own guard, so the host kills the call and the caller sees a cancel
      // where the description promised the CLI's fuse.
      const maxDurationSecs = resolveDurationSecs(args.max_duration_secs, reviewMaxDurationSecs, MAX_REVIEW_DURATION_SECS);
      stats.review.calls += 1;
      const result = await runReview({
        workingDir: workDir,
        ...(typeof args.task === 'string' && args.task.trim() !== '' ? { task: args.task } : {}),
        ...(typeof args.base === 'string' && args.base.trim() !== '' ? { base: args.base } : {}),
        ...(args.staged === true ? { staged: true } : {}),
        ...(Number.isFinite(args.pr) && args.pr > 0 ? { pr: args.pr } : {}),
        ...(typeof args.diff_text === 'string' && args.diff_text.trim() !== '' ? { diffText: args.diff_text } : {}),
        ...(selection.provider ? { provider: selection.provider } : {}),
        maxRounds,
        maxDurationSecs,
        // Independent process-level backstop: fires only if the CLI overruns its
        // own --max-duration (the CLI stops itself and reports findings, which is
        // the graceful path). Without this the bridge would wait forever.
        timeoutMs: (maxDurationSecs + 60) * 1000,
        noWeb: args.enable_web === true ? false : reviewNoWeb,
        ...(binary ? { binary } : {}),
        ...(exec?.signal ? { signal: exec.signal } : {}),
        log,
      });
      // Measured from the top of execute(), so the whole call is counted —
      // repo/config/selection/probe included — which is the same span the
      // refusals above book through `refuse()`. Both halves of the average must
      // cover one span, or the "average duration" is an average of nothing.
      stats.review.msTotal += Date.now() - t0;
      if (result.ok) stats.review.ok += 1;
      else stats.review.err += 1;
      const REPORT_CAP = 200_000;
      const truncated = result.report.length > REPORT_CAP;
      const parsed = result.findings || { parsed: false, count: 0, findings: [] };
      return {
        ok: result.ok,
        report: truncated
          ? `${result.report.slice(0, REPORT_CAP)}\n\n[truncated by dsh-connect-atomcode: ${
              result.report.length - REPORT_CAP
            } more characters]`
          : result.report,
        truncated,
        findings_parsed: parsed.parsed === true,
        findings_count: typeof parsed.count === 'number' ? parsed.count : 0,
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        error: result.error,
        exit_code: result.exitCode ?? -1,
        duration_ms: result.durationMs,
      };
    },
  });

  return disposeReview;
}