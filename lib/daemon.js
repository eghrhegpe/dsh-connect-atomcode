import { createHash } from "node:crypto";
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
* @module dsh-connect-atomcode/daemon
*/
/** Default loopback port for the bridge daemon (kept distinct from the TUI's 13456). */
const DEFAULT_PORT = 13459;
/**
* How many tool records a single turn may carry back to the model. A runaway
* turn can emit hundreds; an unbounded array would crowd the reply out of the
* tool result. The cap is a transport limit, NOT a statement about the turn —
* which is why the return value marks the cut (`toolsTruncated`) instead of
* letting a clipped array read as the whole story. `toolCalls` stays the true
* count (it comes from the daemon's `done`, or from the uncapped list), so the
* two together let the caller see "30 of 47 shown".
*/
const TOOLS_CAP = 30;
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
function bearerHeaders(port, base = {}) {
	const token = readToken(port);
	return token ? {
		...base,
		Authorization: `Bearer ${token}`
	} : base;
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
function errText(error) {
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
function readDaemonIdentity(port, home = homedir()) {
	try {
		const parsed = JSON.parse(readFileSync(join(home, ".atomcode", `daemon-${port}.json`), "utf8"));
		if (!parsed || !Number.isInteger(parsed.pid)) return null;
		const token = typeof parsed.token === "string" ? parsed.token : "";
		return createHash("sha256").update(`${port}:${parsed.pid}:${token}`).digest("hex").slice(0, 16);
	} catch {
		return null;
	}
}
/**
* Classify a rejected `fetch`. Only shapes we can name with confidence get a
* name. undici wraps the operating-system cause one level down in
* `error.cause`, so a bare `error.code` is usually empty — check both.
*/
function probeFailure(error) {
	const code = error && error.cause && error.cause.code || error && error.code || "";
	if (code === "ECONNREFUSED") return "refused";
	const name = error && error.name;
	if (name === "AbortError" || name === "TimeoutError" || code === "UND_ERR_ABORTED" || code === "ABORT_ERR") return "timeout";
	return "unreachable";
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
async function healthInfo(port = DEFAULT_PORT, signal) {
	let res;
	try {
		res = await fetch(`${baseUrl(port)}/health`, {
			method: "GET",
			signal
		});
	} catch (error) {
		return {
			up: false,
			version: "",
			reason: probeFailure(error)
		};
	}
	if (!res.ok) return {
		up: false,
		version: "",
		reason: "http-error"
	};
	let body;
	try {
		body = await res.json();
	} catch {
		return {
			up: false,
			version: "",
			reason: "unreadable"
		};
	}
	if (!body || body.service !== "atomcode-daemon") return {
		up: false,
		version: "",
		reason: "not-atomcode"
	};
	return {
		up: true,
		version: typeof body.version === "string" ? body.version : "",
		reason: ""
	};
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
* @returns {Promise<Array<{provider:string, model:string, is_default:boolean, provider_type:string, effort_applicable?:boolean, reasoning_effort?:string|null, effort_levels?:string[]}>>}
*/
async function listModels(port = DEFAULT_PORT, signal) {
	const res = await fetch(`${baseUrl(port)}/models`, {
		method: "GET",
		headers: bearerHeaders(port),
		signal
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
async function codingPlanUsage(port = DEFAULT_PORT, path = "/codingplan/usage/summary", signal) {
	const res = await fetch(`${baseUrl(port)}${path}`, {
		method: "GET",
		headers: bearerHeaders(port),
		signal
	});
	if (!res.ok) throw new Error(`atomcode ${path} -> HTTP ${res.status}`);
	return res.json();
}
/**
* GET /sessions — the daemon's session index (all projects, not filtered).
* @param {number} port
* @param {AbortSignal} [signal]
* @returns {Promise<SessionEntry[]>}
*/
async function listSessions(port = DEFAULT_PORT, signal) {
	const res = await fetch(`${baseUrl(port)}/sessions`, {
		method: "GET",
		headers: bearerHeaders(port),
		signal
	});
	if (!res.ok) throw new Error(`atomcode /sessions -> HTTP ${res.status}`);
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
	const headers = bearerHeaders(port, { "Content-Type": "application/json" });
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
			message: errText(error),
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
	const payload = {
		message: opts.message,
		approval_mode: opts.approvalMode ?? "bypass"
	};
	if (opts.provider) payload.provider = opts.provider;
	if (opts.sessionId) payload.session_id = opts.sessionId;
	if (opts.workingDir) payload.working_dir = opts.workingDir;
	if (opts.reasoningEffort) payload.reasoning_effort = opts.reasoningEffort;
	const headers = bearerHeaders(port, {
		"Content-Type": "application/json",
		...opts.extraHeaders || {}
	});
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
	const roundFuse = opts.maxRounds != null && opts.maxRounds > 0 ? opts.maxRounds : 0;
	const LOCAL_ABORT_CAVEAT = "（本端已停止等待）";
	/** The one abort sentence — so no abort path can ship its own wording. */
	const abortError = () => /* @__PURE__ */ new Error(`atomcode turn aborted: ${abortReason}${LOCAL_ABORT_CAVEAT}`);
	/** Re-throw an abort-flavoured transport error as an actionable message. */
	const describeAbort = (error) => {
		if (abortReason) return abortError();
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
					throw abortError();
				}
				if (typeof event.type === "string" && !KNOWN_SSE_TYPES.has(event.type)) unknownTypeNames.add(event.type);
				else sawRecognizable = true;
				yield event;
			}
		}
		if (!sawTerminal) {
			if (unknownTypeNames.size > 0 && !sawRecognizable) throw new Error(`unrecognized daemon SSE vocabulary (types: ${[...unknownTypeNames].sort().join(", ")}) — the daemon may have changed its /chat protocol; upgrade dsh-connect-atomcode (or check the daemon version)`);
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
function reportedToolCalls(done) {
	if (!done) return null;
	if (typeof done.tool_calls === "number") return done.tool_calls;
	const stats = done.stats && typeof done.stats === "object" ? done.stats : null;
	return stats && typeof stats.tool_calls === "number" ? stats.tool_calls : null;
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
function reportedRounds(done) {
	if (!done) return null;
	const stats = done.stats && typeof done.stats === "object" ? done.stats : null;
	return stats && typeof stats.rounds === "number" ? stats.rounds : null;
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
async function askChat(opts) {
	let reply = "";
	const usedTools = [];
	let done = null;
	let tokens = 0;
	let sessionId = "";
	let realProvider = void 0;
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
	const outstanding = [];
	let batchConcurrent = false;
	const unknownTypes = /* @__PURE__ */ new Set();
	let streamError = "";
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
	let eventError = "";
	const report = () => {
		if (!opts.onProgress) return;
		try {
			opts.onProgress({
				rounds: roundCount,
				completed: usedTools.length - outstanding.length,
				chars: reply.length,
				sessionId,
				lastTool: usedTools.length > 0 ? usedTools[usedTools.length - 1].name : "",
				tokens
			});
		} catch {}
	};
	try {
		for await (const ev of streamChat(opts)) {
			if (ev.type === "text") reply += String(ev.content || "");
			else if (ev.type === "session_assigned" && typeof ev.session_id === "string") sessionId = ev.session_id;
			else if (ev.type === "runtime_info" && typeof ev.provider === "string" && ev.provider !== "") {
				realProvider = ev.provider;
				providerReported = true;
			} else if (ev.type === "tool_start") {
				const record = {
					name: String(ev.name || "tool"),
					success: false
				};
				usedTools.push(record);
				outstanding.push(record);
				if (outstanding.length > 1) batchConcurrent = true;
				roundCount += 1;
			} else if (ev.type === "tool_result") {
				const record = outstanding.shift();
				if (record) record.success = batchConcurrent ? null : ev.success === true;
				if (outstanding.length === 0) batchConcurrent = false;
			} else if (ev.type === "tokens") tokens = Number(ev.total) || 0;
			else if (ev.type === "done") done = ev;
			else if (ev.type === "error" && eventError === "") eventError = String(ev.message || "atomcode turn error");
			else if (ev && typeof ev.type === "string" && !KNOWN_SSE_TYPES.has(ev.type)) unknownTypes.add(ev.type);
			report();
		}
	} catch (error) {
		streamError = errText(error);
	}
	if (streamError !== "") {
		const target = sessionId || (typeof opts.sessionId === "string" ? opts.sessionId : "");
		streamError = appendStopOutcome(streamError, await stopChat({
			port: opts.port,
			sessionId: target,
			timeoutMs: opts.stopTimeoutMs
		}));
	}
	let error = streamError || eventError;
	let ok = done !== null;
	const sawAnyRecognizable = reply !== "" || usedTools.length > 0 || done !== null || error !== "" || sessionId !== "" || tokens > 0;
	if (!ok && !sawAnyRecognizable && unknownTypes.size > 0) error = `unrecognized daemon SSE vocabulary (types: ${[...unknownTypes].sort().join(", ")}) — the daemon may have changed its /chat protocol; upgrade dsh-connect-atomcode (or check the daemon version).`;
	if (ok && reply.trim() === "" && usedTools.length === 0 && unknownTypes.size > 0) {
		ok = false;
		const drift = `done received but the turn carried no recognizable content (unknown types: ${[...unknownTypes].sort().join(", ")}) — the daemon may have renamed its payload vocabulary; upgrade dsh-connect-atomcode (or check the daemon version).`;
		error = error === "" ? drift : `${drift} (observed turn error: ${error})`;
	}
	return {
		ok,
		reply: reply.trim(),
		sessionId: done && typeof done.session_id === "string" ? done.session_id : sessionId,
		tokens: done && typeof done.tokens === "number" ? done.tokens : tokens,
		toolCalls: done && typeof done.tool_calls === "number" ? done.tool_calls : usedTools.length,
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
		tools: usedTools.slice(0, 30),
		toolsTruncated: usedTools.length > 30,
		stopReason: done && typeof done.stop_reason === "string" ? done.stop_reason : "",
		/** Actual provider name reported by the daemon SSE runtime_info event, or the explicit provider passed in opts, or 'default'. */
		provider: realProvider || opts.provider || "default",
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
		error: error || (ok ? "" : "chat stream ended before done")
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
const STOP_COMMAND_TIMEOUT_MS = 1500;
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
async function stopChat(opts = {}) {
	const sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
	if (sessionId === "") return {
		ok: false,
		sent: false,
		message: "no session id yet — nothing to stop"
	};
	const port = opts.port ?? 13459;
	const headers = bearerHeaders(port, { "Content-Type": "application/json" });
	try {
		const res = await fetch(`${baseUrl(port)}/chat/stop`, {
			method: "POST",
			headers,
			body: JSON.stringify({ session_id: sessionId }),
			signal: AbortSignal.timeout(opts.timeoutMs ?? 1500)
		});
		const text = await res.text().catch(() => "");
		let message = text.slice(0, 200).trim();
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed.message === "string") message = parsed.message;
		} catch {}
		if (!res.ok) return {
			ok: false,
			sent: true,
			message: `/chat/stop -> HTTP ${res.status} ${message}`.trim()
		};
		return {
			ok: true,
			sent: true,
			message
		};
	} catch (error) {
		return {
			ok: false,
			sent: true,
			message: errText(error)
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
function appendStopOutcome(error, stop) {
	const base = String(error ?? "");
	if (stop.sent === false) return `${base}（本端已停止等待；该回合还没拿到 session_id，无法请求 daemon 停止，daemon 侧可能仍在继续跑并消耗额度与工具调用）`;
	if (stop.ok === true) return `${base}（已请求 daemon 停止该回合：/chat/stop 已应答${stop.message ? ` — ${stop.message}` : ""}）`;
	return `${base}（已请求 daemon 停止该回合但未成功：${stop.message}；daemon 侧可能仍在继续跑并消耗额度与工具调用）`;
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
async function setReasoningEffort(opts) {
	const port = opts.port ?? 13459;
	const headers = bearerHeaders(port, { "Content-Type": "application/json" });
	try {
		const res = await fetch(`${baseUrl(port)}/live/reasoning_effort`, {
			method: "POST",
			headers,
			body: JSON.stringify({ reasoning_effort: opts.effort }),
			signal: AbortSignal.timeout(opts.timeoutMs ?? 5e3)
		});
		const text = await res.text().catch(() => "");
		try {
			const parsed = JSON.parse(text);
			if (parsed && parsed.ok === false) return {
				ok: false,
				message: parsed.error || `HTTP ${res.status}`
			};
			return {
				ok: true,
				message: parsed.message || "ok"
			};
		} catch {
			return {
				ok: res.ok,
				message: res.ok ? "ok" : `HTTP ${res.status}`
			};
		}
	} catch (error) {
		return {
			ok: false,
			message: errText(error)
		};
	}
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
		if (typeof opts.log === "function") opts.log(`atomcode daemon spawn failed: ${errText(error)}`);
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
export { DEFAULT_PORT, STOP_COMMAND_TIMEOUT_MS, TOOLS_CAP, appendStopOutcome, askChat, baseUrl, codingPlanUsage, defaultBinary, health, healthInfo, listModels, listSessions, parseSseLine, readDaemonIdentity, readToken, runCommand, setReasoningEffort, spawnDaemon, stopChat, streamChat };