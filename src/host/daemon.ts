/**
 * AtomCode daemon HTTP client — pure, host-free, cross-platform.
 *
 * This module talks only to the *local* AtomCode daemon over loopback HTTP.
 * It carries no DSH/Cordis dependency so it can be exercised directly against
 * a running daemon (see test/daemon-live.test.mjs) and reused by the Cordis
 * plugin in `index.ts`/`index.js`.
 *
 * Ported from `dsh-atomcode-bridge` (Yinyuan34513, MIT, 2026-08-15). The
 * original shelled out to `curl`/`base64` and hardcoded `/home/elaina`; this
 * rewrite uses global `fetch` (Node 22+, per sibling plugins' engines field)
 * and resolves every path from `os.homedir()` so it works on Windows and
 * Linux alike.
 *
 * Verified against AtomCode 5.2.2 daemon SSE vocabulary:
 *   data: {"type":"runtime_info","provider":..,"model":..}
 *   data: {"type":"session_assigned","session_id":..}
 *   data: {"type":"reasoning","content":..}   -> reasoning-delta
 *   data: {"type":"text","content":..}         -> text-delta
 *   data: {"type":"tool_start","name":..} / {"type":"tool_result","success":..}
 *   data: {"type":"tokens","prompt":..,"completion":..,"total":..}
 *   data: {"type":"done","tokens":..,"tool_calls":..,"session_id":..,"stop_reason":..,"stats":{..}}
 *   data: {"type":"error","message":..}
 *
 * @module dsh-connect-atomcode/daemon
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default loopback port for the bridge daemon (kept distinct from the TUI's 13456). */
export const DEFAULT_PORT = 13459;

/**
 * How many tool records a single turn may carry back to the model. A runaway
 * turn can emit hundreds; an unbounded array would crowd the reply out of the
 * tool result. The cap is a transport limit, NOT a statement about the turn —
 * which is why the return value marks the cut (`toolsTruncated`) instead of
 * letting a clipped array read as the whole story. `toolCalls` stays the true
 * count (it comes from the daemon's `done`, or from the uncapped list), so the
 * two together let the caller see "30 of 47 shown".
 */
export const TOOLS_CAP = 30;

/**
 * The SSE event vocabulary this client understands (verified against AtomCode
 * 5.2.2/5.2.3 daemon). Anything else on the wire is counted as drift; see
 * `streamChat`'s end-of-stream branch and `askChat`.
 *
 * Keeping it a module constant (not a local) is what lets `streamChat` report
 * unknown types from inside the reader loop — where the failure is actually
 * detected — instead of only in the aggregator, which never sees them.
 */
const KNOWN_SSE_TYPES = new Set([
  'runtime_info',
  'session_assigned',
  'reasoning',
  'text',
  'tool_start',
  'tool_result',
  'tokens',
  'done',
  'error',
]);

/** @returns {string} the base URL for one daemon port. */
export function baseUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}

/**
 * Read the daemon auth token the official binary writes on startup.
 * `~/.atomcode/daemon-<port>.json` → `{ pid, port, token }`.
 * @param {number} port
 * @param {string} [home] - override for tests; defaults to os.homedir().
 * @returns {string} the bearer token ('' when the daemon runs with --no-auth or the file is absent).
 */
export function readToken(port: number, home: string = homedir()) {
  try {
    const text = readFileSync(join(home, '.atomcode', `daemon-${port}.json`), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.token === 'string' ? parsed.token : '';
  } catch {
    return '';
  }
}

/**
 * The headers every daemon request carries: the auth token the binary wrote at
 * startup, merged over whatever the call site adds.
 *
 * `readToken` answers '' for a daemon started with `--no-auth` (or one whose
 * file is not there yet), and in that case NO Authorization header is sent at
 * all — an empty one is worse than none, because the daemon rejects it instead
 * of serving the request anonymously. That rule used to be repeated at every
 * call site; it now has one home.
 *
 * @param port - the daemon port, to find `daemon-<port>.json`.
 * @param base - headers this request adds on top (usually Content-Type).
 * @returns the header object to hand to `fetch`.
 */
function bearerHeaders(port: number, base: Record<string, string> = {}): Record<string, string> {
  const token = readToken(port);
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

/**
 * The message out of a caught value, for the places that must report why a
 * request failed rather than the fact of it.
 *
 * `catch` hands out `unknown`, so this is the ONE narrowing: an Error (or
 * anything with a string `message`) reports that message, everything else is
 * stringified. Repeating the ternary per call site is how one of them
 * eventually reports `[object Object]`.
 *
 * @param error - whatever was caught.
 * @returns the message to show the user.
 */
function errText(error: any): string {
  return String(error && error.message ? error.message : error);
}

/**
 * A fingerprint of the daemon CURRENTLY serving `port`, for judging whether a
 * remembered `session_id` was issued by this daemon or by one that has since
 * exited.
 *
 * The 24h TTL in `sessions.ts` cannot answer that: the dominant way a side
 * conversation dies is a daemon restart or an idle exit (~30min), which leaves
 * ids behind that no live session answers to, and a wall-clock window does not
 * notice. The daemon writes `{ pid, port, token }` at startup, so `port:pid`
 * plus the token — hashed, so no secret is copied into the state file —
 * identifies the process that issued an id. A restart changes the pid AND the
 * token, so the fingerprint moves even if the OS recycles the pid.
 *
 * The token is hashed rather than stored because `sessions.json` is a state
 * file, not a credential store; pid alone was the first draft and is weaker
 * than it looks (a just-freed pid is the one most likely to be reused).
 *
 * @param {number} port
 * @param {string} [home] - override for tests; defaults to os.homedir().
 * @returns {string|null} the fingerprint, or null when it cannot be read —
 *   "cannot judge" is a real answer (a `--no-auth` daemon writes no file), and
 *   callers must treat it as unknown rather than as "different".
 */
export function readDaemonIdentity(port: number, home: string = homedir()): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(home, '.atomcode', `daemon-${port}.json`), 'utf8'));
    if (!parsed || !Number.isInteger(parsed.pid)) return null;
    const token = typeof parsed.token === 'string' ? parsed.token : '';
    return createHash('sha256').update(`${port}:${parsed.pid}:${token}`).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Why a probe came back `up: false`. Named one at a time rather than collapsed
 * into the flag, because every caller that reports an outage used to say the
 * same thing — "未监听" — for all of these, and that is true of exactly one.
 *
 * A port occupied by something that is not AtomCode, a daemon that accepted the
 * connection and then stopped answering, and a port nobody is listening on are
 * three different problems with three different fixes. A message that names the
 * wrong one sends the reader to the wrong place — and the failure it describes
 * is precisely the one where a wrong guess costs the most time.
 *
 * `unreachable` is the deliberate catch-all: when the cause is not a shape we
 * can name with confidence, say that much and no more.
 */
