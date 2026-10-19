/**
 * The one tool this plugin registers — `atomcode_ask`, a full autonomous daemon
 * turn with side-conversation continuity. A one-click review is the
 * `/atomcode-review` slash command, which shares the runner below but lives in
 * `command.ts`; the model-facing `atomcode_review` tool was retired so the model
 * always reaches for the one general tool.
 *
 * IT GOES THROUGH THE DAEMON. The retired review tool used to spawn the
 * `atomcodex review` CLI, which returned a structured `findings[]` document but
 * demanded a direct-provider endpoint (in practice a local sidecar on 8899) — so
 * it went dark whenever the sidecar was down while `atomcode_ask` kept working,
 * and it gave one plugin two provider namespaces. The user's call was one
 * channel: a review became a prompt plus a normal turn over the daemon. The
 * cost, stated plainly: no structured findings, so a review reports prose.
 *
 * Extracted from `src/host/index.ts` (apply() split). The tool owns its
 * description string end to end, which is why the `providerHint` string is built
 * HERE next to the `register()` call that consumes it — a description separated
 * by hundreds of lines from the code it describes goes quietly stale with
 * nothing failing.
 *
 * @module dsh-connect-atomcode/host/tools
 */
import { askChat, TOOLS_CAP } from './daemon.ts';
import { beginInFlight, describeDaemonDown, endInFlight } from './stats.ts';
import type { LiveTurn } from './stats.ts';
import {
  HOST_TOOL_TIMEOUT_MS,
  HOST_TOOL_TIMEOUT_SECS,
  OUTPUT_CAP,
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
 * Cut prose down to `cap` characters, with the cut MARKED in the text itself.
 *
 * One helper for both tools because there used to be two hand-written markers
 * (`ask AtomCode to write the full text to a file` on one path, a bare
 * `N more characters` on the other) and two caps that happened to be equal —
 * i.e. one convention per copy. A truncation convention that varies by call site
 * is a truncation the reader learns to miss; the `remedy` is the only part that
 * legitimately differs, because what to do about a clipped reply is not what to
 * do about a clipped report.
 *
 * The marker goes INSIDE the returned text on purpose. A silent clip reads to the
 * model as a complete answer, which is how a half-copied document becomes a
 * confidently wrong summary — the same reason `tools_truncated` and
 * `findings_parsed` exist as their own fields rather than as omissions.
 *
 * @param {string} text - the prose to bound.
 * @param {number} cap - the character budget for it.
 * @param {{remedy?: string}} [options] - what the reader should do about it.
 * @returns {{text: string, cut: boolean}} the text to show, and whether it was cut.
 */
function capProse(text: string, cap: number, options: { remedy?: string } = {}) {
  const body = typeof text === 'string' ? text : '';
  if (body.length <= cap) return { text: body, cut: false };
  const omitted = body.length - cap;
  const remedy = options.remedy ? `; ${options.remedy}` : '';
  return {
    text: `${body.slice(0, cap)}\n\n[truncated by dsh-connect-atomcode: ${omitted} more characters${remedy}]`,
    cut: true,
  };
}

/**
 * The DSH host accepts a CLOSED JSON-Schema subset at `tools.register` —
 * `type` must be a single type string. Array-typed unions
 * (`type: ['boolean', 'null']`) are rejected there with a `JsonSchemaError`,
 * which makes `apply()` throw and the plugin NEVER ACTIVATES: no tools, no
 * web routes, and the detail-page card shows HTTP 404 on its stats fetch
 * (the 2026-10 incident, reproduced on host 0.2.0-rc.1 against the dev tree
 * that had gained null-carrying union types).
 *
 * Those unions are not decorative: `null` is a LEGITIMATE value on these
 * fields (an unattributable parallel tool batch, an unattended turn, an
 * unreported daemon stat), and the host validates the RETURNED value against
 * `output.schema` at call time — so collapsing a union to one member type
 * makes every legitimate null throw a `ToolOutputError`. The sanctioned
 * escape is an annotation-only node: the validator explicitly accepts a
 * schema without a `type` key ("the standard unconstrained-JSON form"), and
 * each affected field's `description` already carries its "null = ..."
 * semantics. So this sanitizer drops exactly the array-typed `type` keys and
 * nothing else: `required`/`items`/`additionalProperties` survive, which
 * keeps null values expressible and the fields' nullability documented.
 *
 * @param {any} node - a registered output schema (or one of its subnodes).
 * @returns {any} a host-acceptable copy with no array-typed `type` keys.
 */
function hostSubsetSchema(node: any): any {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => hostSubsetSchema(item));
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && Array.isArray(value)) continue; // union → annotation-only node
    out[key] = hostSubsetSchema(value);
  }
  return out;
}

