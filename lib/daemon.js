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

/** @returns {string} the base URL for one daemon port. */
export function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/**
 * Read the daemon auth token the official binary writes on startup.
 * `~/.atomcode/daemon-<port>.json` → `{ pid, port, token }`.
 * @param {number} port
 * @param {string} [home] - override for tests; defaults to os.homedir().
 * @returns {string} the bearer token ('' when the daemon runs with --no-auth or the file is absent).
 */
export function readToken(port, home = homedir()) {
  try {
    const text = readFileSync(join(home, '.atomcode', `daemon-${port}.json`), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.token === 'string' ? parsed.token : '';
  } catch {
    return '';
  }
}

/**
 * GET /health — is a daemon already listening?
 * @param {number} port
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
export async function health(port = DEFAULT_PORT, signal) {
  try {
    const res = await fetch(`${baseUrl(port)}/health`, { method: 'GET', signal });
    if (!res.ok) return false;
    const body = await res.json();
    return body && body.service === 'atomcode-daemon';
  } catch {
    return false;
  }
}

/**
 * GET /models — the AtomCode-configured model catalogue.
 * @param {number} port
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{provider:string, model:string, is_default:boolean, provider_type:string, effort_levels?:string[]}>>}
 */
export async function listModels(port = DEFAULT_PORT, signal) {
  const token = readToken(port);
  const res = await fetch(`${baseUrl(port)}/models`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok) throw new Error(`atomcode /models -> HTTP ${res.status}`);
  return res.json();
}

/**
 * Parse one SSE `data:` line into an event object, or `undefined` for
 * keep-alive comments / malformed payloads.
 * @param {string} line
 */
export function parseSseLine(line) {
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
export async function* streamChat(opts) {
  const port = opts.port ?? DEFAULT_PORT;
  const token = readToken(port);
  const payload = { message: opts.message, approval_mode: opts.approvalMode ?? 'bypass' };
  if (opts.provider) payload.provider = opts.provider;
  if (opts.sessionId) payload.session_id = opts.sessionId;
  if (opts.workingDir) payload.working_dir = opts.workingDir;

  const headers = { 'Content-Type': 'application/json', ...(opts.extraHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Combine caller cancellation with an optional per-request timeout and
  // optional round-level fuse (count tool_start events).
  const ctrl = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : undefined;
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  let toolStartCount = 0;
  const roundFuse = opts.maxRounds > 0 ? opts.maxRounds : 0;

  let res;
  try {
    res = await fetch(`${baseUrl(port)}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`atomcode /chat -> HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawTerminal = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const event = parseSseLine(line);
        if (!event) continue;
        if (event.type === 'done' || event.type === 'error') sawTerminal = true;
        // Round-level fuse: abort the stream when the agent exceeds max rounds.
        if (event.type === 'tool_start') toolStartCount += 1;
        if (roundFuse > 0 && toolStartCount > roundFuse) {
          ctrl.abort();
          yield event;
          throw new Error(`atomcode agent exceeded ${roundFuse} tool rounds (round fuse)`);
        }
        yield event;
      }
    }
    if (!sawTerminal) throw new Error('atomcode SSE stream ended before done');
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
 *   provider:string, error:string}>}
 */
export async function askChat(opts) {
  const events = [];
  let streamError = '';
  try {
    for await (const ev of streamChat(opts)) events.push(ev);
  } catch (error) {
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
  for (const ev of events) {
    if (ev.type === 'text') reply += String(ev.content || '');
    else if (ev.type === 'session_assigned' && typeof ev.session_id === 'string') sessionId = ev.session_id;
    else if (ev.type === 'runtime_info' && typeof ev.provider === 'string') realProvider = ev.provider;
    else if (ev.type === 'tool_start') {
      usedTools.push({ name: String(ev.name || 'tool'), success: false });
      roundCount += 1;
    } else if (ev.type === 'tool_result' && usedTools.length > 0) usedTools[usedTools.length - 1].success = ev.success === true;
    else if (ev.type === 'tokens') tokens = Number(ev.total) || 0;
    else if (ev.type === 'done') done = ev;
    else if (ev.type === 'error' && error === '') error = String(ev.message || 'atomcode turn error');
  }
  const ok = done !== null;
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
    error: ok ? '' : error || 'chat stream ended before done',
  };
}

/**
 * Detect the AtomCode binary name for the current platform. The official
 * signed binary must be on PATH (or overridden via config/`ATOMCODE_BIN`).
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function defaultBinary(platform = process.platform) {
  return platform === 'win32' ? 'atomcode.exe' : 'atomcode';
}

/**
 * Spawn the daemon detached (best-effort auto-start). Never throws: a failure
 * to spawn just means the caller must have a daemon running already.
 * @param {{port?:number, binary?:string, workingDir?:string, log?:(msg:string)=>void}} opts
 * @returns {boolean} true if a spawn was attempted.
 */
export async function spawnDaemon(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const bin = opts.binary || process.env.ATOMCODE_BIN || defaultBinary();
  try {
    // Dynamic import so importing this module never pulls in child_process.
    const { spawn } = await import('node:child_process');
    const child = spawn(bin, ['daemon', '--port', String(port), '--no-telemetry'], {
      cwd: opts.workingDir || homedir(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch (error) {
    if (opts.log) opts.log(`atomcode daemon spawn failed: ${String(error)}`);
    return false;
  }
}