export type HealthFailure =
  | '' // serving
  | 'refused' // nothing accepted the connection
  | 'timeout' // the probe's own budget elapsed before an answer
  | 'http-error' // something answered, with a non-2xx status
  | 'unreadable' // something answered 2xx, with a body we could not parse
  | 'not-atomcode' // a service answered, but it is not the AtomCode daemon
  | 'unreachable'; // the fetch failed for a reason we do not classify

/**
 * Classify a rejected `fetch`. Only shapes we can name with confidence get a
 * name. undici wraps the operating-system cause one level down in
 * `error.cause`, so a bare `error.code` is usually empty — check both.
 */
function probeFailure(error: any): HealthFailure {
  const code = (error && error.cause && error.cause.code) || (error && error.code) || '';
  if (code === 'ECONNREFUSED') return 'refused';
  const name = error && error.name;
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_ABORTED' ||
    code === 'ABORT_ERR'
  ) {
    // The production probe always passes `AbortSignal.timeout(...)`, so an abort
    // here means its budget elapsed. (A caller-supplied cancellation signal is
    // handled by the caller, which knows it aborted on purpose.)
    return 'timeout';
  }
  return 'unreachable';
}

/**
 * GET /health with the daemon version, so the plugin can surface which
 * protocol generation it is talking to instead of guessing.
 *
 * `reason` names WHY the probe failed — see `HealthFailure`. It is `''` when up.
 *
 * @param {number} port
 * @param {AbortSignal} [signal]
 * @returns {Promise<{up:boolean, version:string, reason:HealthFailure}>}
 */
export async function healthInfo(port: number = DEFAULT_PORT, signal?: AbortSignal) {
  let res: Response;
  try {
    // `signal ?? null` rather than `signal`: RequestInit's `signal` is declared
    // as an ABSENT-when-unset field, so handing it an explicit `undefined` is
    // not the same type as leaving it out (exactOptionalPropertyTypes). `null`
    // is what the DOM type accepts for "no signal", and it aborts nothing.
    res = await fetch(`${baseUrl(port)}/health`, { method: 'GET', signal: signal ?? null });
  } catch (error: any) {
    return { up: false, version: '', reason: probeFailure(error) };
  }
  if (!res.ok) return { up: false, version: '', reason: 'http-error' as HealthFailure };
  let body: any;
  try {
    body = await res.json();
  } catch {
    // A 2xx whose body is not JSON: something is serving this port, it just is
    // not the daemon. Saying "未监听" here would send the reader hunting for a
    // stopped process while the port is held by something else.
    return { up: false, version: '', reason: 'unreadable' as HealthFailure };
  }
  if (!body || body.service !== 'atomcode-daemon') {
    return { up: false, version: '', reason: 'not-atomcode' as HealthFailure };
  }
  return { up: true, version: typeof body.version === 'string' ? body.version : '', reason: '' as HealthFailure };
}

/**
 * GET /health — is a daemon already listening?
 * @param {number} port
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
export async function health(port: number = DEFAULT_PORT, signal?: AbortSignal) {
  return (await healthInfo(port, signal)).up;
}

/**
 * GET /models — the AtomCode-configured model catalogue.
 * @param {number} port
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{provider:string, model:string, is_default:boolean, provider_type:string, effort_applicable?:boolean, reasoning_effort?:string|null, effort_levels?:string[]}>>}
 */