/**
 * The shared ask runner — the ONE body behind every entry point into a bridged
 * AtomCode turn: the model-facing `atomcode_ask` tool and the `/atomcode-review`
 * slash command. (The HTTP `/api/atomcode-bridge/ask` route that once posted
 * here is GONE — 方针 A, 2026-10-18 — so this runner has two callers, not a
 * route among them.)
 *
 * Everything that decides WHICH turn runs lives here, so the entry points
 * cannot drift apart: the repo ladder, the 红线 8 refusal, the provider ladder,
 * the timeout and round fuses, the daemon-readiness gate, the in-flight
 * bookkeeping and the stats accounting are identical for a tool call and for a
 * command. A refusal one entry point makes is the refusal the others make.
 *
 * `exec` is the per-call context the host hands a tool. A tool call gets
 * `{ signal, cwd }`; the `/atomcode-review` command has no host tool-call
 * context, so it passes only the composer's `signal` (or `{}` with none) and
 * the working_dir comes from the session header. Only `signal` is read (for
 * cancellation) and `cwd` through `hostSessionCwd` (for the ladder), so an
 * empty object is a complete, valid argument.
 *
 * The return shape is both the tool's `output` schema and the command's outcome
 * object — one shape, not two adapters, so a field added here reaches the model
 * and the human. Errors are reported as `ok: false` + `error`, never thrown:
 * every caller reads `ok`, and none needs an exception to tell the user what
 * went wrong.
 */
