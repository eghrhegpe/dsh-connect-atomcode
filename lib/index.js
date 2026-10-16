import { DEFAULT_PORT, TOOLS_CAP, askChat, healthInfo, listModels, runCommand, spawnDaemon } from "./daemon.js";
import { createSessionStore, defaultStatePath } from "./sessions.js";
import { PROVIDER_SLOTS, createProviderStore, normalizeProviderName } from "./provider-store.js";
import { checkReviewProvision, probeLocalEndpoint, runReview, selectReviewProvider } from "./review.js";
import { isLoopbackBaseUrl } from "./loopback.js";
import { buildQuotaReport } from "./quota.js";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

//#region src/host/index.ts
/**
* atomcode-bridge — Cordis plugin (Host half, tools-only).
*
* Repositioned build (v0.3): the "model provider takeover" half of the
* original upstream design (LlmAdapter over the daemon /chat) is REMOVED.
* A full autonomous agent (own tool loop, own system prompt, bypass
* approval) plugged into DSH's one-completion socket breaks DSH's tool
* loop, punches through its permission model, and re-feeds O(N²) tokens
* per conversation turn. What remains is the honest shape of this bridge:
*
*  1. `atomcode_ask` — side-conversation relay. One message goes to the
*     local AtomCode daemon (`POST /chat`, SSE); the whole autonomous turn
*     comes back as one answer. `continue: true` resumes the previously
*     recorded side conversation (session map keyed by working_dir, stored
*     at ~/.dsh/state/dsh-atomcode-bridge/), so the model never carries ids.
*  2. `atomcode_review` — one-shot code review. Wraps the CLI's
*     `atomcode review` (git range / PR / diff-file / custom task) with
*     round + wall-clock fuses and `--no-web` for proxy-gated hosts;
*     returns the structured `--json` findings.
*
* KNOWN LIMITATIONS (v0.3):
*   - atomcode_review requires a **direct** `[providers.<name>]` entry with
*     `base_url` in `~/.atomcode/config.toml`; account-resolved models
*     (AtomGit gateway) are NOT seen by the review CLI. The tool description
*     is dynamically downgraded on mount if config inspection shows
*     unavailability. Daemon-side `atomcode_ask` is NOT affected — it embeds
*     the gateway signing.
*   - The `sessions.json` file uses a profile-scoped key prefix so cross-
*     profile (web + desktop) writes do not collide.
*
* Cross-platform: paths resolve from `os.homedir()`, the binary is found
* via $ATOMCODE_BIN / config / PATH (atomcode.exe on Windows). The daemon
* conversation runs over global `fetch`; the review runs the CLI directly.
* No shell pipelines, no hardcoded accounts, no host LLM dependency — this
* plugin only consumes the `tools` service.
*
* @module dsh-atomcode-bridge
*/
/**
* Host-side status endpoint helpers (read-only, same-origin).
* Mirrors the dsh-connect-sensenova-token-plan snapshot route contract so the
* plugin detail-page client can poll live startup/usage stats.
*/
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
/** Profile key used to namespace session keys (e.g. "web" or "desktop"). */
/**
* Which DSH profile this host process belongs to, as a key-space prefix.
*
* The prefix keeps two profiles (web + desktop) writing DISJOINT keys in the
* shared `sessions.json`. Without one they collide on the same `default::` key,
* and a `continue: true` in one profile resumes the OTHER profile's side
* conversation — a wrong-repo answer with no trace of why.
*
* Two behaviours here were wrong and both are fixed in place:
*
*  1. An explicit `DSH_PROFILE` was run through a three-word allowlist
*     ('web' / 'desktop' / 'headless'), so a legitimate value outside that set
*     was TOSSED and the answer fell through to a guess. The environment is the
*     authority — if DSH set it, it is the answer, whatever it says.
*  2. The argv heuristic tested `/dsh.*\b(desktop|web)\b/i` against
*     `process.argv.join(' ')`. That matches across argument boundaries (any
*     later `desktop` anywhere on the line) and inside unrelated strings — a
*     path like `/opt/dsh-tools/webpack.config.js` satisfies the `web` branch.
*     A WRONG profile key is worse than a missing one: it silently splits or
*     merges the wrong conversations.
*
* Returning '' is therefore a real possibility, and the caller NAMES it rather
* than letting an unprefixed key space look intentional (红线 3).
*
* @param {string[]} [argv] - injectable for tests.
* @returns {string} the profile name, or '' when it cannot be determined.
*/
function detectProfileKey(argv = process.argv) {
	const env = String(process.env.DSH_PROFILE || "").trim();
	if (env !== "") return env;
	const tokens = argv.slice(1).map((t) => String(t).trim().toLowerCase());
	if (!tokens.some((t) => /(^|[\\/])dsh(\.exe|\.cmd|\.bat|\.js)?$/.test(t))) return "";
	if (tokens.includes("desktop")) return "desktop";
	if (tokens.includes("web")) return "web";
	return "";
}
/** Snapshot body consumed by the plugin detail-page client. */
function buildStatsBody(stats, quota) {
	return {
		ok: true,
		name: "dsh-atomcode-bridge",
		displayName: "DSH AtomCode Bridge",
		version: "0.4.1",
		uptimeMs: Date.now() - stats.startedAt,
		daemon: {
			up: stats.daemonUp,
			port: stats.port,
			autoStart: stats.autoStart,
			spawnTried: stats.spawnTried,
			spawnAttempts: stats.spawnAttempts,
			spawnFailures: stats.spawnFailures,
			starting: stats.daemonStarting,
			lastCheckedAt: stats.lastHealthAt
		},
		binary: {
			configured: stats.binaryConfigured,
			env: stats.binaryEnv,
			source: stats.binaryConfigured ? "config" : stats.binaryEnv ? "env" : "auto"
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
			quotaTextDrift: stats.quotaDriftSeen
		},
		quota: quota ?? {
			available: false,
			reason: "not collected yet",
			fetchedAt: null
		},
		sessions: {
			tracked: stats.sessionsTracked,
			error: stats.sessionsError
		},
		ask: stats.ask,
		review: stats.review
	};
}
const name = "atomcode-bridge";
const inject = ["tools", "webServer"];
/**
* Hard deadline for the daemon's liveness and metadata probes. Loopback
* answers in single-digit milliseconds when healthy, so real elapsed time
* here means the daemon is wedged half-open. Every other wait in this plugin
* has a budget (`runCommand`'s internal timeout, `streamChat`'s timeoutMs,
* the review wall-clock fuse, the panel's client-side deadline) — the two
* calls that decide whether the daemon is alive AT ALL were the only ones
* without one, which left `daemon_start_timeout_secs` (a budget built on
* "each poll fails fast") silently ineffective in exactly the wedged state
* it was configured for.
*/
const DAEMON_PROBE_TIMEOUT_MS = 5e3;
/**
* Budget for the quota `POST /command status` call — the one daemon call that
* runs on the PANEL's schedule (every `quota_refresh_secs`) rather than the
* ask path's. Selected under the panel's client deadline so both sides agree
* on "the daemon is wedged" at roughly the same moment; see `readQuota`.
*/
const DAEMON_COMMAND_TIMEOUT_MS = 3500;
const DEFAULT_APPROVAL_MODE = "bypass";
const DEFAULT_ASK_MAX_ROUNDS = 25;
/**
* Config arrives unvalidated from the Loader patch (the sibling bridge
* `dsh-connect-sensenova-token-plan` ships no DSH Config schema either);
* each field is defaulted and type-guarded here so a malformed row
* degrades to safe defaults instead of failing the mount. Recognized keys:
*   port (13459) · auto_start (true) · binary ('') · approval_mode ('bypass')
*   default_provider ('' = AtomCode's own default, ASK path) ·
*   review_default_provider ('' = auto-select, REVIEW path)
*   working_dir ('') · state_path ('') · review_no_web (true)
*   review_max_rounds (35) · review_max_duration_secs (900)
*   ask_max_rounds (25 = bounded default; 0 = unlimited)
*   session_key_prefix ('' = auto-detect) · daemon_retry_secs (60)
*/
function readConfig(rawConfig) {
	const config = {};
	for (const [key, value] of Object.entries(rawConfig ?? {})) config[key] = value && typeof value.get === "function" ? value.get() : value;
	const port = Number.isInteger(config.port) && config.port > 0 && config.port <= 65535 ? config.port : DEFAULT_PORT;
	const autoStart = config.auto_start !== false;
	const binary = typeof config.binary === "string" && config.binary !== "" ? config.binary : void 0;
	const approvalMode = typeof config.approval_mode === "string" && config.approval_mode !== "" ? config.approval_mode : DEFAULT_APPROVAL_MODE;
	const defaultWorkingDir = typeof config.working_dir === "string" && config.working_dir !== "" ? config.working_dir : void 0;
	const authoredApprovalMode = approvalMode !== DEFAULT_APPROVAL_MODE;
	const authoredWorkingDir = defaultWorkingDir !== void 0;
	const defaultProvider = typeof config.default_provider === "string" && config.default_provider.trim() !== "" ? config.default_provider.trim() : void 0;
	const reviewDefaultProvider = typeof config.review_default_provider === "string" && config.review_default_provider.trim() !== "" ? config.review_default_provider.trim() : void 0;
	const askMaxRounds = Number.isInteger(config.ask_max_rounds) && config.ask_max_rounds >= 0 ? config.ask_max_rounds : DEFAULT_ASK_MAX_ROUNDS;
	const authoredAskMaxRounds = askMaxRounds !== DEFAULT_ASK_MAX_ROUNDS;
	const configuredPrefix = typeof config.session_key_prefix === "string" && config.session_key_prefix.trim() !== "" ? config.session_key_prefix.trim() : "";
	const sessionKeyPrefix = configuredPrefix || detectProfileKey();
	const sessionKeyPrefixSource = configuredPrefix !== "" ? "config" : sessionKeyPrefix !== "" ? "profile" : "none";
	const statePath = typeof config.state_path === "string" && config.state_path !== "" ? config.state_path : defaultStatePath();
	const reviewWorkingDir = typeof config.review_working_dir === "string" && config.review_working_dir !== "" ? config.review_working_dir : void 0;
	const reviewNoWeb = config.review_no_web !== false;
	const reviewMaxRounds = Number.isInteger(config.review_max_rounds) && config.review_max_rounds > 0 ? config.review_max_rounds : 35;
	const reviewMaxDurationSecs = Number.isInteger(config.review_max_duration_secs) && config.review_max_duration_secs > 0 ? config.review_max_duration_secs : 900;
	const quotaRefreshSecs = Number.isInteger(config.quota_refresh_secs) && config.quota_refresh_secs >= 0 ? config.quota_refresh_secs : 60;
	const daemonStartTimeoutSecs = Number.isInteger(config.daemon_start_timeout_secs) && config.daemon_start_timeout_secs >= 0 ? config.daemon_start_timeout_secs : 30;
	return {
		port,
		autoStart,
		binary,
		approvalMode,
		defaultWorkingDir,
		defaultProvider,
		reviewDefaultProvider,
		askMaxRounds,
		authoredApprovalMode,
		authoredWorkingDir,
		authoredAskMaxRounds,
		sessionKeyPrefix,
		sessionKeyPrefixSource,
		statePath,
		reviewWorkingDir,
		reviewNoWeb,
		reviewMaxRounds,
		reviewMaxDurationSecs,
		quotaRefreshSecs,
		daemonStartTimeoutSecs,
		daemonStartAttempts: Math.max(0, Math.ceil(daemonStartTimeoutSecs * 1e3 / 1500)),
		daemonRetrySecs: Number.isInteger(config.daemon_retry_secs) && config.daemon_retry_secs >= 0 ? config.daemon_retry_secs : 60,
		binaryEnv: typeof process.env.ATOMCODE_BIN === "string" && process.env.ATOMCODE_BIN !== "" ? process.env.ATOMCODE_BIN : void 0
	};
}
/**
* Everything the plugin accumulates while it is mounted, in one object.
*
* This block used to be declared inline in `apply()`, ~420 lines of closures.
* Length was the lesser problem:
*
*  - A closure is an INVISIBLE dependency. Six of these functions write the
*    same `stats` bag, and the rest of `apply()` could read any of them with no
*    parameter in sight. The bag is `Record<string, any>`, so the type system
*    had nothing to say about those writes either.
*  - The declaration ORDER encoding a real constraint was recorded only in a
*    comment: the session store's error observer writes `stats.sessionsError`,
*    so the store must not fire it before the bag exists. It is safe today
*    because the observer can only run from get/set/drop/count, all of which
*    happen long after the mount — see the note at the store below.
*
* Nothing here is a behaviour change: same code, same order, moved. Whether the
* observer should keep leaning on that ordering is a separate question, and a
* separate commit.
*
* @param {{ config: Record<string, any>, log: (message: any) => void }} deps
*/
function createRuntime({ config, log }) {
	const { port, autoStart, binary, approvalMode, defaultWorkingDir, defaultProvider, reviewDefaultProvider, askMaxRounds, authoredApprovalMode, authoredWorkingDir, authoredAskMaxRounds, sessionKeyPrefix, statePath, reviewWorkingDir, quotaRefreshSecs, daemonStartAttempts, daemonRetrySecs, binaryEnv } = config;
	const sessions = createSessionStore(statePath, sessionKeyPrefix, { onError: (error) => {
		stats.sessionsError = error;
		if (error) log(`会话续接已降级（本轮回复不受影响）：${error}`);
	} });
	const providerStore = createProviderStore(join(dirname(statePath), "provider.json"));
	/**
	* The store is total by design (never throws). A throw here means something
	* moved under us (the state dir was swapped mid-run); that must not take a tool
	* call down, so it degrades to "no panel pick" AND names itself in the log —
	* silence would read as "the user never chose anything" (红线 3).
	*/
	const readProviderPicks = () => {
		try {
			return providerStore.read();
		} catch (error) {
			const reason = String(error && error.message ? error.message : error);
			log(`provider state read failed, ignoring the panel pick: ${reason}`);
			return {
				ask: null,
				review: null,
				foreignVersion: false,
				error: reason
			};
		}
	};
	/**
	* One place answers "which provider does this call use, and why", for BOTH
	* slots with the same ladder:
	*
	*   per-call `provider` argument > the panel pick (provider.json) >
	*   the mount-time patch field > AtomCode's own default (send nothing).
	*
	* The panel outranks the patch field deliberately: the patch row is a static
	* default for people who edit files, while the pick is a click the user just
	* made, and a click that silently loses to a line in a config file is the kind
	* of dead control this repo refuses to ship. `source` is reported to the panel
	* so the two can never be confused about which one won.
	*
	* This ladder is the ONLY one: the execute path calls it with the per-call
	* argument, and `refreshPanelState` calls it with none to answer "what will the
	* NEXT call use". They used to be two copies — one four rungs, one three — so
	* the panel could describe a rung (argument) its own snapshot never produced.
	*
	* @param {'ask'|'review'} slot
	* @param {unknown} argument - the per-call `provider` arg ('' = none).
	* @param {{ask:string|null, review:string|null}} [alreadyRead] - a pick set the
	*   caller already read, so one panel poll does not read the file twice.
	*/
	const resolveProvider = (slot, argument, alreadyRead) => {
		const arg = typeof argument === "string" && argument.trim() !== "" ? argument.trim() : "";
		const picks = alreadyRead || readProviderPicks();
		const panel = slot === "ask" ? picks.ask : picks.review;
		if (arg) return {
			name: arg,
			source: "argument",
			picks
		};
		if (panel) return {
			name: panel,
			source: "panel",
			picks
		};
		const configured = slot === "ask" ? defaultProvider : reviewDefaultProvider;
		if (configured) return {
			name: configured,
			source: "config",
			picks
		};
		return {
			name: "",
			source: slot === "ask" ? "atomcode" : "auto",
			picks
		};
	};
	const reviewProvision = checkReviewProvision();
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	/**
	* Live status snapshot, mirrored by the plugin detail-page client over the
	* read-only `/api/atomcode-bridge/stats` route. Counters accumulate for the
	* life of the plugin mount; `daemonUp`/`lastHealthAt` are refreshed on each
	* stats poll (5s cache) and on every ask dispatch.
	*/
	const stats = {
		startedAt: Date.now(),
		port,
		autoStart,
		binaryConfigured: !!binary,
		binaryEnv,
		approvalMode,
		defaultWorkingDir: defaultWorkingDir ?? null,
		reviewWorkingDir: reviewWorkingDir ?? null,
		defaultProvider: defaultProvider ?? null,
		reviewDefaultProvider: reviewDefaultProvider ?? null,
		panelProvider: {
			ask: null,
			review: null
		},
		panelStorePath: providerStore.path(),
		panelStoreError: "",
		panelStoreForeign: false,
		effectiveAsk: null,
		effectiveAskSource: "atomcode",
		effectiveReview: null,
		effectiveReviewSource: "auto",
		modelCatalog: null,
		modelCatalogAt: 0,
		modelCatalogError: "",
		reviewCatalog: reviewProvision.providers || [],
		reviewEndpoints: reviewProvision.endpoints || {},
		daemonUp: false,
		daemonVersion: "",
		spawnTried: false,
		spawnAttempts: 0,
		spawnFailures: 0,
		lastSpawnAt: 0,
		daemonStarting: false,
		lastHealthAt: 0,
		reviewAvailable: reviewProvision.available,
		reviewReason: reviewProvision.reason,
		sessionsTracked: 0,
		sessionsError: "",
		askRounds: askMaxRounds,
		retrySecs: daemonRetrySecs,
		authored: {
			approvalMode: authoredApprovalMode,
			workingDir: authoredWorkingDir,
			askMaxRounds: authoredAskMaxRounds
		},
		defaults: {
			approvalMode: DEFAULT_APPROVAL_MODE,
			askMaxRounds: DEFAULT_ASK_MAX_ROUNDS
		},
		quotaDriftSeen: false,
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
	/** Refresh daemon liveness with a short cache (used by both ask + stats). */
	async function refreshHealth(force = false) {
		if (!force && Date.now() - stats.lastHealthAt < 5e3) return stats.daemonUp;
		try {
			const info = await healthInfo(port, AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS));
			stats.daemonUp = info.up;
			if (info.version && info.version !== stats.daemonVersion) {
				stats.daemonVersion = info.version;
				if (info.version && !/^5\./.test(info.version)) log(`unverified AtomCode daemon version ${info.version} — the bridged protocol was validated against 5.x`);
			}
		} catch {
			stats.daemonUp = false;
		}
		stats.lastHealthAt = Date.now();
		return stats.daemonUp;
	}
	/**
	* Spawn the daemon once and wait for it to answer.
	*
	* Shared and idempotent: the ask path awaits it, while the mount and the panel
	* poll only kick it off. Sharing one promise is what keeps a panel poll from
	* leaving a second daemon spawning behind the first.
	*
	* A FAILED start is not a tombstone: the promise is cleared and `spawnTried`
	* stays set (the panel can say "自动拉起失败"), but after `daemonRetrySecs`
	* the next caller tries again — so installing AtomCode after mount is picked
	* up instead of the auto-start being dead for the mount's lifetime.
	*
	* @returns {Promise<boolean>} whether a daemon answered within the start poll.
	*/
	let daemonStartPromise = null;
	function ensureDaemonStarted() {
		if (daemonStartPromise !== null) return daemonStartPromise;
		if (!autoStart) return Promise.resolve(false);
		if (stats.spawnTried && Date.now() - stats.lastSpawnAt < daemonRetrySecs * 1e3) return Promise.resolve(false);
		stats.daemonStarting = true;
		stats.spawnTried = true;
		stats.spawnAttempts += 1;
		stats.lastSpawnAt = Date.now();
		daemonStartPromise = (async () => {
			if (await refreshHealth()) return true;
			await spawnDaemon({
				port,
				...binary ? { binary } : {},
				...defaultWorkingDir ? { workingDir: defaultWorkingDir } : {},
				log
			});
			for (let i = 0; i < daemonStartAttempts; i++) {
				await sleep(1500);
				if (await refreshHealth(true)) return true;
			}
			return false;
		})().catch(() => false).finally(() => {
			stats.daemonStarting = false;
			if (stats.daemonUp === false) {
				daemonStartPromise = null;
				stats.spawnFailures += 1;
			}
		});
		return daemonStartPromise;
	}
	/** Resolves `false` as soon as `signal` aborts, so a caller can stop awaiting. */
	function waitForAbort(signal) {
		return new Promise((resolve) => {
			if (signal.aborted) resolve(false);
			else signal.addEventListener("abort", () => resolve(false), { once: true });
		});
	}
	/**
	* Daemon liveness, spawning on demand.
	*
	* `auto_start: true` means "the daemon is kept running", not "the first tool
	* call will start it": the mount and the stats route kick the spawn off
	* themselves, so the panel and the quota chip are live without the model
	* having to call a tool first.
	*
	* Do NOT await this from the mount or the stats route — the start poll can run
	* for 30s (20 × 1.5s) and would stall the plugin mount / the 5s panel poll.
	* Use `ensureDaemonStarted()` (fire-and-forget) there instead.
	*
	* @param {AbortSignal} [signal]
	*/
	async function ensureDaemon(signal) {
		if (signal?.aborted) return false;
		if (await refreshHealth()) return true;
		if (signal?.aborted) return false;
		if (daemonStartPromise !== null && !stats.daemonStarting) daemonStartPromise = null;
		const started = signal ? await Promise.race([ensureDaemonStarted(), waitForAbort(signal)]) : await ensureDaemonStarted();
		if (signal?.aborted) return false;
		return started === true ? true : refreshHealth(true);
	}
	/**
	* CodingPlan quota, read through the daemon's `status` command.
	*
	* Cached for `quota_refresh_secs` so the panel's 5s poll does not become a 5s
	* daemon call. The daemon requires a `working_dir` for ANY command, but the
	* CodingPlan/usage lines are account-level, so the configured default is used
	* and the home directory is the fallback (any existing directory will do).
	*
	* @returns {Promise<object>} the `quota` branch of the stats snapshot.
	*/
	let quotaCache = {
		at: 0,
		value: null
	};
	async function readQuota() {
		if (quotaRefreshSecs === 0) return {
			available: false,
			reason: "额度显示已关闭（quota_refresh_secs = 0）",
			fetchedAt: Date.now()
		};
		const now = Date.now();
		if (quotaCache.value !== null && now - quotaCache.at < quotaRefreshSecs * 1e3) return quotaCache.value;
		let value;
		if (!await refreshHealth()) {
			value = {
				available: false,
				reason: stats.daemonStarting ? "正在拉起 daemon…" : "daemon 未运行",
				fetchedAt: now
			};
			if (!stats.daemonStarting) quotaCache = {
				at: now,
				value
			};
			return value;
		}
		const result = await runCommand({
			port,
			command: "status",
			workingDir: defaultWorkingDir || homedir(),
			timeoutMs: DAEMON_COMMAND_TIMEOUT_MS
		});
		const outcome = result.ok === true || result.kind !== "transport" || !/abort|timeout/i.test(result.message || "") ? result : {
			...result,
			kind: "timeout",
			message: `daemon 未在 ${DAEMON_COMMAND_TIMEOUT_MS}ms 内应答 /command status（daemon 可能卡住）`
		};
		value = buildQuotaReport(outcome, Date.now());
		if (value.drift === true) {
			if (!stats.quotaDriftSeen) {
				stats.quotaDriftSeen = true;
				log("the daemon status text no longer matches any known quota shape (AtomCode may have been upgraded) — the panel will show the raw text");
			}
		} else stats.quotaDriftSeen = false;
		quotaCache = {
			at: now,
			value
		};
		return value;
	}
	/**
	* Refresh the panel-facing provider state: the stored picks, what the NEXT call
	* will actually use (and who decided that), and the review CLI's usable direct
	* entries. All synchronous and cheap — one small JSON read plus one config.toml
	* read.
	*
	* The review provision is re-read per poll (not frozen at mount) so a
	* `[providers.X]` added after mount shows up in the dropdown, matching what the
	* execute path already does.
	*/
	function refreshPanelState() {
		const picks = readProviderPicks();
		stats.panelProvider = {
			ask: picks.ask,
			review: picks.review
		};
		stats.panelStoreError = picks.error;
		stats.panelStoreForeign = picks.foreignVersion;
		const ask = resolveProvider("ask", "", picks);
		stats.effectiveAsk = ask.name || null;
		stats.effectiveAskSource = ask.source;
		const review = resolveProvider("review", "", picks);
		stats.effectiveReview = review.name || null;
		stats.effectiveReviewSource = review.source;
		const provision = checkReviewProvision();
		stats.reviewCatalog = provision.providers || [];
		stats.reviewEndpoints = provision.endpoints || {};
		stats.reviewAvailable = provision.available;
		stats.reviewReason = provision.reason;
	}
	/**
	* The daemon's model catalogue, feeding the ask dropdown.
	*
	* `GET /models` is metadata — no tokens, no quota — but the panel polls every
	* 5s, so it is cached for `MODEL_CATALOG_TTL_MS`. A FAILED fetch leaves the
	* catalogue null WITH a named reason, so the dropdown can say why there is
	* nothing to pick instead of rendering an empty select that reads as a broken
	* plugin (红线 3). The negative is deliberately NOT cached for the full TTL:
	* the moment the daemon answers, the next poll should show the list.
	*/
	const MODEL_CATALOG_TTL_MS = 3e4;
	async function refreshModelCatalog() {
		const now = Date.now();
		if (stats.modelCatalog !== null && now - stats.modelCatalogAt < MODEL_CATALOG_TTL_MS) return;
		if (!stats.daemonUp) {
			stats.modelCatalog = null;
			stats.modelCatalogAt = 0;
			stats.modelCatalogError = `daemon 未在线（127.0.0.1:${port} 未监听），列不出档位`;
			return;
		}
		try {
			const list = await listModels(port, AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS));
			stats.modelCatalog = Array.isArray(list) ? list.filter((m) => m && typeof m.provider === "string" && m.provider !== "").map((m) => ({
				provider: m.provider,
				isDefault: m.is_default === true
			})) : [];
			stats.modelCatalogAt = Date.now();
			stats.modelCatalogError = "";
		} catch (error) {
			const reason = String(error && error.message ? error.message : error);
			stats.modelCatalog = null;
			stats.modelCatalogAt = 0;
			stats.modelCatalogError = reason;
			log(`model catalog fetch failed: ${reason}`);
		}
	}
	return {
		stats,
		sessions,
		providerStore,
		resolveProvider,
		refreshHealth,
		ensureDaemonStarted,
		ensureDaemon,
		readQuota,
		refreshPanelState,
		refreshModelCatalog,
		reviewProvision
	};
}
function apply(ctx, rawConfig = {}) {
	const config = readConfig(rawConfig);
	const { port, autoStart, binary, approvalMode, defaultWorkingDir, defaultProvider, reviewDefaultProvider, askMaxRounds, sessionKeyPrefixSource, reviewWorkingDir, reviewNoWeb, reviewMaxRounds, reviewMaxDurationSecs } = config;
	const log = (message) => ctx.logger?.warn(`[atomcode-bridge] ${message}`);
	if (sessionKeyPrefixSource === "none") log("无法判定 DSH profile（DSH_PROFILE 未设置，argv 里也没有 dsh 的 web/desktop 子命令）：sessions.json 将不带 profile 前缀。若本机同时跑 web 与 desktop，两侧的会话续接会共用同一个键、互相串线——在插件配置里设 session_key_prefix 可消除歧义。");
	const { stats, sessions, providerStore, resolveProvider, refreshHealth, ensureDaemonStarted, ensureDaemon, readQuota, refreshPanelState, refreshModelCatalog, reviewProvision } = createRuntime({
		config,
		log
	});
	const providerHint = "换模型：provider 参数收的是 AtomCode 的模型档位名（daemon GET /models 里的 provider 字段，如 \"AtomGit-glm5.3-flash\"；不是裸模型 id \"glm5.3-flash\"）。优先级：本参数 > 详情页面板上选的档位 > 插件配置 default_provider" + (defaultProvider ? `（当前 default_provider="${defaultProvider}"）` : "（当前未配 default_provider）") + " > AtomCode 自己的默认档位；返回里的 provider= 是 daemon 报的真实生效值。";
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	const disposeAsk = tools.register({
		name: "atomcode_ask",
		description: "把一条消息转发给本机 AtomCode（终端 AI 编程助手，官方二进制）的 daemon 执行一个完整自主回合（它自带工具循环，approval_mode 默认 bypass 无人值守放行），取回整轮回复。用于\"帮我问 AtomCode / 让 AtomCode 处理 / 侧边咨询\"场景；拿到结果后把 reply 转达给用户。continue=true 接续本工作目录上一次侧边对话（自动恢复 session，无需记 id）；默认开新线。续线接到死会话时用 reset_session=true 重新开线。整回合可能数分钟。" + providerHint,
		timeoutMs: 18e5,
		parameters: {
			type: "object",
			properties: {
				message: {
					type: "string",
					description: "转发给 AtomCode 的消息（通常是用户最新一句话的原文）"
				},
				continue: {
					type: "boolean",
					description: "可选：接续本工作目录上一次侧边对话（默认 false，开新会话）。注意：会话按 working_dir 记忆，同一仓库的两次不相干对话会共用同一条侧边线"
				},
				session_id: {
					type: "string",
					description: "可选：显式接续某个 AtomCode 会话（优先于 continue）"
				},
				reset_session: {
					type: "boolean",
					description: "可选：清掉本工作目录记录的侧边会话（续线接到一条已过期的 daemon 会话、或想彻底开新线时用；不影响本回合）"
				},
				provider: {
					type: "string",
					description: "可选：点名 AtomCode 模型档位，传它就换本次回合用的模型。名字以 daemon GET /models 的 provider 字段为准（如 \"AtomGit-glm5.3-flash\"），不要传裸模型 id（\"glm5.3-flash\"）。留空时按顺序取：面板上选的档位 → 插件配置 default_provider → AtomCode 自己的默认"
				},
				working_dir: {
					type: "string",
					description: "可选：回合的工作目录，同时是侧边对话的会话键；缺省用插件配置"
				},
				timeout_secs: {
					type: "number",
					description: "可选：整回合超时秒数，默认 1800"
				},
				max_rounds: {
					type: "number",
					description: "可选：工具调用轮数上限（按 daemon SSE 的 tool_start 事件计数；一次 agent 回合可能含多次并行工具调用，故事件数 ≤ agent 轮数。默认取插件配置，当前 25；传 0 关掉本端熔断，交回 daemon 自带治理）。超限只中止本端等待并返回错误，不保证停掉 daemon 侧回合"
				}
			},
			required: ["message"]
		},
		output: {
			schema: {
				type: "object",
				properties: {
					ok: { type: "boolean" },
					reply: { type: "string" },
					session_id: { type: "string" },
					continued: { type: "boolean" },
					truncated: {
						type: "boolean",
						description: "reply 超过上限被截断（截断处有标记；让 AtomCode 把长内容落盘再读，别只靠这一份摘要）"
					},
					tokens: { type: "number" },
					tool_calls: { type: "number" },
					round_count: {
						type: "number",
						description: "本回合 tool_start 事件数（≤ agent 轮数；并行工具会多次计数）"
					},
					tools: {
						type: "array",
						description: `本回合的工具记录，最多 ${30} 条（超出部分被省略，见 tools_truncated；tool_calls 仍是真实总数）`,
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								success: { type: "boolean" }
							},
							required: ["name", "success"],
							additionalProperties: false
						}
					},
					tools_truncated: {
						type: "boolean",
						description: "tools 数组被截断（只回了前若干条；tool_calls 是真实总数，不代表 tools 就是全部）"
					},
					stop_reason: { type: "string" },
					provider: { type: "string" },
					providerReported: {
						type: "boolean",
						description: "provider 是否来自 daemon SSE 的 runtime_info（true = 远端实测值；false = daemon 未报，回显本插件请求值、未经远端证实——daemon 升级后若不再发 runtime_info，每回合都会带 false 并标注）"
					},
					error: { type: "string" }
				},
				required: [
					"ok",
					"reply",
					"session_id",
					"continued",
					"truncated",
					"tokens",
					"tool_calls",
					"tools",
					"tools_truncated",
					"stop_reason",
					"provider",
					"providerReported",
					"error"
				],
				additionalProperties: false
			},
			render(_args, value) {
				const lines = [];
				if (value.ok) {
					lines.push(value.continued ? "AtomCode 接续回复（侧边对话）:" : "AtomCode 回复:", value.reply || "(空回复)", "");
					if (value.error) lines.push(`[注意：本回合收到 done 但流中带有 error 事件，回复可能残缺: ${value.error}]`, "");
					if (value.truncated) lines.push("[注意：reply 已截断，让 AtomCode 把完整内容写到文件里再读]", "");
					if (value.tools_truncated) lines.push(`[注意：tools 只回了前 ${30} 条，本回合工具调用不止这些（见 tool_calls）]`, "");
					if (value.providerReported === false) lines.push("[注意：daemon 未报 runtime_info，provider= 是本插件回传请求值、未经远端证实（daemon 可能已升级）]", "");
					const meta = [];
					meta.push(`session_id=${value.session_id}`);
					meta.push(`tokens=${value.tokens}`);
					if (value.round_count != null && value.round_count > 0) meta.push(`rounds=${value.round_count}`);
					meta.push(`tool_calls=${value.tool_calls}`);
					meta.push(`stop_reason=${value.stop_reason}`);
					meta.push(`provider=${value.provider}`);
					lines.push(`[${meta.join(" ")}]`);
				} else lines.push(`AtomCode 调用失败: ${value.error}`);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args, exec) {
			const askProvider = resolveProvider("ask", args.provider).name;
			const empty = (error) => ({
				ok: false,
				reply: "",
				session_id: "",
				continued: false,
				truncated: false,
				tokens: 0,
				tool_calls: 0,
				round_count: 0,
				tools: [],
				tools_truncated: false,
				stop_reason: "",
				provider: askProvider || "default",
				providerReported: false,
				error
			});
			const workDir = typeof args.working_dir === "string" && args.working_dir.trim() !== "" ? args.working_dir : defaultWorkingDir;
			const sessionKey = workDir ? resolve(workDir) : "default";
			let sessionId = typeof args.session_id === "string" && args.session_id.trim() !== "" ? args.session_id.trim() : args.continue === true ? sessions.get(sessionKey) : void 0;
			if (args.reset_session === true) {
				const pinned = typeof args.session_id === "string" && args.session_id.trim() !== "" ? args.session_id.trim() : void 0;
				sessions.drop(sessionKey);
				if (pinned) sessions.set(sessionKey, pinned);
				else if (args.continue === true) sessionId = void 0;
			}
			const continued = sessionId !== void 0;
			const t0 = Date.now();
			stats.ask.calls += 1;
			if (!await ensureDaemon(exec?.signal)) {
				stats.ask.err += 1;
				stats.ask.msTotal += Date.now() - t0;
				return empty(exec?.signal?.aborted ? "已取消：调用方在等待 AtomCode daemon 就绪期间中止了本次调用" : `AtomCode daemon 不可用（http://127.0.0.1:${port} 未监听${autoStart ? "，自动拉起也失败" : ""}）`);
			}
			const timeoutMs = Number.isFinite(args.timeout_secs) && args.timeout_secs > 0 ? Math.floor(args.timeout_secs) * 1e3 : 18e5;
			const maxRounds = Number.isFinite(args.max_rounds) && args.max_rounds >= 0 ? Math.floor(args.max_rounds) : askMaxRounds;
			const result = await askChat({
				message: String(args.message || ""),
				port,
				approvalMode,
				timeoutMs,
				maxRounds,
				...sessionId ? { sessionId } : {},
				...askProvider ? { provider: askProvider } : {},
				...workDir ? { workingDir: workDir } : {},
				...exec?.signal ? { signal: exec.signal } : {}
			});
			stats.ask.msTotal += Date.now() - t0;
			if (result.ok) {
				stats.ask.ok += 1;
				if (Number.isFinite(result.tokens)) stats.ask.tokens += result.tokens;
			} else stats.ask.err += 1;
			if (result.ok && result.sessionId) sessions.set(sessionKey, result.sessionId);
			const REPLY_CAP = 2e5;
			const truncated = result.reply.length > REPLY_CAP;
			const reply = truncated ? `${result.reply.slice(0, REPLY_CAP)}\n\n[truncated by dsh-atomcode-bridge: ${result.reply.length - REPLY_CAP} more characters; ask AtomCode to write the full text to a file and read that instead]` : result.reply;
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
				provider: result.provider,
				providerReported: result.providerReported,
				error: result.error
			};
		}
	});
	const reviewBaseDesc = "让本机 AtomCode（官方二进制）对一次代码变更做 one-shot 代码评审：默认评未提交改动；也可给 base 分支 / GitHub PR / diff 文本 / 自定义任务。有界的一次性 agent 运行（轮数 + 墙钟双保险丝，默认关 web 搜索），完成时 report 里是 CLI 的 --json 原始文本（findings JSON，可能夹带日志行），需自己读出结论并转达用户。注意 working_dir 缺省是插件配置的目录，插件也没配时是宿主进程的 cwd——评某个仓库务必显式传 working_dir。可能数分钟。";
	const reviewUsableProviders = reviewProvision.providers || [];
	const reviewProviderNote = reviewUsableProviders.length === 0 ? "" : `（本机可用的直连 provider：${reviewUsableProviders.join(" / ")}；provider 留空时按顺序取：详情页面板选的条目 → 插件配置 review_default_provider（当前${reviewDefaultProvider ? `="${reviewDefaultProvider}"` : "未配"}） → config.toml 的 default_provider → 唯一的可用直连条目自动顶上；只有前面几档都没配上、而本机又存在多个可用直连条目时才会要求你点名，不会替你猜计费通道）`;
	const reviewDesc = reviewProvision.available ? reviewBaseDesc + reviewProviderNote : `注意：本机 AtomCode 配置下 review CLI 不可用（${reviewProvision.reason}），只能走 daemon 侧的 atomcode_ask 做侧边咨询或让 AtomCode 评审。让本机 AtomCode（官方二进制）对一次代码变更做 one-shot 代码评审：默认评未提交改动；也可给 base 分支 / GitHub PR / diff 文本 / 自定义任务。有界的一次性 agent 运行（轮数 + 墙钟双保险丝，默认关 web 搜索），完成时 report 里是 CLI 的 --json 原始文本（findings JSON，可能夹带日志行），需自己读出结论并转达用户。注意 working_dir 缺省是插件配置的目录，插件也没配时是宿主进程的 cwd——评某个仓库务必显式传 working_dir。可能数分钟。`;
	const disposeReview = tools.register({
		name: "atomcode_review",
		timeoutMs: 18e5,
		description: reviewDesc,
		parameters: {
			type: "object",
			properties: {
				working_dir: {
					type: "string",
					description: "仓库根目录（--repo）。必填（或用插件配置的 review_working_dir）——不传会报错而不是悄悄评错仓库"
				},
				task: {
					type: "string",
					description: "可选：自定义任务文本，替代 diff 评审（问题/目标代码/上下文都写进来）"
				},
				base: {
					type: "string",
					description: "可选：base git ref，评审 <base>...HEAD；缺省评未提交改动"
				},
				staged: {
					type: "boolean",
					description: "可选：只评已暂存改动（git diff --staged）"
				},
				pr: {
					type: "number",
					description: "可选：GitHub PR 号（需本机 gh CLI）"
				},
				diff_text: {
					type: "string",
					description: "可选：原始 diff 文本（写临时文件走 --diff-file；适合非 git 场景/CI 产物）"
				},
				provider: {
					type: "string",
					description: "可选：点名 AtomCode provider，原样透传给 review CLI 的 --provider。名字以 ~/.atomcode/config.toml 的 [providers.<name>] 条目为准（这条路径不看 daemon /models，也不是裸模型 id——别传 \"glm5.3-flash\"）；要换该 provider 用的模型，改它条目里的 model。留空时按顺序取：面板上选的条目 → 插件配置 review_default_provider → config.toml 的 default_provider → 自动选择（见工具描述）"
				},
				max_rounds: {
					type: "number",
					description: "可选：评审 agent 轮数保险丝（默认取插件配置，通常 35）"
				},
				max_duration_secs: {
					type: "number",
					description: "可选：墙钟保险丝秒数（默认取插件配置，通常 900）。有效上限约 1740s——进程级兜底取 maxDuration+60s，超过宿主 30min 工具超时就会先被宿主杀掉"
				},
				enable_web: {
					type: "boolean",
					description: "可选：允许评审用 web_search（默认 false，适配受限网络）"
				}
			},
			required: []
		},
		output: {
			schema: {
				type: "object",
				properties: {
					ok: { type: "boolean" },
					report: { type: "string" },
					truncated: {
						type: "boolean",
						description: "report 超过上限被截断（findings 原文不完整，必要时改用 task 缩小范围）"
					},
					error: { type: "string" },
					exit_code: {
						type: "number",
						description: "进程退出码；-1 = 未能启动，或被信号终止（超时/取消）。两种含义共用 -1（被信号杀时真实 code 为 null），具体原因看 error"
					},
					duration_ms: { type: "number" }
				},
				required: [
					"ok",
					"report",
					"truncated",
					"error",
					"exit_code",
					"duration_ms"
				],
				additionalProperties: false
			},
			render(_args, value) {
				const lines = [];
				if (value.ok) {
					lines.push(`AtomCode 评审完成（${Math.round(value.duration_ms / 1e3)}s）:`, value.report || "(空 findings)");
					if (value.truncated) lines.push("[注意：findings 已截断，末尾内容不完整]");
				} else {
					lines.push(`AtomCode 评审失败: ${value.error}`);
					if (value.report) lines.push("--- 部分输出 ---", value.report.slice(0, 5e3));
				}
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args, exec) {
			const workDir = typeof args.working_dir === "string" && args.working_dir.trim() !== "" ? args.working_dir : reviewWorkingDir;
			if (!workDir) {
				stats.review.calls += 1;
				stats.review.err += 1;
				return {
					ok: false,
					report: "",
					truncated: false,
					error: "atomcode_review needs a repository: pass working_dir (<repo root>), or set the plugin config `review_working_dir`. Falling back to the host process cwd would review the wrong tree (or nothing) while reporting success.",
					exit_code: -1,
					duration_ms: 0
				};
			}
			const currentProvision = checkReviewProvision();
			if (!currentProvision.available) {
				stats.review.calls += 1;
				stats.review.err += 1;
				return {
					ok: false,
					report: "",
					truncated: false,
					error: `atomcode_review is unavailable on this host: ${currentProvision.reason} Use atomcode_ask instead (the daemon carries the AtomGit gateway signing). If this looks wrong, fix ~/.atomcode/config.toml and retry — this check re-reads it on every call.`,
					exit_code: -1,
					duration_ms: 0
				};
			}
			const selection = selectReviewProvider(resolveProvider("review", args.provider).name);
			if (selection.error) {
				stats.review.calls += 1;
				stats.review.err += 1;
				return {
					ok: false,
					report: "",
					truncated: false,
					error: `atomcode_review: ${selection.error}`,
					exit_code: -1,
					duration_ms: 0
				};
			}
			if (selection.auto) log(`review provider auto-selected: ${selection.provider} — ${selection.reason}`);
			if (selection.baseUrl && isLoopbackBaseUrl(selection.baseUrl)) {
				const probe = await probeLocalEndpoint(selection.baseUrl);
				if (!probe.alive) {
					stats.review.calls += 1;
					stats.review.err += 1;
					return {
						ok: false,
						report: "",
						truncated: false,
						error: `atomcode_review: local provider endpoint ${selection.baseUrl} (provider "${selection.provider}") is not responding (${probe.detail}; tried ${probe.tried.join(", ") || "no URL"}). It looks like a local OpenAI-compatible sidecar — start it (e.g. run \`atomcode-open-api\`) or point the provider at a live base_url in ~/.atomcode/config.toml. Daemon-side atomcode_ask is unaffected (it does not go through this endpoint).`,
						exit_code: -1,
						duration_ms: 0
					};
				}
			}
			const maxRounds = Number.isFinite(args.max_rounds) && args.max_rounds > 0 ? Math.floor(args.max_rounds) : reviewMaxRounds;
			const maxDurationSecs = Number.isFinite(args.max_duration_secs) && args.max_duration_secs > 0 ? Math.floor(args.max_duration_secs) : reviewMaxDurationSecs;
			const t0 = Date.now();
			stats.review.calls += 1;
			const result = await runReview({
				workingDir: workDir,
				...typeof args.task === "string" && args.task.trim() !== "" ? { task: args.task } : {},
				...typeof args.base === "string" && args.base.trim() !== "" ? { base: args.base } : {},
				...args.staged === true ? { staged: true } : {},
				...Number.isFinite(args.pr) && args.pr > 0 ? { pr: args.pr } : {},
				...typeof args.diff_text === "string" && args.diff_text.trim() !== "" ? { diffText: args.diff_text } : {},
				...selection.provider ? { provider: selection.provider } : {},
				maxRounds,
				maxDurationSecs,
				timeoutMs: (maxDurationSecs + 60) * 1e3,
				noWeb: args.enable_web === true ? false : reviewNoWeb,
				...binary ? { binary } : {},
				...exec?.signal ? { signal: exec.signal } : {},
				log
			});
			stats.review.msTotal += Date.now() - t0;
			if (result.ok) stats.review.ok += 1;
			else stats.review.err += 1;
			const REPORT_CAP = 2e5;
			const truncated = result.report.length > REPORT_CAP;
			return {
				ok: result.ok,
				report: truncated ? `${result.report.slice(0, REPORT_CAP)}\n\n[truncated by dsh-atomcode-bridge: ${result.report.length - REPORT_CAP} more characters]` : result.report,
				truncated,
				error: result.error,
				exit_code: result.exitCode ?? -1,
				duration_ms: result.durationMs
			};
		}
	});
	const webServer = ctx.get ? ctx.get("webServer") : ctx.webServer;
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
	const PROVIDER_BODY_LIMIT = 4096;
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
	ctx.effect(() => {
		return () => {
			disposeAsk();
			disposeReview();
			if (typeof disposeStats === "function") disposeStats();
			if (typeof disposeProvider === "function") disposeProvider();
		};
	});
}

//#endregion
export { apply, detectProfileKey, inject, name };