export async function listModels(port: number = DEFAULT_PORT, signal?: AbortSignal) {
  const res = await fetch(`${baseUrl(port)}/models`, {
    method: 'GET',
    headers: bearerHeaders(port),
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`atomcode /models -> HTTP ${res.status}`);
  return res.json();
}

/**
 * GET /codingplan/usage/{summary,daily} — the CodingPlan quota/usage in structured
 * form (see `codingplan.ts` for the payloads and why this source is preferred).
 *
 * One function for both paths because they are the same call: same auth, same
 * JSON, same failure mode. The caller decides what a failure MEANS (the quota
 * path falls back to the status text; the trend path publishes a named reason).
 *
 * @param {number} port
 * @param {'/codingplan/usage/summary'|'/codingplan/usage/daily'} path
 * @param {AbortSignal} [signal]
 */
export async function codingPlanUsage(
  port: number = DEFAULT_PORT,
  path: '/codingplan/usage/summary' | '/codingplan/usage/daily' = '/codingplan/usage/summary',
  signal?: AbortSignal,
) {
  const res = await fetch(`${baseUrl(port)}${path}`, {
    method: 'GET',
    headers: bearerHeaders(port),
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`atomcode ${path} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * One session entry from `GET /sessions`.
 *
 * The daemon keeps a per-project_hash list of sessions; each entry carries the
 * fields the SPA uses to render its session picker. The plugin does not filter
 * by working_dir here — the panel does that (a session is useful only when its
 * working_dir matches the current session's, so the filter belongs on the
 * render side where the working_dir is known).
 */
export interface SessionEntry {
  project_hash: string;
  id: string;
  name: string;
  working_dir: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  file_size: number;
}

/**
 * GET /sessions — the daemon's session index (all projects, not filtered).
 * @param {number} port
 * @param {AbortSignal} [signal]
 * @returns {Promise<SessionEntry[]>}
 */
export async function listSessions(port: number = DEFAULT_PORT, signal?: AbortSignal): Promise<SessionEntry[]> {
  const res = await fetch(`${baseUrl(port)}/sessions`, {
    method: 'GET',
    headers: bearerHeaders(port),
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`atomcode /sessions -> HTTP ${res.status}`);
  return res.json();
}

/** The options bag `runCommand` accepts (see its own `@param` block for the contract). */
export interface RunCommandOptions {
  port?: number;
  command?: string;
  workingDir?: string;
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * POST /command — run one TUI slash command headlessly and return its payload.
 *
 * This is how the bridge reaches data the daemon exposes no dedicated endpoint
 * for. It is the ONLY source of CodingPlan quota: `/command {"command":
 * "status"}` returns a `text` field carrying the plan and rolling-window usage,
 * while the JSON API itself (`/health`, `/models`, `/providers`, `/config`) and
 * the SSE `done.stats` carry none. Note the command name takes NO leading slash
 * (the slash form is rejected as an unknown command), and the endpoint requires
 * `working_dir` for every command.
 *
 * The daemon reports command failures as HTTP 200 with `{kind:"error",message}`,
 * so the HTTP status alone is not the success signal.
 *
 * @param {{port?:number, command:string, workingDir?:string, sessionId?:string,
 *   timeoutMs?:number, signal?:AbortSignal}} opts
 * @returns {Promise<{ok:boolean, kind:string, message:string, text:string, data:object|null}>}
 */
export async function runCommand(opts: RunCommandOptions = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const headers = bearerHeaders(port, { 'Content-Type': 'application/json' });
  const payload: Record<string, unknown> = { command: String(opts.command ?? '') };
  if (opts.workingDir) payload.working_dir = opts.workingDir;
  if (opts.sessionId) payload.session_id = opts.sessionId;

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  try {
    const res = await fetch(`${baseUrl(port)}/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      return { ok: false, kind: 'http', message: `atomcode /command -> HTTP ${res.status}`, text: '', data: null };
    }
    const data = await res.json();
    if (data && data.kind === 'error') {
      return {
        ok: false,
        kind: 'error',
        message: String(data.message || 'atomcode command failed'),
        text: '',
        data,
      };
    }
    return {
      ok: true,
      kind: data && typeof data.kind === 'string' ? data.kind : 'ok',
      message: '',
      text: data && typeof data.text === 'string' ? data.text : '',
      data,
    };
  } catch (error: any) {
    return {
      ok: false,
      kind: 'transport',
      message: errText(error),
      text: '',
      data: null,
    };
  }
}

/**
 * Parse one SSE `data:` line into an event object, or `undefined` for
 * keep-alive comments / malformed payloads.
 * @param {string} line
 */
export function parseSseLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** The options bag `streamChat` accepts (see its own `@param` block for the contract). */
export interface StreamChatOptions {
  message: string;
  port?: number;
  provider?: string;
  sessionId?: string;
  workingDir?: string;
  approvalMode?: string;
  /** Per-turn reasoning effort override (e.g. "low", "medium", "high", "xhigh"). */
  reasoningEffort?: string;
  timeoutMs?: number;
  maxRounds?: number;
  /** Budget for the `POST /chat/stop` sent after a turn dies early (tests only). */
  stopTimeoutMs?: number;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Called as the turn advances, with a reading of where it has got to.
   *
   * The aggregate `askChat` returns is, by construction, only available once the
   * turn is OVER — which left a turn that runs for minutes with nothing to show
   * anywhere in between. This callback is the one place those in-between states
   * exist. It must not throw (a broken observer must not be able to kill a live
   * turn); `askChat` guards the call.
   */
  onProgress?: (progress: TurnProgress) => void;
}

/**
 * A reading of a turn's progress, taken while it is still running.
 *
 * Deliberately counts and names rather than carries content: it feeds a 5s
 * panel poll, and shipping the partial reply past the callback would invite a
 * second, worse copy of the deliverable to be rendered somewhere.
 */
export interface TurnProgress {
  /** `tool_start` events seen so far (≥ agent rounds: parallel calls each count). */
  rounds: number;
  /** Tool calls with a result already seen. `rounds - completed` are in flight. */
  completed: number;
  /** Reply characters accumulated so far. */
  chars: number;
  /** The session id, once the daemon has assigned one; `''` before that. */
  sessionId: string;
  /** Name of the most recent tool call, `''` before the first one. */
  lastTool: string;
  /** Tokens reported so far (the daemon may only report them at the end). */
  tokens: number;
}

/**
 * POST /chat and yield each SSE event as it arrives.
 *
 * The request body is the AtomCode `message` (DSH conversation is serialized by
 * the caller) plus `approval_mode` (defaults to `bypass` for unattended runs),
 * and optional `provider` (route to one AtomCode model), `session_id`
 * (continue an existing turn) and `working_dir`.
 *
 * @param {{message:string, port?:number, provider?:string, sessionId?:string,
 *   workingDir?:string, approvalMode?:string, timeoutMs?:number,
 *   maxRounds?:number, extraHeaders?:Record<string,string>, signal?:AbortSignal}} opts
 * @returns {AsyncGenerator<object, void, unknown>}
 */
export async function* streamChat(opts: StreamChatOptions) {
  const port = opts.port ?? DEFAULT_PORT;
  const payload: Record<string, unknown> = { message: opts.message, approval_mode: opts.approvalMode ?? 'bypass' };
  if (opts.provider) payload.provider = opts.provider;
  if (opts.sessionId) payload.session_id = opts.sessionId;
  if (opts.workingDir) payload.working_dir = opts.workingDir;
  if (opts.reasoningEffort) payload.reasoning_effort = opts.reasoningEffort;

  const headers = bearerHeaders(port, { 'Content-Type': 'application/json', ...(opts.extraHeaders || {}) });

  // Combine caller cancellation with an optional per-request timeout and
  // optional round-level fuse (count tool_start events). Every abort records
  // WHY, so the failure the caller sees names the cause instead of the raw
  // "This operation was aborted" DOMException.
  const ctrl = new AbortController();
  let abortReason = '';
  const abortWith = (reason: string) => {
    if (!abortReason) abortReason = reason;
    ctrl.abort();
  };
  const timer = opts.timeoutMs
    ? setTimeout(() => abortWith(`timeout after ${opts.timeoutMs}ms`), opts.timeoutMs)
    : undefined;
  const onAbort = () => abortWith('canceled by caller');
  if (opts.signal) {
    if (opts.signal.aborted) abortWith('canceled by caller');
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  let toolStartCount = 0;
  // `maxRounds` may be undefined when the caller sets no fuse; treat undefined
  // (and any non-positive value) as "no fuse" (0). Use an explicit null check
  // instead of a non-null assertion so an unset value is handled, not lied to.
  const roundFuse = opts.maxRounds != null && opts.maxRounds > 0 ? opts.maxRounds : 0;

  // Every abort this function can raise stops OUR side of the wire:
  // `ctrl.abort()` closes the fetch. What happens to the daemon's turn is then
  // `askChat`'s job — it posts `/chat/stop` with the session id once the stream
  // dies early (see `stopChat`). Before that stop request existed, the
  // sentence below was the whole story: the daemon kept running the turn it had
  // accepted — tool calls, tokens and CodingPlan quota that nobody was waiting
  // for any more. The caveat is still needed, because a stop request can fail,
  // but it no longer describes an unavoidable outcome, so it no longer claims
  // one. One sentence, appended to every reason, from one function — a caveat
  // repeated per path is a caveat one path will lose.
  const LOCAL_ABORT_CAVEAT = '（本端已停止等待）';

  /** The one abort sentence — so no abort path can ship its own wording. */
  const abortError = () => new Error(`atomcode turn aborted: ${abortReason}${LOCAL_ABORT_CAVEAT}`);

  /** Re-throw an abort-flavoured transport error as an actionable message. */
  const describeAbort = (error: unknown) => {
    if (abortReason) return abortError();
    return error;
  };

  let res;
  try {
    try {
      res = await fetch(`${baseUrl(port)}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (error) {
      throw describeAbort(error);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`atomcode /chat -> HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawTerminal = false;
    // Event types observed on the wire but absent from the vocabulary this
    // client understands (see KNOWN_SSE_TYPES above). Counted here so the
    // "ended before done" failure can name them; see the branch at the bottom.
    const unknownTypeNames = new Set<string>();
    // Whether ANY event in this vocabulary was recognized. This is what keeps
    // an ADDITIVE unknown type from being read as a protocol change: a stream
    // carrying real `text`/`tool_start`/`tokens` events that merely got cut
    // short (idle kill, network blip, timeout) is a TRUNCATED TURN, not a
    // renamed protocol — and telling the user to upgrade dsh-connect-atomcode
    // over a network hiccup sends them the wrong way.
    let sawRecognizable = false;
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw describeAbort(error);
      }
      const { done, value } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const event = parseSseLine(line);
        if (!event) continue;
        if (event.type === 'done' || event.type === 'error') sawTerminal = true;
        // Round-level fuse: stop yielding once the agent exceeds max rounds.
        if (event.type === 'tool_start') toolStartCount += 1;
        if (roundFuse > 0 && toolStartCount > roundFuse) {
          abortWith(`agent exceeded ${roundFuse} tool rounds (round fuse)`);
          yield event;
          throw abortError();
        }
        if (typeof event.type === 'string' && !KNOWN_SSE_TYPES.has(event.type)) {
          unknownTypeNames.add(event.type);
        } else {
          sawRecognizable = true;
        }
        yield event;
      }
    }
    if (!sawTerminal) {
      // Prefer the drift diagnosis over the generic one ONLY when the whole
      // vocabulary was unrecognized: "ended before done" points at the stream,
      // a wholly foreign vocabulary points at the PROTOCOL, and the two lead
      // the user to different fixes. The `!sawRecognizable` gate is load-bearing
      // — without it a recognized-but-truncated turn carrying one additive
      // unknown event would be misdiagnosed as "upgrade the plugin".
      if (unknownTypeNames.size > 0 && !sawRecognizable) {
        throw new Error(
          `unrecognized daemon SSE vocabulary (types: ${[...unknownTypeNames].sort().join(', ')}) — ` +
            'the daemon may have changed its /chat protocol; upgrade dsh-connect-atomcode (or check the daemon version)',
        );
      }
      throw new Error('atomcode SSE stream ended before done');
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    try {
      ctrl.abort();
    } catch {
      /* noop */
    }
  }
}

/**
 * The daemon's own tool-call count for a turn, or null when it did not report
 * one.
 *
 * Two spellings exist in the same frame (`done.tool_calls`, and the same number
 * again inside `done.stats`) and the measured frames carry both — the nested one
 * is the fallback rather than the source, because the top-level field is the one
 * the vocabulary documents and the peer of `done.tokens`.
 *
 * Null, never 0 and never our own count: this exists to be compared against the
 * plugin's count, so any default derived from our side would make the two agree
 * by construction and destroy the only comparison that matters.
 *
 * @param {any} done - the terminal event, or null.
 * @returns {number|null}
 */
function reportedToolCalls(done: any): number | null {
  if (!done) return null;
  if (typeof done.tool_calls === 'number') return done.tool_calls;
  const stats = done.stats && typeof done.stats === 'object' ? done.stats : null;
  return stats && typeof stats.tool_calls === 'number' ? stats.tool_calls : null;
}

/**
 * `done.stats.rounds` — the daemon's own agent-round count, or null.
 *
 * A different number from the one above on purpose: several tool calls can be
 * launched in one agent round, so `rounds <= tool_calls`. The plugin's fuse
 * counts EVENTS (`tool_start`), i.e. the tool-call number; this one is reported
 * beside it so a human reading a mismatch can tell which of the two drifted.
 *
 * @param {any} done - the terminal event, or null.
 * @returns {number|null}
 */
function reportedRounds(done: any): number | null {
  if (!done) return null;
  const stats = done.stats && typeof done.stats === 'object' ? done.stats : null;
  return stats && typeof stats.rounds === 'number' ? stats.rounds : null;
}

/**
 * Run one full /chat turn and collect it into a single result (the
 * `atomcode_ask` tool path — blocking, returns the whole reply).
 * @param {Parameters<typeof streamChat>[0]} opts
 * @returns {Promise<{ok:boolean, reply:string, sessionId:string, tokens:number,
 *   toolCalls:number, tools:Array<{name:string, success:boolean}>, stopReason:string,
 *   provider:string, providerReported:boolean, unknownTypes:string[],
 *   error:string}>} `ok:true` means a
 *   terminal `done` carrying deliverable content (or a legitimately empty turn
 *   with no unknown types); `error` may be non-empty ALONGSIDE ok:true — a
 *   mid-turn error event that a later `done` does not cancel. Callers must
 *   surface it, not branch on it. When the stream itself died early, `error`
 *   ends with what the `/chat/stop` attempt achieved (`appendStopOutcome`) —
 *   a turn that was cut is not silently left running. `providerReported` is true only when
 *   `provider` came from the daemon's own runtime_info; false means the
 *   daemon never reported one and `provider` is the requested value echoed
 *   back — surfaced per-turn so a protocol drift that drops runtime_info is
 *   visible instead of silently masquerading as "the model that ran".
 */
export async function askChat(opts: StreamChatOptions) {
  let reply = '';
  // Annotated rather than left to inference: `report()` reads this from a
  // closure, and a closure reference pins the array's type at the point of the
  // read — before the first `push`, so the element type could not be inferred.
  const usedTools: Array<{ name: string; success: boolean | null }> = [];
  let done = null;
  let tokens = 0;
  let sessionId = '';
  let realProvider = undefined;
  let providerReported = false;
  let roundCount = 0;
  /**
   * Tool calls started but not yet answered, in start order, plus whether the
   * CURRENT batch ever had more than one outstanding call.
   *
   * The daemon may run several tool calls in parallel, and `tool_result` does
   * not carry the name or id of the call it answers — so while a batch is
   * concurrent there is no way to know which `tool_start` a given result
   * belongs to. The batch flag is what turns "unknown" into an explicit null
   * instead of a fabricated false; see the `tool_result` branch.
   */
  const outstanding: Array<{ name: string; success: boolean | null }> = [];
  let batchConcurrent = false;
  // The aggregation gate for drift: a turn that produced NO recognizable
  // signal at all (no text, no tool, no done/error, no session, no tokens)
  // while carrying unknown types is a protocol change, not an empty turn.
  // `streamChat` already throws on the missing `done`; this covers the case
  // where it saw a terminal event of an unknown name.
  const unknownTypes = new Set<string>();
  let streamError = '';
  /**
   * Aggregated AS the stream arrives, not collected into an array first.
   *
   * The array version held every event of the turn in memory until the stream
   * ended, with no cap: a long autonomous turn emits thousands of `text`
   * deltas, and this module caps everything else it takes from the wire (reply
   * prose at OUTPUT_CAP in tools.ts, `tools` at TOOLS_CAP) — this was the one
   * unbounded buffer left, and the one with no marker to say it had grown.
   * Streaming also means the turn's cost tracks its content rather than its
   * event count.
   *
   * The two error channels are kept APART rather than sharing one variable,
   * because their precedence is real: an aborted/truncated stream (thrown by
   * `streamChat`) outranks an `error` event the daemon sent *inside* a stream
   * that then died. The array version got that ordering by initialising
   * `error` to the stream error first and only letting an event fill an empty
   * one; collapsing them into a single variable here would silently invert the
   * precedence, so they are merged once, below, in the same order.
   */
  let eventError = '';
  // Publish a reading after every event. The observer is called through a guard
  // rather than directly: it crosses into the caller's code (which updates the
  // panel's live state), and an exception there would abort a perfectly healthy
  // turn from inside the aggregation loop — the reporter breaking the thing it
  // reports on. Same rule the session store's `onError` observer follows.
  const report = () => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress({
        rounds: roundCount,
        // `outstanding` holds the calls started but not yet answered, so this is
        // the count of calls that DID get a result — not a second tally that
        // could drift from `rounds`.
        completed: usedTools.length - outstanding.length,
        chars: reply.length,
        sessionId,
        lastTool: usedTools.length > 0 ? usedTools[usedTools.length - 1]!.name : '',
        tokens,
      });
    } catch {
      // Swallowed on purpose — see above.
    }
  };
  try {
    for await (const ev of streamChat(opts)) {
      if (ev.type === 'text') reply += String(ev.content || '');
      else if (ev.type === 'session_assigned' && typeof ev.session_id === 'string') sessionId = ev.session_id;
      else if (ev.type === 'runtime_info' && typeof ev.provider === 'string' && ev.provider !== '') {
        realProvider = ev.provider;
        providerReported = true;
      }
      else if (ev.type === 'tool_start') {
        const record: { name: string; success: boolean | null } = { name: String(ev.name || 'tool'), success: false };
        usedTools.push(record);
        // Queue the call as OUTSTANDING. The result event carries no name or id
        // (see the vocabulary above), so the only thing tying a `tool_result`
        // back to a call is ordering — and ordering is only unambiguous while
        // exactly one call is outstanding.
        outstanding.push(record);
        if (outstanding.length > 1) batchConcurrent = true;
        roundCount += 1;
      } else if (ev.type === 'tool_result') {
        const record = outstanding.shift();
        if (record) {
          // Serial turns (one call outstanding) can be attributed, so the
          // success flag is a fact. A CONCURRENT batch — several calls started
          // before any result arrived — cannot be: `tool_result` has no name,
          // so there is nothing to say which of them this result belongs to.
          // Writing it to "the last one started" (what this did before) is not
          // a guess, it is a wrong fact: every other call in the batch stays
          // `success: false` forever while the render tells the model they all
          // failed. Null says "unknown" and stays truthful.
          record.success = batchConcurrent ? null : ev.success === true;
        }
        // Batch boundary: once every outstanding call has its result, the next
        // `tool_start` opens a fresh batch (and serial Turns stay attributed).
        if (outstanding.length === 0) batchConcurrent = false;
      }
      else if (ev.type === 'tokens') tokens = Number(ev.total) || 0;
      else if (ev.type === 'done') done = ev;
      else if (ev.type === 'error' && eventError === '') eventError = String(ev.message || 'atomcode turn error');
      else if (ev && typeof ev.type === 'string' && !KNOWN_SSE_TYPES.has(ev.type)) unknownTypes.add(ev.type);
      // After the branch, so the reading describes the event that just landed —
      // one call site instead of one per event type, which is how a new event
      // type ends up not counted anywhere.
      report();
    }
  } catch (error: any) {
    streamError = errText(error);
  }
  // A stream that ended early leaves the daemon's turn running: abort closes
  // OUR side of the wire and nothing else. Now that the session id is known —
  // read HERE rather than from the options, because it usually only arrives
  // mid-stream as `session_assigned` — ask the daemon to stop it. See
  // `stopChat` for what that does and does not promise.
  //
  // Only a stream-level failure gets this. A turn that reached `done` is over
  // and must not be touched, and an `error` event the daemon sent INSIDE a
  // stream that then finished is not ours to cancel.
  if (streamError !== '') {
    const target = sessionId || (typeof opts.sessionId === 'string' ? opts.sessionId : '');
    // The stop options are OPTIONAL fields, so an unset port or timeout must
    // leave the key out rather than be written as `undefined` (the two are
    // different types under exactOptionalPropertyTypes, and `stopChat` reads
    // the absence as "use the default").
    streamError = appendStopOutcome(
      streamError,
      await stopChat({
        ...(typeof opts.port === 'number' ? { port: opts.port } : {}),
        sessionId: target,
        ...(typeof opts.stopTimeoutMs === 'number' ? { timeoutMs: opts.stopTimeoutMs } : {}),
      }),
    );
  }
  let error = streamError || eventError;
  let ok = done !== null;
  // Protocol-drift diagnostics — drift comes in two shapes and the earlier gate
  // only caught one of them (red line 3: a silent failure must become a NAMED
  // diagnostic). TOTAL drift: the stream spoke none of the vocabulary, `done`
  // never arrived, streamChat throws and the bare "ended before done" would
  // hide the cause — gate 1 replaces it with the observed type names. HALF
  // drift (the one that was silent): `done` keeps its name but the BODY was
  // renamed — text/tool/tokens gone, so the aggregation had a terminal event
  // and NO deliverable content. A "successful" empty reply is worse than a
  // failure: the model reads "(空回复)" as a real answer and the turn counts
  // as ok. Gate 2 demotes that shape to a hard failure with its own message.
  // Both gates require unknownTypes.size > 0: a genuinely empty turn with an
  // ADDITIVE new event stays a success (that is growth, not breakage).
  const sawAnyRecognizable =
    reply !== '' || usedTools.length > 0 || done !== null || error !== '' || sessionId !== '' || tokens > 0;
  if (!ok && !sawAnyRecognizable && unknownTypes.size > 0) {
    error =
      `unrecognized daemon SSE vocabulary (types: ${[...unknownTypes].sort().join(', ')}) — ` +
      'the daemon may have changed its /chat protocol; upgrade dsh-connect-atomcode (or check the daemon version).';
  }
  if (ok && reply.trim() === '' && usedTools.length === 0 && unknownTypes.size > 0) {
    ok = false;
    const drift =
      `done received but the turn carried no recognizable content (unknown types: ` +
      `${[...unknownTypes].sort().join(', ')}) — the daemon may have renamed its payload ` +
      'vocabulary; upgrade dsh-connect-atomcode (or check the daemon version).';
    error = error === '' ? drift : `${drift} (observed turn error: ${error})`;
  }
  return {
    ok,
    reply: reply.trim(),
    sessionId: done && typeof done.session_id === 'string' ? done.session_id : sessionId,
    tokens: done && typeof done.tokens === 'number' ? done.tokens : tokens,
    toolCalls: done && typeof done.tool_calls === 'number' ? done.tool_calls : usedTools.length,
    /**
     * The daemon's OWN tool-call count for this turn (`done.tool_calls`, falling
     * back to `done.stats.tool_calls`), or null when it reported neither.
     *
     * Deliberately NOT defaulted to `usedTools.length` the way `toolCalls` above
     * is: the whole point of this field is to be an INDEPENDENT second count, so
     * defaulting it to ours would make the two agree by construction — the one
     * comparison that matters (did the round fuse see what the daemon saw?)
     * would always answer "yes". `null` is "the daemon did not say", which is a
     * different fact from "it said 0".
     */
    daemonToolCalls: reportedToolCalls(done),
    /**
     * `done.stats.rounds` — the daemon's own agent-round count (tool calls may
     * be several per round), or null when absent. Reported alongside rather than
     * instead: the two count different things and the plugin's fuse counts
     * EVENTS, which is the tool-call number.
     */
    daemonRounds: reportedRounds(done),
    // Marked, not silent: at exactly TOOLS_CAP records the array is
    // indistinguishable from a complete one, so the cut needs its own flag.
    // (The sibling reply cap does the same thing with `truncated` + an inline
    // marker; two truncations in one return must not follow two conventions.)
    tools: usedTools.slice(0, TOOLS_CAP),
    toolsTruncated: usedTools.length > TOOLS_CAP,
    stopReason: done && typeof done.stop_reason === 'string' ? done.stop_reason : '',
    /** Actual provider name reported by the daemon SSE runtime_info event, or the explicit provider passed in opts, or 'default'. */
    provider: realProvider || opts.provider || 'default',
    /** True only when `provider` above is the daemon's own runtime_info value. */
    providerReported,
    /** Count of tool_start events in this turn (agent rounds). */
    roundCount,
    /**
     * Event types seen on the wire that this client does not recognize, sorted —
     * and ALWAYS present (`[]` when the vocabulary matched) so a caller can
     * never confuse "no drift observed" with "drift not checked".
     *
     * This is the one drift shape the two `error` gates above cannot report:
     * both of them require the turn to have FAILED or produced nothing. A
     * daemon that renames an event while leaving `text`/`done` intact yields a
     * turn that looks like a clean success — and when the renamed event is
     * `tool_start`, `roundCount` stays 0 and the round fuse in `streamChat`
     * can never trip. Red line 3: a fuse that can go blind without a word is
     * worse than no fuse at all, because the caller believes it is armed.
     */
    unknownTypes: [...unknownTypes].sort(),
    // `done` does NOT erase a mid-turn error event (the earlier `ok ? '' : error`
    // did, which turned a partially failed but completed turn into a silent
    // "full success"). A completed turn may therefore carry a non-empty error;
    // the render side shows it as a caveat instead of swallowing it.
    error: error || (ok ? '' : 'chat stream ended before done'),
  };
}