export async function runAsk(
  args: any,
  exec: any,
  { config, runtime }: { config: HostConfig; runtime: Runtime },
) {
  const { port, autoStart, defaultReasoningEffort } = config;
  const { stats, sessions, resolveProvider, ensureDaemon } = runtime;
  // The runner's own clock, started before every branch that can return —
  // including the refusal below. It used to start after the ladder, so the
  // one early return that is NOT a failure (a refused call) had no elapsed
  // time to report and the panel's average would have been built from a
  // subset of the calls that reached it.
  const t0 = Date.now();
  // Resolved ONCE, before any failure path, so a refused/failed turn still
  // reports which model the bridge was asking for (`empty()` below) instead
  // of a misleading 'default'. Ladder: argument > panel pick > patch field >
  // AtomCode's own default (send nothing).
  const askProvider = resolveProvider(args.provider).name;
  // Repo ladder: explicit arg > host session cwd (ready-to-use hook) > panel
  // pick (panel-settings.json) > plugin config `working_dir` > (nothing ->
  // the daemon's own home fallback).
  //
  // Declared BEFORE `empty()` on purpose: the closure reads `workDir`, and if
  // this `const` came later the only thing keeping it out of the temporal dead
  // zone would be the order in which `empty()` happens to be CALLED today.
  // That is invisible to `tsc` and one refactor away from a ReferenceError.
  const panelWorkDir = runtime.resolveDefaultWorkingDir();
  const workDir =
    typeof args.working_dir === 'string' && args.working_dir.trim() !== ''
      ? args.working_dir
      : hostSessionCwd(exec) ?? panelWorkDir;
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
    // null, not 0: a refused turn never reached the daemon, so the daemon
    // reported nothing. "It said zero" and "it never got to say anything"
    // are different facts, and the render compares this field against our
    // own count.
    daemon_tool_calls: null,
    daemon_rounds: null,
    // Wall-clock ms from `t0` (the runner's entry) to THIS return. Reported on
    // every early return too: the gate that starts the clock before the refusal
    // is exactly so a refused/unreachable turn can say how long it spent failing,
    // instead of the panel's average silently excluding them.
    elapsed_ms: Date.now() - t0,
    error,
  });
  // 红线 8 — NO resolvable directory means AtomCode's own tools run unattended
  // inside whatever cwd the daemon was launched in, which in the default
  // launch is the user's home.
  //
  // This gate used to fire only on that danger PLUS `approval_mode: bypass`
  // — the assumption being that a non-bypass turn had a human approving
  // tools, so an unnamed directory was tolerable there. The 2026-10-17
  // probe (scripts/probes/approval-mode.mjs) disproved it for the headless
  // daemon: it auto-approves ask-class tools in EVERY mode
  // (`[headless] auto-approved`), so the danger is mode-independent and the
  // gate no longer names a mode — switching `approval_mode` can no longer
  // silently disarm it.
  //
  // This case used to be handled by a sentence in the RENDER — which runs
  // after the turn. A warning that arrives with the results cannot prevent
  // the thing it warns about, and review is the BOUNDED path (one-shot,
  // no tool loop) while ask is the one with a full autonomous tool loop.
  // The weaker guard sat on the more dangerous tool. Now both refuse.
  //
  // Refused rather than silently redirected to a sandbox directory: a model
  // that named no directory may still mean "read the files under my home",
  // and quietly running it somewhere else trades a visible risk for an
  // invisible wrong answer. The caller knows where the work belongs; the
  // message names all three ways forward, so the retry is one call away.
  // Nothing has been spawned, written, or resolved into a session key yet.
  if (!workDir && args.allow_unattended !== true) {
    stats.ask.calls += 1;
    stats.ask.err += 1;
    stats.ask.msTotal += Date.now() - t0;
    // A refused turn is still a call (and a failure) — persist it, or the
    // panel's 累计 undercounts the times the tool refused to run.
    runtime.persistAskUsage();
    return empty(
      'atomcode_ask 拒绝了本回合：取不到 working_dir，而 daemon 无人值守自动放行（[headless] auto-approved——对任何 approval_mode 都成立），AtomCode 的工具会跑在它自己的 cwd（通常是用户 home）里——' +
        '这正是本插件对取不到目录的调用一直直接拒绝的那个情况（红线 8）。三种走法：' +
        '① 传 working_dir 指定本回合的目录；② 在插件配置 working_dir 里设一个默认目录；' +
        '③ 本回合确实只做通用问答、不涉及任何目录时，显式传 allow_unattended=true 表示知情同意。',
    );
  }
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

  stats.ask.calls += 1;
  if (!(await ensureDaemon(exec?.signal))) {
    stats.ask.err += 1;
    stats.ask.msTotal += Date.now() - t0;
    runtime.persistAskUsage();
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
  const maxRounds = resolveMaxRounds(args.max_rounds, runtime.resolveAskMaxRounds());
  // Live progress for the panel's 5s poll — the whole point being that an
  // ask turn runs for minutes and used to be a black box for every one of
  // them. `startedAt` is taken BEFORE the request goes out rather than on
  // the first event, so a turn that spends 40s before its first token still
  // shows an honest age instead of appearing to start late.
  const live: LiveTurn = {
    startedAt: Date.now(),
    workingDir: workDir || null,
    provider: askProvider || 'default',
    rounds: 0,
    completed: 0,
    chars: 0,
    sessionId: '',
    lastTool: '',
    tokens: 0,
  };
  beginInFlight(stats, live);
  let result: Awaited<ReturnType<typeof askChat>>;
  try {
    result = await askChat({
      message: String(args.message || ''),
      port,
      approvalMode: runtime.resolveApprovalMode(),
      timeoutMs,
      // Forwarded unconditionally, 0 included: dropping it here would be the
      // same "0 is not honoured" bug one layer down.
      maxRounds,
      ...(sessionId ? { sessionId } : {}),
      ...(askProvider ? { provider: askProvider } : {}),
      ...(workDir ? { workingDir: workDir } : {}),
      // Per-turn reasoning-effort override: call arg wins, then the config
      // default, then nothing (daemon's own persistent value applies).
      ...((args.reasoning_effort || defaultReasoningEffort)
        ? { reasoningEffort: args.reasoning_effort || defaultReasoningEffort }
        : {}),
      ...(exec?.signal ? { signal: exec.signal } : {}),
      onProgress: (progress) => Object.assign(live, progress),
    });
  } finally {
    // Retire THIS turn and hand the slot to whatever is still running —
    // see `endInFlight`. Neither ordering of two overlapping asks may leave
    // the panel claiming nothing is in flight while a turn executes; the
    // row describes the newest turn that is still alive.
    endInFlight(stats, live);
  }
  stats.ask.msTotal += Date.now() - t0;
  if (result.ok) {
    stats.ask.ok += 1;
    if (Number.isFinite(result.tokens)) stats.ask.tokens += result.tokens;
  } else {
    stats.ask.err += 1;
  }
  // EVERY outcome persists, not just the two early refusals above. The success
  // path used to update the in-memory counters and stop there, so `usage.json`
  // was never written: the durable store existed and its only caller was the
  // failure path. The panel's 「累计」 was therefore a per-process curiosity —
  // it read 0 after every reload of a bridge that had run plenty of turns, which
  // reads as "this card is broken" rather than "this counter was never saved".
  runtime.persistAskUsage();
  // Accumulate protocol drift for the panel, on EVERY turn rather than only
  // successful ones: drift is a fact about the wire, not a property of the
  // reply, and a failed turn that still named an unknown type is exactly the
  // evidence a later diagnosis needs. Union, never replace — see the bag.
  for (const unknownType of result.unknownTypes) {
    if (!stats.protocolUnknownTypes.includes(unknownType)) stats.protocolUnknownTypes.push(unknownType);
  }
  if (result.ok && result.sessionId) sessions.set(sessionKey, result.sessionId);
  // Truncation is MARKED, never silent: a silently clipped reply reads
  // to the model like a complete answer, which is how a half-copied review
  // becomes a confidently wrong summary. Budget and marker both come from the
  // shared pair (OUTPUT_CAP / capProse) so the two entry points that end up in
  // this function — `atomcode_ask` and the `/atomcode-review` command — cannot
  // drift into two conventions.
  const capped = capProse(result.reply, OUTPUT_CAP, {
    remedy: 'ask AtomCode to write the full text to a file and read that instead',
  });
  const reply = capped.text;
  const truncated = capped.cut;
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
    // The daemon's own counts, passed through untouched so the render can
    // compare them against ours. Null means it did not report them — the
    // comparison is then impossible rather than favourable.
    daemon_tool_calls: result.daemonToolCalls,
    daemon_rounds: result.daemonRounds,
    error: reportedError,
    // The model's cue for "this turn was slow — split the task / switch strategy":
    // it knows rounds, not wall time, until this field is here. Same `t0`, so a
    // turn and its refusal are measured on one clock (see `empty()` above).
    elapsed_ms: Date.now() - t0,
  };
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
  const { defaultProvider, askMaxRounds, approvalMode } = config;


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
      '何时主动调用：当用户想听 AtomCode 的意见（"帮我问 AtomCode"、"让 AtomCode 看看"）时必须用；' +
      '需要一段自主代码调查/改写时也用（它有完整工具循环、能跑 shell、能读写文件，比你逐个读文件再总结更适合"让一个 agent 跑一圈"的任务）。' +
      '第二意见是本工具的主用途：你自己写完代码再自查，读的是同一份上下文、容易顺着原来的思路放过问题；AtomCode 是另一套上下文独立读一遍，能看出你没看出来的东西。' +
      '但它一次是完整自主回合、烧的是用户自己的 CodingPlan 配额（不是无限量），所以"要不要主动跑一轮"是有代价的判断，别把它当默认动作：' +
      '改动涉及核心逻辑、并发/安全/数据正确性、或用户对结果表达了不确定——这些值得主动跑一轮；' +
      '样式微调、改文案、用户没要求复查的小改动——不主动跑，等用户点名。拿不准时先问一句，比默默消耗配额好。' +
      '把一条消息转发给本机 AtomCode（终端 AI 编程助手，官方二进制）的 daemon 执行一个完整自主回合（它自带工具循环，approval_mode 默认 bypass 无人值守放行），取回整轮回复。' +
      '用于"帮我问 AtomCode / 让 AtomCode 处理 / 侧边咨询 / 独立复查"场景；拿到结果后把 reply 转达给用户，并说清哪些判断是 AtomCode 下的、哪些还需你自己核实。' +
      '调用时请给出 working_dir（要处理的仓库/目录）——它同时是它的读写边界和侧边对话的会话键；缺省优先级：参数 > 宿主会话 cwd > 插件配置 working_dir，' +
      '三者都取不到时本工具直接拒绝该回合（不放行无人值守的工具调用跑在用户 home 里），除非显式传 allow_unattended=true。' +
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
        working_dir: { type: 'string', description: '回合的工作目录，同时是侧边对话的会话键。缺省优先级：调用参数 > 宿主会话 cwd（宿主尚未暴露该字段，暴露后自动填入）> 面板选择 > 插件配置 working_dir。以上都没有时本工具**拒绝**该回合（见 allow_unattended）——让 AtomCode 的工具在 daemon 自己的 cwd（通常是用户 home）里无人值守跑，是本插件一直直接拒绝的那个情况' },
        allow_unattended: { type: 'boolean', description: '可选，默认 false。上面三条都取不到目录时才需要它：那种情况下本工具默认拒绝（红线 8——无人值守的工具调用跑在一个没人指定的目录里；当前 daemon 对任何 approval_mode 都是无人值守自动放行，所以这道门与 mode 无关）。确实只做通用问答、不需要任何目录时，显式传 true 表示知情同意；能给出目录就优先给 working_dir，别用它绕开' },
        timeout_secs: { type: 'number', description: '可选：整回合超时秒数，默认 1800；上限 1800（本工具向宿主声明的超时上限就是 30 分钟），超过按 1800 计——代码里钳制，不是"传了更大的值但悄悄不生效"' },
        max_rounds: { type: 'number', description: '可选：工具调用次数上限（按 daemon SSE 的 tool_start 事件计数；一个 agent 回合可能并行发起多次工具调用，故事件数 ≥ agent 轮数——把它当轮数理解，会在更少的 agent 轮数上就熔断）。默认取插件配置，当前 ' + askMaxRounds + '；上限 1000，超过按 1000 计（钳制在代码里，inflate 关不掉熔断）。传 0 关掉本端熔断，交回 daemon 自带治理）。超限时本端中止等待并返回错误，同时向 daemon 发 POST /chat/stop 请求停掉该回合（以 daemon 应答为准；回合刚开始还没拿到 session_id 时无法请求，错误文本会说明这一种情况）' },
        reasoning_effort: { type: 'string', description: '可选：本回合的推理力度（per-turn override，不改 daemon 持久值）。支持的档位取决于当前模型（见 GET /models 的 effort_levels），常见值 "low"/"medium"/"high"/"xhigh"。留空 = 用 daemon 当前的持久值（或模型默认）。传了不支持的档位 daemon 会拒绝并说明哪个档位可用' },
      },
      required: ['message'],
    },
    output: {
      schema: hostSubsetSchema({
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
              '本回合实际使用的工作目录（同时是侧边对话的会话键）。null = 本回合没有指定任何目录，跑在 daemon 自己的 cwd 下（通常是用户 home）——' +
              '而当前 daemon 对任何 approval_mode 都是无人值守自动放行（bypass 只是出厂默认），所以这个组合现在只可能由调用方显式传 allow_unattended=true 产生（否则本工具在开跑前就拒绝了）。要指定仓库就显式传 working_dir',
          },
          provider: { type: 'string' },
          providerReported: { type: 'boolean', description: 'provider 是否来自 daemon SSE 的 runtime_info（true = 远端实测值；false = daemon 未报，回显本插件请求值、未经远端证实——daemon 升级后若不再发 runtime_info，每回合都会带 false 并标注）' },
          protocol_unknown_types: {
            type: 'array',
            description: '本回合 daemon 发来、本插件不认识的事件类型（空数组 = 词汇表未变，是常态；恒有本字段，故「没观察到漂移」与「没检查漂移」不会混淆）。非空说明 AtomCode 可能已升级或改了事件名。注意：轮数熔断靠计数 tool_start 生效，若被改名的正是这类被计数的事件，熔断会少计甚至完全不触发——此时 round_count 不可信。要和 daemon 自报的次数对照就看 daemon_tool_calls',
            items: { type: 'string' },
          },
          daemon_tool_calls: {
            type: ['number', 'null'],
            description: 'daemon 在 done 里自报的本回合工具调用次数（done.tool_calls，或 done.stats.tool_calls）。null = 它没报（旧 daemon 或极端的协议漂移）——「它说 0 次」和「它什么都没说」不是同一件事。与 round_count 对照即知本端熔断这一轮有没有真在工作：两者对不上而 round_count 更小，说明被计数的事件已改名，熔断本轮等于没生效',
          },
          daemon_rounds: {
            type: ['number', 'null'],
            description: 'daemon 自报的 agent 轮数（done.stats.rounds），null = 没报。与 daemon_tool_calls 不是同一个数字：一个 agent 轮可以并行发起多次工具调用，所以轮数 ≤ 工具调用数。用于判断漂移的是哪一边',
          },
          elapsed_ms: {
            type: 'number',
            description: '本回合墙钟毫秒数（从调用进入到返回，含被拒绝/daemon 不可达的失败回合——那些也计时，故与成功回合同一把尺）。模型据此判断"这回合是不是太慢、要不要拆小任务或换策略"；它能看到轮数，但在此之前看不到时间',
          },
          error: { type: 'string' },
        },
        required: ['ok', 'reply', 'session_id', 'continued', 'truncated', 'tokens', 'tool_calls', 'tools', 'tools_truncated', 'stop_reason', 'working_dir', 'provider', 'providerReported', 'protocol_unknown_types', 'daemon_tool_calls', 'daemon_rounds', 'elapsed_ms', 'error'],
        additionalProperties: false,
      }),
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
          // The one thing a turn run without a working_dir has to keep saying:
          // where its tools actually ran. `null` means the daemon's own cwd (the
          // user's home, in the default launch), auto-approved: the headless
          // daemon auto-approves ask-class tools in EVERY approval_mode
          // (`[headless] auto-approved` — 2026-10-17 probe; bypass is just the
          // shipped default), so this line holds in any mode.
          //
          // This used to be the ONLY guard on that case, which made it a
          // guard in name only: a render runs AFTER the turn, so the sentence
          // describing "tools ran unattended in a directory nobody named"
          // arrived with the results of exactly that. review refuses the case
          // outright (红线 8); ask now refuses it too, in `execute()`, before
          // the daemon is touched — so this branch is reachable only for a turn
          // the caller explicitly waved through (`allow_unattended: true`), and
          // it reads as the acknowledgement it is rather than as a discovery.
          // Every turn still carries `working_dir=` in the meta line below.
          if (value.working_dir === null || value.working_dir === undefined) {
            lines.push(
              '[注意：本回合未指定 working_dir——调用方已显式 allow_unattended=true 放行。工具在 daemon 自己的 cwd 下执行（通常是用户 home），' +
                '且无人值守自动放行（当前 daemon 对任何 approval_mode 都成立，本回合 approval_mode=' + approvalMode + '）。要限定目录请显式传 working_dir 或配置插件的 working_dir]',
              '',
            );
          }
          // The drift shape NEITHER error path can report, because the turn
          // SUCCEEDED and carried content — so it reads as a clean turn unless
          // said out loud here. It is worse than a plain caveat: the round fuse
          // that bounds this turn counts `tool_start`, so a renamed tool event
          // leaves the fuse silently disarmed while every surface still reports
          // success.
          //
          // This used to stop at "IF the renamed event is one of the counted
          // ones, the fuse is disarmed" — a hedge, because the plugin had no way
          // to know. It does now: the daemon reports its OWN tool-call count in
          // `done`, so the two counts can be compared and the sentence can
          // become a verdict. Three outcomes, each stated as what it is:
          //   - daemon counted MORE than we did → the fuse did not fire this
          //     turn. Not "might have": it did not.
          //   - the two agree → the renamed event is NOT one of the counted
          //     ones, so this turn's fuse worked. The drift is still worth
          //     knowing (the next rename may hit a counted type), which is why
          //     the line stays.
          //   - the daemon reported nothing → back to the hedge, naming which
          //     branch is unknowable instead of pretending certainty.
          if (Array.isArray(value.protocol_unknown_types) && value.protocol_unknown_types.length > 0) {
            const ourCount = value.round_count || 0;
            const theirCount = value.daemon_tool_calls;
            const knows = typeof theirCount === 'number';
            const disagrees = knows && theirCount !== ourCount;
            lines.push(
              `[注意：本回合 daemon 发来本插件不认识的事件类型（${value.protocol_unknown_types.join(', ')}），` +
                'AtomCode 可能已升级或改了事件名。本端轮数熔断靠计数 tool_start 生效——' +
                (disagrees
                  ? `而 daemon 自报 ${theirCount} 次工具调用、本端只数到 ${ourCount} 次：两次计数对不上，` +
                    (theirCount > ourCount
                      ? '**本回合的熔断确实没有生效**（不是"可能失效"）。'
                      : '本端多算了——熔断比应有的更早触发，同样需要核对。')
                  : knows
                    ? `daemon 自报 ${theirCount} 次工具调用、与本端计数一致：被改名的不在这类被计数的事件里，本回合的熔断是准的。` +
                      '但下一次改名未必还避开它。'
                    : ourCount === 0
                      ? '而本回合轮数为 0，且 daemon 没有自报次数：若被改名的是这类事件，熔断此刻已是失效状态。'
                      : '若被改名的是这类事件，熔断会少计，下面的 round_count 偏小。daemon 没有自报次数，无法当场判定。') +
                '墙钟超时仍是有效的兜底（且触发时会向 daemon 发 /chat/stop）；也可调小 max_rounds 或人工盯防本轮]',
              '',
            );
          }
          const meta = [];
          meta.push(`session_id=${value.session_id}`);
          meta.push(`tokens=${value.tokens}`);
          if (value.round_count != null && value.round_count > 0) meta.push(`rounds=${value.round_count}`);
          meta.push(`tool_calls=${value.tool_calls}`);
          // Only when the daemon actually said something: printing
          // `daemon_tool_calls=null` in a one-line meta block invites reading it
          // as zero, which is the one thing this field must not be confused with.
          if (typeof value.daemon_tool_calls === 'number') {
            meta.push(`daemon_tool_calls=${value.daemon_tool_calls}`);
          }
          // Wall time, guarded the same way `daemon_tool_calls` is: printed only
          // when it is a number, so a caller (or an older fixture) that omits it
          // does not read `elapsed_ms=undefined` as a value. This is the line that
          // actually reaches the model — the raw field alone is invisible to it,
          // since the model reads this render, not the JSON.
          if (typeof value.elapsed_ms === 'number') {
            meta.push(`elapsed_ms=${value.elapsed_ms}`);
          }
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
    // The tool call is a one-line alias for the shared runner; the
    // `/atomcode-review` command calls the SAME body, so a model call and a
    // human command cannot disagree about which directory runs unattended.
    execute: (args: any, exec: any) => runAsk(args, exec, { config, runtime }),
  });

  return disposeAsk;
}
