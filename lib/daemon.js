import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

//#region src/host/daemon.ts
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
/** Default loopback port for the bridge daemon (kept distinct from the TUI's 13456). */
const DEFAULT_PORT = 13459;
/**
* The SSE event vocabulary this client understands (verified against AtomCode
* 5.2.2/5.2.3 daemon). Anything else on the wire is counted as drift; see
* `streamChat`'s end-of-stream branch and `askChat`.
*
* Keeping it a module constant (not a local) is what lets `streamChat` report
* unknown types from inside the reader loop — where the failure is actually
* detected — instead of only in the aggregator, which never sees them.
*/
const KNOWN_SSE_TYPES = /* @__PURE__ */ new Set([
	"runtime_info",
	"session_assigned",
	"reasoning",
	"text",
	"tool_start",
	"tool_result",
	"tokens",
	"done",
	"error"
]);
/** @returns {string} the base URL for one daemon port. */
function baseUrl(port) {
	return `http://127.0.0.1:${port}`;
}
/**
* Read the daemon auth token the official binary writes on startup.
* `~/.atomcode/daemon-<port>.json` → `{ pid, port, token }`.
* @param {number} port
* @param {string} [home] - override for tests; defaults to os.homedir().
* @returns {string} the bearer token ('' when the daemon runs with --no-auth or the file is absent).
*/
function readToken(port, home = homedir()) {
	try {
		const text = readFileSync(join(home, ".atomcode", `daemon-${port}.json`), "utf8");
		const parsed = JSON.parse(text);
		return parsed && typeof parsed.token === "string" ? parsed.token : "";
	} catch {
		return "";
	}
}
/**
* GET /health with the daemon version, so the plugin can surface which
* protocol generation it is talking to instead of guessing.
* @param {number} port
* @param {AbortSignal} [signal]
* @returns {Promise<{up:boolean, version:string}>}
*/
async function healthInfo(port = DEFAULT_PORT, signal) {
	try {
		const res = await fetch(`${baseUrl(port)}/health`, {
			method: "GET",
			signal
		});
		if (!res.ok) return {
			up: false,
			version: ""
		};
		const body = await res.json();
		return {
			up: !!(body && body.service === "atomcode-daemon"),
			version: body && typeof body.version === "string" ? body.version : ""
		};
	} catch {
		return {
			up: false,
			version: ""
		};
	}
}
/**
* GET /health — is a daemon already listening?
* @param {number} port
* @param {AbortSignal} [signal]
* @returns {Promise<boolean>}
*/
async function health(port = DEFAULT_PORT, signal) {
	return (await healthInfo(port, signal)).up;
}
/**
* GET /models — the AtomCode-configured model catalogue.
* @param {number} port
* @param {AbortSignal} [signal]
* @returns {Promise<Array<{provider:string, model:string, is_default:boolean, provider_type:string, effort_levels?:string[]}>>}
*/
async function listModels(port = DEFAULT_PORT, signal) {
	const token = readToken(port);
	const res = await fetch(`${baseUrl(port)}/models`, {
		method: "GET",
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		signal
	});
	if (!res.ok) throw new Error(`atomcode /models -> HTTP ${res.status}`);
	return res.json();
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
async function runCommand(opts = {}) {
	const port = opts.port ?? 13459;
	const token = readToken(port);
	const headers = { "Content-Type": "application/json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const payload = { command: String(opts.command ?? "") };
	if (opts.workingDir) payload.working_dir = opts.workingDir;
	if (opts.sessionId) payload.session_id = opts.sessionId;
	const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 15e3);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
	try {
		const res = await fetch(`${baseUrl(port)}/command`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal
		});
		if (!res.ok) return {
			ok: false,
			kind: "http",
			message: `atomcode /command -> HTTP ${res.status}`,
			text: "",
			data: null
		};
		const data = await res.json();
		if (data && data.kind === "error") return {
			ok: false,
			kind: "error",
			message: String(data.message || "atomcode command failed"),
			text: "",
			data
		};
		return {
			ok: true,
			kind: data && typeof data.kind === "string" ? data.kind : "ok",
			message: "",
			text: data && typeof data.text === "string" ? data.text : "",
			data
		};
	} catch (error) {
		return {
			ok: false,
			kind: "transport",
			message: String(error && error.message ? error.message : error),
			text: "",
			data: null
		};
	}
}
/**
* Parse one SSE `data:` line into an event object, or `undefined` for
* keep-alive comments / malformed payloads.
* @param {string} line
*/
function parseSseLine(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return void 0;
	const data = trimmed.slice(5).trim();
	if (!data || data === "[DONE]") return void 0;
	try {
		return JSON.parse(data);
	} catch {
		return;
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
async function* streamChat(opts) {
	const port = opts.port ?? 13459;
	const token = readToken(port);
	const payload = {
		message: opts.message,
		approval_mode: opts.approvalMode ?? "bypass"
	};
	if (opts.provider) payload.provider = opts.provider;
	if (opts.sessionId) payload.session_id = opts.sessionId;
	if (opts.workingDir) payload.working_dir = opts.workingDir;
	const headers = {
		"Content-Type": "application/json",
		...opts.extraHeaders || {}
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const ctrl = new AbortController();
	let abortReason = "";
	const abortWith = (reason) => {
		if (!abortReason) abortReason = reason;
		ctrl.abort();
	};
	const timer = opts.timeoutMs ? setTimeout(() => abortWith(`timeout after ${opts.timeoutMs}ms`), opts.timeoutMs) : void 0;
	const onAbort = () => abortWith("canceled by caller");
	if (opts.signal) {
		if (opts.signal.aborted) abortWith("canceled by caller");
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}
	let toolStartCount = 0;
	const roundFuse = opts.maxRounds > 0 ? opts.maxRounds : 0;
	/** Re-throw an abort-flavoured transport error as an actionable message. */
	const describeAbort = (error) => {
		if (abortReason) return /* @__PURE__ */ new Error(`atomcode turn aborted: ${abortReason}`);
		return error;
	};
	let res;
	try {
		try {
			res = await fetch(`${baseUrl(port)}/chat`, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: ctrl.signal
			});
		} catch (error) {
			throw describeAbort(error);
		}
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`atomcode /chat -> HTTP ${res.status} ${detail.slice(0, 200)}`);
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		let sawTerminal = false;
		const unknownTypeNames = /* @__PURE__ */ new Set();
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
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				const event = parseSseLine(line);
				if (!event) continue;
				if (event.type === "done" || event.type === "error") sawTerminal = true;
				if (event.type === "tool_start") toolStartCount += 1;
				if (roundFuse > 0 && toolStartCount > roundFuse) {
					abortWith(`agent exceeded ${roundFuse} tool rounds (round fuse)`);
					yield event;
					throw new Error(`atomcode turn aborted: ${abortReason}`);
				}
				if (typeof event.type === "string" && !KNOWN_SSE_TYPES.has(event.type)) unknownTypeNames.add(event.type);
				else sawRecognizable = true;
				yield event;
			}
		}
		if (!sawTerminal) {
			if (unknownTypeNames.size > 0 && !sawRecognizable) throw new Error(`unrecognized daemon SSE vocabulary (types: ${[...unknownTypeNames].sort().join(", ")}) — the daemon may have changed its /chat protocol; upgrade dsh-atomcode-bridge (or check the daemon version)`);
			throw new Error("atomcode SSE stream ended before done");
		}
	} finally {
		if (timer) clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
		try {
			ctrl.abort();
		} catch {}
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
async function askChat(opts) {
	const events = [];
	let streamError = "";
	try {
		for await (const ev of streamChat(opts)) events.push(ev);
	} catch (error) {
		streamError = String(error && error.message ? error.message : error);
	}
	let reply = "";
	let error = streamError;
	const usedTools = [];
	let done = null;
	let tokens = 0;
	let sessionId = "";
	let realProvider = void 0;
	let roundCount = 0;
	const unknownTypes = /* @__PURE__ */ new Set();
	for (const ev of events) if (ev.type === "text") reply += String(ev.content || "");
	else if (ev.type === "session_assigned" && typeof ev.session_id === "string") sessionId = ev.session_id;
	else if (ev.type === "runtime_info" && typeof ev.provider === "string") realProvider = ev.provider;
	else if (ev.type === "tool_start") {
		usedTools.push({
			name: String(ev.name || "tool"),
			success: false
		});
		roundCount += 1;
	} else if (ev.type === "tool_result" && usedTools.length > 0) usedTools[usedTools.length - 1].success = ev.success === true;
	else if (ev.type === "tokens") tokens = Number(ev.total) || 0;
	else if (ev.type === "done") done = ev;
	else if (ev.type === "error" && error === "") error = String(ev.message || "atomcode turn error");
	else if (ev && typeof ev.type === "string" && !KNOWN_SSE_TYPES.has(ev.type)) unknownTypes.add(ev.type);
	let ok = done !== null;
	const sawAnyRecognizable = reply !== "" || usedTools.length > 0 || done !== null || error !== "" || sessionId !== "" || tokens > 0;
	if (!ok && !sawAnyRecognizable && unknownTypes.size > 0) error = `unrecognized daemon SSE vocabulary (types: ${[...unknownTypes].sort().join(", ")}) — the daemon may have changed its /chat protocol; upgrade dsh-atomcode-bridge (or check the daemon version).`;
	if (ok && reply.trim() === "" && usedTools.length === 0 && unknownTypes.size > 0) {
		ok = false;
		const drift = `done received but the turn carried no recognizable content (unknown types: ${[...unknownTypes].sort().join(", ")}) — the daemon may have renamed its payload vocabulary; upgrade dsh-atomcode-bridge (or check the daemon version).`;
		error = error === "" ? drift : `${drift} (observed turn error: ${error})`;
	}
	return {
		ok,
		reply: reply.trim(),
		sessionId: done && typeof done.session_id === "string" ? done.session_id : sessionId,
		tokens: done && typeof done.tokens === "number" ? done.tokens : tokens,
		toolCalls: done && typeof done.tool_calls === "number" ? done.tool_calls : usedTools.length,
		tools: usedTools.slice(0, 30),
		stopReason: done && typeof done.stop_reason === "string" ? done.stop_reason : "",
		/** Actual provider name reported by the daemon SSE runtime_info event, or the explicit provider passed in opts, or 'default'. */
		provider: realProvider || opts.provider || "default",
		/** Count of tool_start events in this turn (agent rounds). */
		roundCount,
		error: error || (ok ? "" : "chat stream ended before done")
	};
}
/**
* Detect the AtomCode binary name for the current platform. The official
* signed binary must be on PATH (or overridden via config/`ATOMCODE_BIN`).
* @param {NodeJS.Platform} [platform]
* @returns {string}
*/
function defaultBinary(platform = process.platform) {
	return platform === "win32" ? "atomcode.exe" : "atomcode";
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
async function spawnDaemon(opts = {}) {
	const port = opts.port ?? 13459;
	const bin = opts.binary || process.env.ATOMCODE_BIN || defaultBinary();
	const report = (error) => {
		if (typeof opts.log === "function") opts.log(`atomcode daemon spawn failed: ${String(error && error.message ? error.message : error)}`);
	};
	try {
		const { spawn } = await import("node:child_process");
		const child = spawn(bin, [
			"daemon",
			"--port",
			String(port),
			"--no-telemetry"
		], {
			cwd: opts.workingDir || homedir(),
			detached: true,
			stdio: "ignore"
		});
		child.on("error", report);
		child.unref();
		return true;
	} catch (error) {
		report(error);
		return false;
	}
}

//#endregion
export { DEFAULT_PORT, askChat, baseUrl, defaultBinary, health, healthInfo, listModels, parseSseLine, readToken, runCommand, spawnDaemon, streamChat };