/**
 * Budget for `POST /chat/stop`.
 *
 * Best-effort by construction: the request is sent from inside a turn that has
 * ALREADY failed or been abandoned, so nothing may wait on it for long. 1.5s is
 * a few loopback round trips; a daemon too wedged to answer a stop inside that
 * is a daemon this caller cannot help, and the turn's own timeout has already
 * elapsed anyway.
 */
export const STOP_COMMAND_TIMEOUT_MS = 1_500;

/** The options bag `stopChat` accepts (see its own `@param` block). */
export interface StopChatOptions {
  port?: number;
  sessionId?: string;
  timeoutMs?: number;
}

/** What one stop attempt achieved. `sent:false` means there was nothing to ask. */
export interface StopChatResult {
  ok: boolean;
  sent: boolean;
  message: string;
}

/**
 * Ask the daemon to stop a turn it is still running: `POST /chat/stop`.
 *
 * This is the other half of an abort. `streamChat` can only close ITS side of
 * the wire — the daemon keeps the turn it accepted, burning tool calls and
 * CodingPlan quota that nobody is waiting for. The endpoint that ends it exists
 * and was listed as "unused" in the interface notes until now; it is used here
 * so that "I stopped waiting" and "the turn stopped" stop being the same
 * sentence.
 *
 * CONTRACT (measured against daemon 5.2.3, see scripts/probes/chat-stop.mjs):
 *
 *   - `session_id` is REQUIRED: the body `{}` answers HTTP 422
 *     "missing field `session_id`". There is no way to stop "whatever is
 *     running" — you have to name the session, and a turn cut before
 *     `session_assigned` arrived has no id to name (that case is reported, not
 *     guessed at).
 *   - A 200 does NOT promise the turn was running: an unknown id answers
 *     `{"success":true,"message":"Chat session <id> was not running"}`. So
 *     `ok` means "the daemon accepted and processed the request", and the
 *     message is passed through verbatim rather than paraphrased — a stop that
 *     landed after the turn finished is not a failure, and saying "stopped"
 *     would be the same kind of false comfort as the old caveat.
 *
 * Never throws: it runs on a path where the turn has already failed, and a
 * throw here would replace the real diagnosis with a bookkeeping one.
 *
 * @param {{port?:number, sessionId?:string, timeoutMs?:number}} opts
 * @returns {Promise<StopChatResult>}
 */
