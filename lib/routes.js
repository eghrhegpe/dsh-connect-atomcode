import { PROVIDER_SLOTS, normalizeProviderName } from "./provider-store.js";
import { buildStatsBody, sameOrigin, writeJson } from "./stats.js";

//#region src/host/routes.ts
/**
* The two HTTP routes this plugin serves: the read-only stats snapshot the
* detail page polls, and the write endpoint behind the model dropdown.
*
* Extracted from `src/host/index.ts` (v0.4.3 split). They are mounted together
* because they share everything that matters — one `webServer` registration
* surface, one runtime — and because mounting them apart is how the teardown
* ended up as four separate `if (typeof … === 'function')` checks in apply(),
* a shape where a fifth disposer goes missing without any compiler complaint.
*
* `webServer` is resolved by the caller: getting it needs `ctx`, and keeping
* `ctx` out of this function is the same rule createRuntime() follows. A host
* without the service is not an error — both registrations degrade to no-ops.
*
* @returns {() => void} one disposer for both routes.
* @module dsh-connect-atomcode/host/routes
*/
const PROVIDER_BODY_LIMIT = 4096;
/** Read and parse a bounded JSON body; the route then judges its fields. */
async function readJsonBody(request) {
	const chunks = [];
	let received = 0;
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
			received += buffer.byteLength;
			if (received > PROVIDER_BODY_LIMIT) return {
				ok: false,
				error: `request body is larger than ${PROVIDER_BODY_LIMIT} bytes`
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
* @param {{ webServer: any; runtime: Runtime; log: (message: any) => void }} deps
* @returns {() => void} one disposer for both routes.
*/
function mountRoutes({ webServer, runtime, log }) {
	const { stats, sessions, refreshHealth, ensureDaemonStarted, readQuota, refreshPanelState, refreshModelCatalog, providerStore } = runtime;
	const disposeStats = webServer && typeof webServer.register === "function" ? webServer.register({
		kind: "exact",
		path: "/api/atomcode-bridge/stats",
		handler: async (request, response) => {
			if (request && request.method && request.method !== "GET" && request.method !== "HEAD") {
				response.writeHead(405, { allow: "GET, HEAD" });
				response.end();
				return;
			}
			if (!sameOrigin(request)) {
				response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
				response.end("forbidden");
				return;
			}
			stats.sessionsTracked = sessions.count();
			stats.sessionsOldestAgeMs = sessions.oldestAgeMs();
			await refreshHealth();
			if (!stats.daemonUp) ensureDaemonStarted();
			const quota = await readQuota();
			refreshPanelState();
			await refreshModelCatalog();
			if (request.method === "HEAD") {
				response.writeHead(200, { "cache-control": "no-store" });
				response.end();
				return;
			}
			writeJson(response, 200, buildStatsBody(stats, quota), { "cache-control": "no-store" });
		}
	}) : () => {};
	const disposeProvider = webServer && typeof webServer.register === "function" ? webServer.register({
		kind: "exact",
		path: "/api/atomcode-bridge/provider",
		handler: async (request, response) => {
			const method = request && request.method ? request.method : "GET";
			if (method !== "GET" && method !== "HEAD" && method !== "POST") {
				writeJson(response, 405, {
					ok: false,
					error: "method not allowed"
				}, { allow: "GET, HEAD, POST" });
				return;
			}
			if (!sameOrigin(request)) {
				writeJson(response, 403, {
					ok: false,
					error: "forbidden: origin mismatch"
				});
				return;
			}
			if (method === "POST") {
				const body = await readJsonBody(request);
				if (!body.ok) {
					writeJson(response, 400, {
						ok: false,
						error: body.error
					});
					return;
				}
				const slot = body.value.slot;
				if (!PROVIDER_SLOTS.includes(slot)) {
					writeJson(response, 400, {
						ok: false,
						error: `slot must be one of ${PROVIDER_SLOTS.join(" / ")} (the two paths take different provider names — 红线 8)`
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
	}) : () => {};
	return () => {
		disposeStats();
		disposeProvider();
	};
}

//#endregion
export { mountRoutes };