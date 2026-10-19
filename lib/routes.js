import { PROVIDER_SLOT, normalizeProviderName } from "./provider-store.js";
import { PANEL_SETTINGS_WRITABLE_FIELDS } from "./panel-settings-store.js";
import { buildStatsBody, sameOrigin, writeJson } from "./stats.js";

//#region src/host/routes.ts
/**
* The HTTP routes this plugin serves: the read-only stats snapshot the detail
* page polls, the write endpoint behind the model dropdown, the
* reasoning-effort write point, the panel-settings write point, and the daemon
* session index.
*
* The `/ask` route is GONE (2026-10-18): the 锐评 officialization (方针 A)
* deleted the panel's private ask button + popover — one-click review now goes
* through the `/atomcode-review` slash command (host-side, zero DSH turns), and
* free-form questions go through the model's official `atomcode_ask`. The
* route's only consumer was
* the private popover; keeping a route with zero callers is how a dead ABI
* surface survives to confuse the next reader.
*
* The `/inject` route is GONE (2026-10-19) for the same reason: 方针 A left it
* with no in-repo caller, it carried no authentication (same-origin is a CSRF
* gate, not an identity gate, and every plugin's client bundle shares the one
* origin), and it could wake an idle session's driver for the price of a POST.
* The delivery it wired is still reachable — `injectAtomcodeAnswer` /
* `injectReviewContinuation` live in `./inject.ts` and the `/atomcode-review`
* continuation calls them host-side, without an HTTP surface at all. A route
* with zero callers and a cross-session write surface is exactly the dead ABI
* the `/ask` note above warns about.
*
* Extracted from `src/host/index.ts` (apply() split). They are mounted together
* because they share everything that matters — one `webServer` registration
* surface, one runtime — and because mounting them apart is how the teardown
* ended up as separate `if (typeof … === 'function')` checks in apply(),
* a shape where a fifth disposer goes missing without any compiler complaint.
* Adding a route here and forgetting its disposer is impossible: the disposer
* is built from the same `webServer` guard, in the same function.
*
* `webServer` is resolved by the caller: getting it needs `ctx`, and keeping
* `ctx` out of this function is the same rule createRuntime() follows. A host
* without the service is not an error — the registrations degrade to no-ops.
*
* @returns {() => void} one disposer for all routes.
* @module dsh-connect-atomcode/host/routes
*/
const PROVIDER_BODY_LIMIT = 4096;
/**
* Read and parse a bounded JSON body; the route then judges its fields.
*
* The limit is the CALLER's call, because the write routes carry fundamentally
* different bodies (a slot+name pair vs a whole ask message). Exceeding it is
* REPORTED, never truncated — a silently half-read body would read to the user
* as a bad request rather than as a size limit.
*/
async function readJsonBody(request, limit = PROVIDER_BODY_LIMIT) {
	const chunks = [];
	let received = 0;
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
			received += buffer.byteLength;
			if (received > limit) return {
				ok: false,
				error: `request body is larger than ${limit} bytes`
			};
			chunks.push(buffer);
		}
	} catch {
		return {
			ok: false,
			error: "could not read the request body"
		};
	}
	if (chunks.length === 0) return {
		ok: false,
		error: "a JSON body is required"
	};
	let parsed;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return {
			ok: false,
			error: "the body is not valid JSON"
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {
		ok: false,
		error: "the body must be a JSON object"
	};
	return {
		ok: true,
		value: parsed
	};
}
/**
* Mount one exact route and hand back its disposer.
*
* Every route in this file is registered the same way, so a host without
* `webServer` (or without `register`) degrades all routes to a no-op through ONE
* guard. This replaced six copies of the same ternary, one of which (`/inject`)
* had drifted to a bare truthiness check — the single place a host exposing
* `webServer` without `register` would have thrown instead of degrading.
* Adding a route and forgetting its disposer is impossible: the disposer is
* this function's return value, not a local someone must remember to call in
* the teardown at the bottom.
*
* `methods` is the ONE place the method gate lives. Each handler used to write
* its own copy, and they drifted: `/stats` and `/provider` refused a MISSING
* method, `/inject` and `/reasoning-effort` read it as POST, `/sessions`
* checked nothing at all — one file, one author, several answers to the same
* malformed request. A handler that forgets the gate here is caught by the
* `allow` header this wrapper writes, so a new route cannot silently guess.
*
* @param webServer - `ctx.webServer`, or anything falsy on a host without it.
* @param descriptor - `{ kind: 'exact', path, methods, handler }` for one route;
*   `methods` is the request-method whitelist that the handler may read back.
* @returns the disposer, never undefined.
*/
function mountRoute(webServer, descriptor) {
	if (!webServer || typeof webServer.register !== "function") return () => {};
	const { path, methods, handler } = descriptor;
	return webServer.register({
		kind: "exact",
		path,
		handler: (request, response) => {
			if (!request || !request.method || !methods.includes(request.method)) {
				writeJson(response, 405, {
					ok: false,
					error: "method not allowed"
				}, { allow: methods.join(", ") });
				return;
			}
			return handler(request, response);
		}
	});
}
/**
* Answer a cross-origin request with the one refusal every non-stats route
* gives. (The stats route answers 403 as `text/plain` — it is polled by tools
* that never parse JSON, so it keeps its own wording.)
*
* @returns true when it answered — the caller must then `return`.
*/
function refuseCrossOrigin(request, response) {
	if (sameOrigin(request)) return false;
	writeJson(response, 403, {
		ok: false,
		error: "forbidden: origin mismatch"
	});
	return true;
}
/**
* Read the bounded JSON body, or send the 400 the caller would have written.
*
* The 400 body is `{ ok: false, error }` on all four write routes because the
* client treats any response without `ok: true` as a failure and renders
* `error`; keeping the shape in one place is what keeps it that way.
*
* @returns the parsed body, or null when the 400 already went out.
*/
async function readBodyOr400(request, response, limit = PROVIDER_BODY_LIMIT) {
	const body = await readJsonBody(request, limit);
	if (body.ok) return body;
	writeJson(response, 400, {
		ok: false,
		error: body.error
	});
	return null;
}
/**
* @param {{ webServer: any; runtime: Runtime; log: (message: any) => void }} deps
* @returns {() => void} one disposer for all routes.
*/
function mountRoutes({ webServer, runtime, log }) {
	const { stats, sessions, refreshHealth, ensureDaemonStarted, readQuota, readUsageTrend, refreshPanelState, refreshModelCatalog, providerStore, panelSettingsStore } = runtime;
	const disposeStats = mountRoute(webServer, {
		kind: "exact",
		path: "/api/atomcode-bridge/stats",
		methods: ["GET", "HEAD"],
		handler: async (request, response) => {
			if (!sameOrigin(request)) {
				response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
				response.end("forbidden");
				return;
			}
			if (request.method === "HEAD") {
				response.writeHead(200, { "cache-control": "no-store" });
				response.end();
				return;
			}
			const sessionsSnapshot = sessions.snapshot();
			stats.sessionsTracked = sessionsSnapshot.tracked;
			stats.sessionsOldestAgeMs = sessionsSnapshot.oldestAgeMs;
			await refreshHealth();
			if (!stats.daemonUp) ensureDaemonStarted();
			const quota = await readQuota();
			refreshPanelState();
			await refreshModelCatalog();
			await readUsageTrend();
			writeJson(response, 200, buildStatsBody(stats, quota), { "cache-control": "no-store" });
		}
	});
	const disposeProvider = mountRoute(webServer, {
		kind: "exact",
		path: "/api/atomcode-bridge/provider",
		methods: [
			"GET",
			"HEAD",
			"POST"
		],
		handler: async (request, response) => {
			const method = request.method;
			if (refuseCrossOrigin(request, response)) return;
			if (method === "POST") {
				const body = await readBodyOr400(request, response);
				if (!body) return;
				const slot = body.value.slot;
				if (slot !== "ask") {
					writeJson(response, 400, {
						ok: false,
						error: `slot must be "${"ask"}" (the second namespace died with the review CLI)`
					});
					return;
				}
				if (!Object.prototype.hasOwnProperty.call(body.value, "provider")) {
					writeJson(response, 400, {
						ok: false,
						error: "provider field is missing: name it, or send null explicitly to clear the pick"
					});
					return;
				}
				const normalized = normalizeProviderName(body.value.provider);
				if (!normalized.ok) {
					writeJson(response, 400, {
						ok: false,
						error: normalized.error
					});
					return;
				}
				const written = providerStore.set(slot, normalized.value);
				if (!written.ok) {
					const status = written.code === "foreign-version" ? 409 : 500;
					log(`provider pick refused (${slot}): ${written.error}`);
					writeJson(response, status, {
						ok: false,
						error: written.error
					});
					return;
				}
				log(`provider pick saved (${slot}): ${written.value === null ? "cleared" : written.value}`);
			}
			refreshPanelState();
			if (method === "HEAD") {
				response.writeHead(200, { "cache-control": "no-store" });
				response.end();
				return;
			}
			writeJson(response, 200, {
				ok: true,
				...buildStatsBody(stats, null).provider
			}, { "cache-control": "no-store" });
		}
	});
	const disposeReasoningEffort = mountRoute(webServer, {
		kind: "exact",
		path: "/api/atomcode-bridge/reasoning-effort",
		methods: ["POST"],
		handler: async (request, response) => {
			if (refuseCrossOrigin(request, response)) return;
			const body = await readBodyOr400(request, response);
			if (!body) return;
			const effort = body.value.effort;
			if (typeof effort !== "string" || effort.trim() === "") {
				writeJson(response, 400, {
					ok: false,
					error: "effort is required and must be a non-empty string"
				});
				return;
			}
			const result = await runtime.setReasoningEffort(effort.trim());
			writeJson(response, 200, result, { "cache-control": "no-store" });
		}
	});
	const disposeSessions = mountRoute(webServer, {
		kind: "exact",
		path: "/api/atomcode-bridge/sessions",
		methods: ["GET"],
		handler: async (_request, response) => {
			if (refuseCrossOrigin(_request, response)) return;
			try {
				const sessions = await runtime.listSessions();
				writeJson(response, 200, {
					ok: true,
					sessions
				}, { "cache-control": "no-store" });
			} catch (error) {
				const reason = String(error && error.message ? error.message : error);
				writeJson(response, 502, {
					ok: false,
					error: reason
				}, { "cache-control": "no-store" });
			}
		}
	});
	const PANEL_SETTINGS_BODY_LIMIT = 2048;
	const disposePanelSettings = mountRoute(webServer, {
		kind: "exact",
		path: "/api/atomcode-bridge/panel-settings",
		methods: [
			"GET",
			"HEAD",
			"POST"
		],
		handler: async (request, response) => {
			if (refuseCrossOrigin(request, response)) return;
			const method = request.method;
			if (method === "POST") {
				const body = await readBodyOr400(request, response, PANEL_SETTINGS_BODY_LIMIT);
				if (!body) return;
				const fields = {};
				for (const name of PANEL_SETTINGS_WRITABLE_FIELDS) if (Object.prototype.hasOwnProperty.call(body.value, name)) fields[name] = body.value[name];
				if (Object.keys(fields).length === 0) {
					writeJson(response, 400, {
						ok: false,
						error: `at least one of ${PANEL_SETTINGS_WRITABLE_FIELDS.join(", ")} must be present`
					});
					return;
				}
				const written = panelSettingsStore.set(fields);
				if (!written.ok) {
					const status = written.code === "foreign-version" ? 409 : written.code.startsWith("invalid-") ? 400 : 500;
					log(`panel-settings write refused: ${written.error}`);
					writeJson(response, status, {
						ok: false,
						error: written.error
					});
					return;
				}
				log(`panel-settings saved: ${JSON.stringify(fields)}`);
			}
			const current = panelSettingsStore.read();
			if (method === "HEAD") {
				response.writeHead(200, { "cache-control": "no-store" });
				response.end();
				return;
			}
			writeJson(response, 200, {
				ok: true,
				briefMode: current.briefMode,
				workingDir: current.workingDir,
				approvalMode: current.approvalMode,
				askMaxRounds: current.askMaxRounds,
				...current.foreignVersion ? { foreignVersion: true } : {},
				...current.error ? { error: current.error } : {}
			}, { "cache-control": "no-store" });
		}
	});
	return () => {
		disposeStats();
		disposeProvider();
		disposeReasoningEffort();
		disposeSessions();
		disposePanelSettings();
	};
}

//#endregion
export { mountRoutes };