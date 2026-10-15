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
 * @module dsh-atomcode-bridge/daemon
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default loopback port for the bridge daemon (kept distinct from the TUI's 13456). */
export const DEFAULT_PORT = 13459;

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
 * GET /health with the daemon version, so the plugin can surface which
 * protocol generation it is talking to instead of guessing.
 * @param {number} port
 * @param {AbortSignal} [signal]
 * @returns {Promise<{up:boolean, version:string}>}
 */
export async function healthInfo(port: number = DEFAULT_PORT, signal?: AbortSignal) {
  try {
    const res = await fetch(`${baseUrl(port)}/health`, { method: 'GET', signal });
    if (!res.ok) return { up: false, version: '' };
    const body = await res.json();
    return {
      up: !!(body && body.service === 'atomcode-daemon'),
      version: body && typeof body.version === 'string' ? body.version : '',
    };
  } catch {
    return { up: false, version: '' };
  }
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
 * @returns {Promise<Array<{provider:string, model:string, is_default:boolean, provider_type:string, effort_levels?:string[]}>>}
 */
export async function listModels(port: number = DEFAULT_PORT, signal?: AbortSignal) {
  const token = readToken(port);
  const res = await fetch(`${baseUrl(port)}/models`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok) throw new Error(`atomcode /models -> HTTP ${res.status}`);
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
  const token = readToken(port);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
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
      message: String(error && error.message ? error.message : error),
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
  timeoutMs?: number;
  maxRounds?: number;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
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
  const token = readToken(port);
  const payload: Record<string, unknown> = { message: opts.message, approval_mode: opts.approvalMode ?? 'bypass' };
  if (opts.provider) payload.provider = opts.provider;
  if (opts.sessionId) payload.session_id = opts.sessionId;
  if (opts.workingDir) payload.working_dir = opts.workingDir;

  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.extraHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

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
  const roundFuse = opts.maxRounds! > 0 ? opts.maxRounds! : 0;

  /** Re-throw an abort-flavoured transport error as an actionable message. */
  const describeAbort = (error: unknown) => {
    if (abortReason) return new Error(`atomcode turn aborted: ${abortReason}`);
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
    const unknownTypeNames = new Set();
    // Whether ANY event in this vocabulary was recognized. This is what keeps
    // an ADDITIVE unknown type from being read as a protocol change: a stream
    // carrying real `text`/`tool_start`/`tokens` events that merely got cut
    // short (idle kill, network blip, timeout) is a TRUNCATED TURN, not a
    // renamed protocol — and telling the user to upgrade dsh-atomcode-bridge
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
          throw new Error(`atomcode turn aborted: ${abortReason}`);
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
            'the daemon may have changed its /chat protocol; upgrade dsh-atomcode-bridge (or check the daemon version)',
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
 * Run one full /chat turn and collect it into a single result (the
 * `atomcode_ask` tool path — blocking, returns the whole reply).
 * @param {Parameters<typeof streamChat>[0]} opts
 * @returns {Promise<{ok:boolean, reply:string, sessionId:string, tokens:number,
 *   toolCalls:number, tools:Array<{name:string, success:boolean}>, stopReason:string,
 *   provider:string, error:string}>} `ok:true` means a terminal `done` carrying
 *   deliverable content (or a legitimately empty turn with no unknown types);
 *   `error` may be non-empty ALONGSIDE ok:true — a mid-turn error event that a
 *   later `done` does not cancel. Callers must surface it, not branch on it.
 */
export async function askChat(opts: StreamChatOptions) {
  const events = [];
  let streamError = '';
  try {
    for await (const ev of streamChat(opts)) events.push(ev);
  } catch (error: any) {
    streamError = String(error && error.message ? error.message : error);
  }
  let reply = '';
  let error = streamError;
  const usedTools = [];
  let done = null;
  let tokens = 0;
  let sessionId = '';
  let realProvider = undefined;
  let roundCount = 0;
  // The aggregation gate for drift: a turn that produced NO recognizable
  // signal at all (no text, no tool, no done/error, no session, no tokens)
  // while carrying unknown types is a protocol change, not an empty turn.
  // `streamChat` already throws on the missing `done`; this covers the case
  // where it saw a terminal event of an unknown name.
  const unknownTypes = new Set();
  for (const ev of events) {
    if (ev.type === 'text') reply += String(ev.content || '');
    else if (ev.type === 'session_assigned' && typeof ev.session_id === 'string') sessionId = ev.session_id;
    else if (ev.type === 'runtime_info' && typeof ev.provider === 'string') realProvider = ev.provider;
    else if (ev.type === 'tool_start') {
      usedTools.push({ name: String(ev.name || 'tool'), success: false });
      roundCount += 1;
    } else if (ev.type === 'tool_result' && usedTools.length > 0) usedTools[usedTools.length - 1]!.success = ev.success === true;
    else if (ev.type === 'tokens') tokens = Number(ev.total) || 0;
    else if (ev.type === 'done') done = ev;
    else if (ev.type === 'error' && error === '') error = String(ev.message || 'atomcode turn error');
    else if (ev && typeof ev.type === 'string' && !KNOWN_SSE_TYPES.has(ev.type)) unknownTypes.add(ev.type);
  }
  let ok = done !== null;
  // Protocol-drift diagnostics — drift comes in two shapes and the v0.4.0 gate
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
      'the daemon may have changed its /chat protocol; upgrade dsh-atomcode-bridge (or check the daemon version).';
  }
  if (ok && reply.trim() === '' && usedTools.length === 0 && unknownTypes.size > 0) {
    ok = false;
    const drift =
      `done received but the turn carried no recognizable content (unknown types: ` +
      `${[...unknownTypes].sort().join(', ')}) — the daemon may have renamed its payload ` +
      'vocabulary; upgrade dsh-atomcode-bridge (or check the daemon version).';
    error = error === '' ? drift : `${drift} (observed turn error: ${error})`;
  }
  return {
    ok,
    reply: reply.trim(),
    sessionId: done && typeof done.session_id === 'string' ? done.session_id : sessionId,
    tokens: done && typeof done.tokens === 'number' ? done.tokens : tokens,
    toolCalls: done && typeof done.tool_calls === 'number' ? done.tool_calls : usedTools.length,
    tools: usedTools.slice(0, 30),
    stopReason: done && typeof done.stop_reason === 'string' ? done.stop_reason : '',
    /** Actual provider name reported by the daemon SSE runtime_info event, or the explicit provider passed in opts, or 'default'. */
    provider: realProvider || opts.provider || 'default',
    /** Count of tool_start events in this turn (agent rounds). */
    roundCount,
    // `done` does NOT erase a mid-turn error event (v0.4.0's `ok ? '' : error`
    // did, which turned a partially failed but completed turn into a silent
    // "full success"). A completed turn may therefore carry a non-empty error;
    // the render side shows it as a caveat instead of swallowing it.
    error: error || (ok ? '' : 'chat stream ended before done'),
  };
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

/** The options bag `spawnDaemon` accepts (see its own `@param` block for the contract). */
export interface SpawnDaemonOptions {
  port?: number;
  binary?: string;
  workingDir?: string;
  log?: (msg: string) => void;
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
 * @param {{port?:number, binary?:string, workingDir?:string, log?:(msg:string)=>void}} opts
 * @returns {boolean} true if a spawn was attempted.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const bin = opts.binary || process.env.ATOMCODE_BIN || defaultBinary();
  const report = (error: any) => {
    // `typeof` rather than a truthiness check: a non-function truthy `log`
    // would throw inside the 'error' callback, which is itself uncaught — i.e.
    // the guard would reintroduce the very crash it exists to prevent.
    if (typeof opts.log === 'function') {
      opts.log(`atomcode daemon spawn failed: ${String(error && error.message ? error.message : error)}`);
    }
  };
  try {
    // Dynamic import so importing this module never pulls in child_process.
    const { spawn } = await import('node:child_process');
    const child = spawn(bin, ['daemon', '--port', String(port), '--no-telemetry'], {
      cwd: opts.workingDir || homedir(),
      detached: true,
      stdio: 'ignore',
    });
    // The real invariant is "before the next await/yield", NOT "before unref()":
    // the async 'error' event cannot arrive while this synchronous block runs,
    // so attaching here (unref() is also synchronous) is what matters. Moving
    // this below unref() would still be safe; moving it after an await would not.
    // Swallowing the failure is deliberate — the caller learns the truth from
    // the health poll.
    child.on('error', report);
    child.unref();
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}
