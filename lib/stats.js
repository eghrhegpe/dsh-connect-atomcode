import { DAEMON_PROBE_TIMEOUT_MS } from "./config.js";

//#region src/host/stats.ts
/** Host-side status endpoint helper (read-only, same-origin). */
function writeJson(res, status, body, headers) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		...headers || {}
	});
	res.end(JSON.stringify(body));
}
/**
* Reject cross-origin reads: the panel and the host share one origin.
*
* Honest scope: this is a CSRF gate, not an authentication gate — a browser
* always sends Origin on cross-origin writes, but any same-machine process
* can simply omit the header and pass. That is acceptable here because the
* only write route (`/provider`) touches the plugin's OWN state file.
*/
function sameOrigin(request) {
	const reqHeaders = request && request.headers;
	const host = reqHeaders ? reqHeaders.host || reqHeaders.Host : void 0;
	const origin = reqHeaders ? reqHeaders.origin || reqHeaders.Origin : void 0;
	if (!origin) return true;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
/**
* Say WHY the daemon is not reachable — one cause per sentence, and NO port.
*
* Every one of these used to read "未监听", and that is true of exactly one of
* them. A port held by a different service, a daemon that accepted the
* connection and then stopped answering, and a port nobody is listening on look
* identical from here and share nothing as problems: one needs the process
* started, one needs the other service moved, one needs the daemon looked at. A
* message that names the wrong cause costs the reader exactly the time they came
* here to save, so an unclassified shape says so rather than picking the
* plausible one.
*
* The port is left to the caller, because its callers disagree about where it
* goes: the tool errors embed it in the address they quote, while the panel
* prints it on its own line and would otherwise say it twice.
*
* @param reason - from `healthInfo`; `''` means the daemon is up (callers do not
*   ask for a sentence then) or that no probe has finished yet.
*/
function describeDaemonDown(reason) {
	switch (reason) {
		case "refused": return "没有任何进程在监听";
		case "timeout": return `有进程在监听，但 ${DAEMON_PROBE_TIMEOUT_MS}ms 内无应答`;
		case "http-error": return "端口上有服务，但 /health 返回非 2xx";
		case "unreadable": return "端口上有服务，但应答不是可解析的 JSON";
		case "not-atomcode": return "端口被非 AtomCode 服务占用（/health 未声明 atomcode-daemon）";
		case "unreachable": return "探活失败，原因未能归类";
		case "": return "尚未探活";
		default: return `探活失败，归类「${String(reason)}」本版本不认识`;
	}
}
/**
* Build the live stats bag. One construction site, total: every field is
* initialized here, so there is no such thing as a bag that is half-built, and
* no field exists only as a write some closure performs later.
*
* @param {StatsSeed} seed - the mount-resolved values (see `StatsSeed`).
*/
function createStatsBag(seed) {
	return {
		startedAt: Date.now(),
		pluginVersion: seed.pluginVersion,
		port: seed.port,
		autoStart: seed.autoStart,
		binaryPath: seed.binaryPath,
		binaryEnv: seed.binaryEnv,
		approvalMode: seed.approvalMode,
		defaultWorkingDir: seed.defaultWorkingDir,
		reviewWorkingDir: seed.reviewWorkingDir,
		defaultProvider: seed.defaultProvider,
		reviewDefaultProvider: seed.reviewDefaultProvider,
		panelProvider: {
			ask: null,
			review: null
		},
		panelStorePath: seed.panelStorePath,
		panelStoreError: "",
		panelStoreForeign: false,
		effectiveAsk: null,
		effectiveAskSource: "atomcode",
		effectiveReview: null,
		effectiveReviewSource: "auto",
		modelCatalog: null,
		modelCatalogAt: 0,
		modelCatalogError: "",
		reviewCatalog: seed.reviewCatalog,
		reviewEndpoints: seed.reviewEndpoints,
		daemonUp: false,
		daemonVersion: "",
		daemonDownReason: "",
		spawnTried: false,
		spawnAttempts: 0,
		spawnFailures: 0,
		lastSpawnAt: 0,
		daemonStarting: false,
		lastHealthAt: 0,
		reviewAvailable: seed.reviewAvailable,
		reviewReason: seed.reviewReason,
		sessionsTracked: 0,
		sessionsOldestAgeMs: null,
		sessionsError: "",
		askRounds: seed.askRounds,
		retrySecs: seed.retrySecs,
		authored: seed.authored,
		defaults: seed.defaults,
		quotaDriftSeen: false,
		protocolUnknownTypes: [],
		ask: {
			calls: 0,
			ok: 0,
			err: 0,
			msTotal: 0,
			tokens: 0
		},
		review: {
			calls: 0,
			ok: 0,
			err: 0,
			msTotal: 0
		}
	};
}
/**
* Snapshot body consumed by the plugin detail-page client.
*
* The reported version is read off `stats.pluginVersion`, which the assembly
* point (`src/host/index.ts`) declares as the hand-edited literal that
* `test/wiring.test.mjs` pins against `package.json`.
*
* @param {StatsBag} stats - the live runtime bag.
* @param {any} quota - the quota report from `buildQuotaReport`, or null to
*   report "not collected yet".
* @returns {StatsSnapshot} the wire shape, which `src/shared/stats.ts` declares
*   for BOTH halves — see that file's `StatsSnapshot`.
*/
function buildStatsBody(stats, quota) {
	return {
		ok: true,
		name: "dsh-connect-atomcode",
		displayName: "DSH AtomCode Bridge",
		version: stats.pluginVersion,
		uptimeMs: Date.now() - stats.startedAt,
		daemon: {
			up: stats.daemonUp,
			port: stats.port,
			autoStart: stats.autoStart,
			spawnTried: stats.spawnTried,
			spawnAttempts: stats.spawnAttempts,
			spawnFailures: stats.spawnFailures,
			starting: stats.daemonStarting,
			lastCheckedAt: stats.lastHealthAt,
			downMessage: stats.daemonUp ? "" : describeDaemonDown(stats.daemonDownReason)
		},
		binary: {
			configured: stats.binaryPath,
			env: stats.binaryEnv,
			source: stats.binaryPath ? "config" : stats.binaryEnv ? "env" : "auto"
		},
		config: {
			approvalMode: stats.approvalMode,
			defaultWorkingDir: stats.defaultWorkingDir,
			reviewWorkingDir: stats.reviewWorkingDir,
			defaultProvider: stats.defaultProvider,
			reviewDefaultProvider: stats.reviewDefaultProvider,
			askMaxRounds: stats.askRounds,
			daemonRetrySecs: stats.retrySecs,
			reviewAvailable: stats.reviewAvailable,
			authored: stats.authored,
			defaults: stats.defaults,
			reviewReason: stats.reviewReason
		},
		provider: {
			storePath: stats.panelStorePath,
			storeError: stats.panelStoreError,
			foreignVersion: stats.panelStoreForeign,
			ask: {
				panel: stats.panelProvider.ask,
				config: stats.defaultProvider,
				effective: stats.effectiveAsk,
				source: stats.effectiveAskSource,
				catalog: stats.modelCatalog,
				catalogError: stats.modelCatalogError
			},
			review: {
				panel: stats.panelProvider.review,
				config: stats.reviewDefaultProvider,
				effective: stats.effectiveReview,
				source: stats.effectiveReviewSource,
				catalog: stats.reviewCatalog,
				endpoints: stats.reviewEndpoints
			}
		},
		protocol: {
			daemonVersion: stats.daemonVersion,
			verifiedGeneration: "5.x",
			quotaTextDrift: stats.quotaDriftSeen,
			unknownTypes: stats.protocolUnknownTypes
		},
		quota: quota ?? {
			available: false,
			reason: "not collected yet",
			fetchedAt: null
		},
		sessions: {
			tracked: stats.sessionsTracked,
			oldestAgeMs: stats.sessionsOldestAgeMs,
			error: stats.sessionsError
		},
		ask: stats.ask,
		review: stats.review
	};
}

//#endregion
export { buildStatsBody, createStatsBag, describeDaemonDown, sameOrigin, writeJson };