export async function stopChat(opts: StopChatOptions = {}): Promise<StopChatResult> {
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
  // Nothing to name. This is a real state, not an error: a turn cut in its
  // first milliseconds never received `session_assigned`.
  if (sessionId === '') {
    return { ok: false, sent: false, message: 'no session id yet — nothing to stop' };
  }
  const port = opts.port ?? DEFAULT_PORT;
  const headers = bearerHeaders(port, { 'Content-Type': 'application/json' });
  try {
    const res = await fetch(`${baseUrl(port)}/chat/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? STOP_COMMAND_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let message = text.slice(0, 200).trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.message === 'string') message = parsed.message;
    } catch {
      /* a non-JSON body still names itself through `text` */
    }
    if (!res.ok) {
      return { ok: false, sent: true, message: `/chat/stop -> HTTP ${res.status} ${message}`.trim() };
    }
    return { ok: true, sent: true, message };
  } catch (error: any) {
    return {
      ok: false,
      sent: true,
      message: errText(error),
    };
  }
}

/**
 * Append what the stop attempt achieved to an already-failed turn's error.
 *
 * Kept pure and exported so the wording is asserted offline: the interesting
 * states (no id yet / daemon answered / request failed) are all reachable
 * without a daemon, and a caveat that only exists inside the catch block is a
 * caveat nobody tests.
 *
 * @param {string} error - the turn's own error message.
 * @param {StopChatResult} stop
 * @returns {string}
 */
export function appendStopOutcome(error: string, stop: StopChatResult): string {
  const base = String(error ?? '');
  if (stop.sent === false) {
    return (
      `${base}（本端已停止等待；该回合还没拿到 session_id，无法请求 daemon 停止，` +
      'daemon 侧可能仍在继续跑并消耗额度与工具调用）'
    );
  }
  if (stop.ok === true) {
    const detail = stop.message ? ` — ${stop.message}` : '';
    return `${base}（已请求 daemon 停止该回合：/chat/stop 已应答${detail}）`;
  }
  return (
    `${base}（已请求 daemon 停止该回合但未成功：${stop.message}；` +
    'daemon 侧可能仍在继续跑并消耗额度与工具调用）'
  );
}

/**
 * POST /live/reasoning_effort — set the persistent reasoning effort for the
 * daemon's active provider.
 *
 * The daemon answers `{"ok":true}` on success, or `{"ok":false,"error":"reasoning_effort
 * not supported by <provider>"}` when the requested level is not in the model's
 * `effort_levels` list. The value persists on the daemon side until the provider
 * is switched or the daemon restarts.
 *
 * @param {{port?:number, effort:string, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function setReasoningEffort(opts: {
  port?: number;
  effort: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; message: string }> {
  const port = opts.port ?? DEFAULT_PORT;
  const headers = bearerHeaders(port, { 'Content-Type': 'application/json' });
  try {
    const res = await fetch(`${baseUrl(port)}/live/reasoning_effort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reasoning_effort: opts.effort }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    const text = await res.text().catch(() => '');
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.ok === false) {
        return { ok: false, message: parsed.error || `HTTP ${res.status}` };
      }
      return { ok: true, message: parsed.message || 'ok' };
    } catch {
      return { ok: res.ok, message: res.ok ? 'ok' : `HTTP ${res.status}` };
    }
  } catch (error: any) {
    return { ok: false, message: errText(error) };
  }
}

/**
 * Detect the AtomCode binary name for the current platform. The official
 * signed binary must be on PATH (or overridden via config/`ATOMCODE_BIN`).
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function defaultBinary(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? 'atomcode.exe' : 'atomcode';
}

/**
 * One spawn attempt, as it happened — reported so the host can put it on the
 * panel instead of leaving it in the process log.
 *
 * `error` is the OS code (`ENOENT` / `EACCES` / …) and `''` when the process
 * actually started. A daemon that starts and then never answers is a DIFFERENT
 * failure, owned by the health poll (`HealthFailure`) — this record only ever
 * answers "did we manage to RUN the thing, and what did we run".
 */
export interface SpawnAttempt {
  /** The executable handed to `spawn()` — the resolved name, or a fallback path. */
  binary: string;
  /** The OS error code, or `''` when the process started. */
  error: string;
  /** True when this was a fallback path rather than the resolved binary. */
  fallback?: boolean;
}

/**
 * The extra directories tried when the resolved binary is not on PATH.
 *
 * macOS-only, and it exists because of one asymmetry: `spawn()` looks the bare
 * name up in `process.env.PATH`, and a DSH host started from Finder/app-bundle
 * inherits launchd's PATH — not the login shell's. `/opt/homebrew/bin` (Apple
 * Silicon) and `/usr/local/bin` (Intel) are then missing even though AtomCode
 * is installed there, so the daemon "cannot be found" on a machine where
 * `atomcode` works in the user's terminal.
 *
 * Empty on Windows: the installer writes a persistent PATH entry, so the
 * "installed but invisible" case does not arise there — and a Windows machine
 * that got AtomCode via `npm -g` is already covered by the PATH the CLI ships.
 *
 * These are candidates, not a search: `pickFallback` existence-checks each one
 * before it is ever spawned, and the primary failure is reported either way.
 *
 * A pure platform table, and exported as one: the caller does the existence
 * check (see `pickFallback`), so a test can pin the table on any machine. An
 * existence check in HERE would make every test of the fallback path
 * machine-dependent — it would pass or fail on whether the developer happens to
 * have AtomCode installed at `/opt/homebrew/bin`.
 */
export function fallbackCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['/opt/homebrew/bin/atomcode', '/usr/local/bin/atomcode'];
  return [];
}

/**
 * The first candidate that really exists on this machine, or `''`.
 *
 * `exists` is injected rather than imported so the selection rule is testable
 * without a macOS box: "first one that exists" and "none of them exist" are the
 * two outcomes, and neither needs the real filesystem to pin.
 */
export function pickFallback(candidates: string[], exists: (path: string) => boolean): string {
  return candidates.find((candidate) => exists(candidate)) || '';
}

/**
 * True when a failed spawn may be retried against `fallbackCandidates`: ONLY
 * the binary this plugin AUTO-DETECTED qualifies.
 *
 * `config.binary` and `ATOMCODE_BIN` are the user NAMING an executable, and
 * quietly running a different one would hide their typo behind a working
 * daemon. The gate used to compare the RESOLVED target with `defaultBinary()`,
 * which re-enabled the fallback whenever the named binary happened to EQUAL the
 * default name (`ATOMCODE_BIN=atomcode`) — i.e. exactly the case the docblock
 * on `spawnDaemon` promises not to retry.
 *
 * `namedBinary` is the user's value as-is (`''` when nothing was named), NOT
 * the resolved target: the resolved target cannot tell "the user named the
 * default name" from "we auto-detected it".
 */
export function mayFallback(namedBinary: string): boolean {
  return namedBinary === '';
}

/** True for the two codes that mean "this executable could not be run at all". */
function isBinaryError(code: string): boolean {
  return code === 'ENOENT' || code === 'EACCES';
}

/** The OS error code of a failed spawn, or `''` when the process started. */
function spawnErrorCode(error: any): string {
  const code = error && (error.code || (error.cause && error.cause.code));
  return typeof code === 'string' ? code : '';
}

/** The options bag `spawnDaemon` accepts (see its own `@param` block for the contract). */
export interface SpawnDaemonOptions {
  port?: number;
  binary?: string;
  workingDir?: string;
  log?: (msg: string) => void;
  /**
   * Called once per spawn ATTEMPT with what was run and how it went. Fires for
   * the primary binary as soon as its outcome is known, and again for a
   * fallback path. The host copies the last record into the stats snapshot —
   * that is what lets the panel name the executable instead of printing
   * "自动探测（PATH）" next to a bare "自动拉起失败".
   */
  onAttempt?: (attempt: SpawnAttempt) => void;
}

/**
 * Spawn the daemon detached (best-effort auto-start).
 *
 * Never throws, and — critically — never lets a spawn failure escape: when the
 * binary is missing/not executable (ENOENT/EACCES) Node reports it
 * ASYNCHRONOUSLY on the child's `error` event, NOT as a throw from `spawn()`.
 * An EventEmitter `error` with no listener is re-thrown as an uncaught
 * exception, which would take down the whole host process — and `auto_start`
 * defaults to true, so "AtomCode not installed but the plugin is mounted" is a
 * realistic path. The listener below is therefore load-bearing, not defensive
 * noise.
 *
 * A failure to find the AUTO-DETECTED binary (`atomcode`) additionally retries
 * the candidates from `fallbackCandidates`, and each attempt's outcome is
 * reported through `onAttempt`. An explicitly configured binary — `config.binary`
 * or `ATOMCODE_BIN`, even when the value equals the default NAME — is never
 * second-guessed: the user said which executable to run, so a failure there is
 * reported rather than papered over with a different one (`mayFallback`).
 *
 * @param {SpawnDaemonOptions} opts
 * @returns {boolean} true if a spawn was attempted.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  // `namedBinary` is what the USER named (`''` when nothing was named) and
  // `bin` is the resolved target. Both are kept because the fallback gate needs
  // to tell "named the default name" from "auto-detected it" — see mayFallback.
  const namedBinary = opts.binary || process.env.ATOMCODE_BIN || '';
  const bin = namedBinary || defaultBinary();
  const report = (error: any) => {
    // `typeof` rather than a truthiness check: a non-function truthy `log`
    // would throw inside the 'error' callback, which is itself uncaught — i.e.
    // the guard would reintroduce the very crash it exists to prevent.
    if (typeof opts.log === 'function') {
      opts.log(`atomcode daemon spawn failed: ${errText(error)}`);
    }
  };
  // Guarded twice over, and both halves are load-bearing. `typeof` for the same
  // reason as `log`: this runs inside the 'error' callback, where a throw is
  // itself the uncaught exception the function exists to prevent. The try/catch
  // is the other half — the reporter is the host's stats writer, and a throw
  // there (a bad getter, a frozen bag) would ALSO escape this callback. Worse,
  // it would be swallowed by the outer `catch` below as if the dynamic import
  // had failed, which then reports a second, invented attempt. A reporter never
  // gets to kill the thing it reports on — same rule as the session store's
  // `onError`.
  const note = (attempt: SpawnAttempt) => {
    if (typeof opts.onAttempt !== 'function') return;
    try {
      opts.onAttempt(attempt);
    } catch {
      // Deliberately silent: `log` already carries the OS-level story, and this
      // channel exists to serve the panel, not to be a second error surface.
    }
  };
  try {
    // Dynamic import so importing this module never pulls in child_process.
    const { spawn } = await import('node:child_process');
    /**
     * Spawn `target` detached and report the OUTCOME, never throwing.
     *
     * The 'error' listener is attached before `unref()`, and both are
     * synchronous — the real invariant is "before the next await/yield", not
     * "before unref()".
     *
     * The outcome comes from the two events Node itself emits for a spawn, and
     * from nothing else: `'spawn'` once the process exists, `'error'` with the
     * OS code when it could not be started. Resolving inline after `spawn()`
     * returns does NOT work, and the failure is silent: measured on Node 24 /
     * win32, a missing binary emits `'error'` AFTER the microtask queue drains
     * (`after-spawn-call, microtask, error-event, nextTick, setImmediate`), so
     * an inline resolve records `''` and the code is lost — a `queueMicrotask`
     * deferral loses the same race. A healthy spawn emits `'spawn'` in that same
     * slot, so waiting costs nothing.
     *
     * `killed` is a dead end: `detached: true` makes the child its own process
     * group leader and `unref()` drops it, so this function has no handle to
     * signal it later.
     */
    const start = (target: string): Promise<string> =>
      new Promise((resolve) => {
        let settled = false;
        const settle = (code: string) => {
          if (settled) return;
          settled = true;
          resolve(code);
        };
        try {
          const child = spawn(target, ['daemon', '--port', String(port), '--no-telemetry'], {
            cwd: opts.workingDir || homedir(),
            detached: true,
            stdio: 'ignore',
          });
          child.on('error', (error: any) => {
            const code = spawnErrorCode(error);
            report(error);
            settle(code);
          });
          child.on('spawn', () => settle(''));
          child.unref();
        } catch (error) {
          report(error);
          settle(spawnErrorCode(error));
        }
      });

    let outcome: SpawnAttempt = { binary: bin, error: await start(bin) };
    note(outcome);
    // Fall back ONLY for the auto-detected name: `config.binary` and
    // `ATOMCODE_BIN` are the user naming an executable, and quietly running a
    // different one would hide their typo behind a working daemon. Gated on what
    // was NAMED, not on the resolved target — see `mayFallback`.
    if (mayFallback(namedBinary) && isBinaryError(outcome.error)) {
      const candidate = pickFallback(fallbackCandidates(process.platform), existsSync);
      if (candidate) {
        outcome = { binary: candidate, error: await start(candidate), fallback: true };
        note(outcome);
      }
    }
    // The boolean means "a spawn was attempted", not "it succeeded" — the
    // health poll is what decides the daemon is up.
    return true;
  } catch (error) {
    // Only reachable when the dynamic import itself fails.
    report(error);
    note({ binary: bin, error: spawnErrorCode(error) });
    return false;
  }
}
