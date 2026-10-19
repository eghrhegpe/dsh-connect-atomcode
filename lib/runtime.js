import { codingPlanUsage, healthInfo, listModels, listSessions, readDaemonIdentity, runCommand, setReasoningEffort, spawnDaemon } from "./daemon.js";
import { createSessionStore } from "./sessions.js";
import { APPROVAL_MODES_TEXT, DAEMON_COMMAND_TIMEOUT_MS, DAEMON_PROBE_TIMEOUT_MS, DEFAULT_APPROVAL_MODE, DEFAULT_ASK_MAX_ROUNDS, DEFAULT_REVIEW_BRIEF_MODE, REVIEW_BRIEF_MODES } from "./config.js";
import { createProviderStore } from "./provider-store.js";
import { createPanelSettingsStore } from "./panel-settings-store.js";
import { createUsageStore } from "./usage-store.js";
import { buildQuotaReport } from "./quota.js";
import { parseUsageDaily, parseUsageSummary, summaryQuotaReport } from "./codingplan.js";
import { createStatsBag, describeDaemonDown } from "./stats.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

//#region src/host/runtime.ts
/**
* Host runtime — everything the plugin accumulates while it is mounted.
*
* Extracted from `src/host/index.ts` (apply() split). One object holds the live
* stats bag, the two state stores, daemon liveness + spawning, the quota cache
* and the panel-facing provider state; `apply()` hands this object to the two
* tool mounters and the route mounter so none of them re-declare closures.
*
* This block used to be declared inline in `apply()`, ~420 lines of closures.
* Length was the lesser problem:
*
*  - A closure is an INVISIBLE dependency. Several of these functions write the
*    same `stats` bag, and the rest of `apply()` could read any of them with no
*    parameter in sight. The BAG half of that is now closed — `StatsBag`
*    (stats.ts) types all forty-five field names, so the writes below are
*    checked — while the closure half is raised, not solved, by this file
*    existing: the readers are still implicit, they are simply now visible in
*    one screen instead of scattered across `apply()`.
*  - The declaration ORDER encoding a real constraint was recorded only in a
*    comment: the session store's error observer writes `stats.sessionsError`,
*    so the store must not fire it before the bag exists. That constraint is now
*    STRUCTURAL — `sessions` is constructed after `createStatsBag`, so no
*    rearrangement can reopen the window in which the observer runs before its
*    target exists. See the note at the store.
*
* Nothing here is a behaviour change: same code, same order, moved. Whether the
* observer should keep leaning on that ordering is a separate question, and a
* separate commit.
*
* @param {{ config: HostConfig, log: (message: any) => void }} deps
* @returns {Runtime} the mounted runtime.
* @module dsh-connect-atomcode/host/runtime
*/
/**
* Everything the plugin accumulates while it is mounted, in one object.
*
* @param {{ config: HostConfig, log: (message: any) => void, pluginVersion: string }} deps
*   `pluginVersion` is the hand-edited literal from the assembly point, passed
*   IN rather than written onto the bag afterwards (which is how it used to
*   arrive). A bag field that only exists once a caller remembers to graft it on
*   is the exact "invisible dependency" this file's header complains about, and
*   the type cannot require what the constructor does not ask for.
* @returns {Runtime}
*/
function createRuntime({ config, log, pluginVersion }) {
	const { port, autoStart, binary, approvalMode, approvalModeRejected, reviewBriefMode, reviewBriefModeRejected, defaultWorkingDir, defaultProvider, askMaxRounds, authoredApprovalMode, authoredWorkingDir, authoredAskMaxRounds, authoredReviewBriefMode, sessionKeyPrefix, statePath, quotaRefreshSecs, daemonStartAttempts, daemonRetrySecs, binaryEnv } = config;
	const panelSettingsStore = createPanelSettingsStore(join(dirname(statePath), "panel-settings.json"));
	const usageStore = createUsageStore(join(dirname(statePath), "usage.json"), (error) => {
		log(`用量累计已降级（本轮回复不受影响）：${error}`);
	});
	const persistedAsk = usageStore.read();
	/** Snapshot the live counters for the store (inFlight is host-only, never written). */
	const snapshotAskUsage = () => ({
		calls: stats.ask.calls,
		ok: stats.ask.ok,
		err: stats.ask.err,
		msTotal: stats.ask.msTotal,
		tokens: stats.ask.tokens
	});
	/**
	* One in-flight review per session.
	*
	* A review is a full autonomous agent turn that can run for minutes. Without
	* this guard, holding Enter on the composer would start N concurrent reviewers
	* on the same tree, each burning a real AtomCode turn. Keyed by session id,
	* because "one review per conversation" is the scope a human expects.
	*
	* It lives HERE rather than as a module-level set in `command.ts` so that
	* unmounting the plugin clears it: a module-level set survives a hot reload,
	* and a review abandoned mid-turn by a teardown would leave its session id
	* blocked forever — "already one AtomCode review running" with no review
	* running at all. `dispose()` below is the one place that releases it.
	*/
	const reviewInFlight = /* @__PURE__ */ new Set();
	const isReviewInFlight = (sessionId) => reviewInFlight.has(sessionId);
	const beginReview = (sessionId) => reviewInFlight.add(sessionId);
	const endReview = (sessionId) => reviewInFlight.delete(sessionId);
	/**
	* The panel settings store is total by design (never throws). A throw means the
	* state dir was swapped mid-run; it degrades to "no panel override" AND names
	* itself in the log (红线 3: silence reads as "the user never chose anything").
	*/
	const readPanelSettings = () => {
		try {
			return panelSettingsStore.read();
		} catch (error) {
			const reason = String(error && error.message ? error.message : error);
			log(`panel-settings state read failed, ignoring the override: ${reason}`);
			return {
				briefMode: null,
				workingDir: null,
				approvalMode: null,
				askMaxRounds: null,
				foreignVersion: false,
				error: reason
			};
		}
	};
	/**
	* Resolve the effective review brief mode: panel pick > mount-time patch field.
	* The panel pick is `null` when the user never chose one (or explicitly cleared
	* it), in which case the mount-time value (already defaulted by `readConfig`)
	* applies. This makes the panel a live override without touching the patch.
	*/
	const resolveBriefMode = () => {
		const settings = readPanelSettings();
		if (settings.briefMode !== null && settings.briefMode !== void 0) return {
			mode: settings.briefMode,
			source: "panel"
		};
		return {
			mode: reviewBriefMode,
			source: "config"
		};
	};
	/**
	* Resolve the effective default working directory: panel pick > mount-time
	* patch field. Returns `''` (falsy) when neither names one, so the caller's
	* "no directory → refuse" gate still fires.
	*/
	const resolveDefaultWorkingDir = () => {
		const settings = readPanelSettings();
		if (typeof settings.workingDir === "string" && settings.workingDir !== "") return settings.workingDir;
		return defaultWorkingDir || "";
	};
	/**
	* Resolve the effective approval mode: panel pick > mount-time patch field.
	*/
	const resolveApprovalMode = () => {
		const settings = readPanelSettings();
		if (settings.approvalMode !== null && settings.approvalMode !== void 0) return settings.approvalMode;
		return approvalMode;
	};
	/**
	* Resolve the effective ask max-rounds: panel pick > mount-time patch field.
	*/
	const resolveAskMaxRounds = () => {
		const settings = readPanelSettings();
		if (settings.askMaxRounds !== null && settings.askMaxRounds !== void 0) return settings.askMaxRounds;
		return askMaxRounds;
	};
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
				foreignVersion: false,
				error: reason
			};
		}
	};
	/**
	* One place answers "which provider does this call use, and why", for every
	* entry point with the same ladder:
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
	* @param {unknown} argument - the per-call `provider` arg ('' = none).
	* @param {{ask:string|null}} [alreadyRead] - a pick set the caller already
	*   read, so one panel poll does not read the file twice.
	*/
	const resolveProvider = (argument, alreadyRead) => {
		const arg = typeof argument === "string" && argument.trim() !== "" ? argument.trim() : "";
		const picks = alreadyRead || readProviderPicks();
		const panel = picks.ask;
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
		const configured = defaultProvider;
		if (configured) return {
			name: configured,
			source: "config",
			picks
		};
		return {
			name: "",
			source: "atomcode",
			picks
		};
	};
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	/**
	* Live status snapshot, mirrored by the plugin detail-page client over the
	* read-only `/api/atomcode-bridge/stats` route. Counters accumulate for the
	* life of the plugin mount; `daemonUp`/`lastHealthAt` are refreshed on each
	* stats poll (5s cache) and on every ask dispatch.
	*
	* The shape lives in `stats.ts` as `StatsBag`, and `createStatsBag` — the one
	* construction site — sits in the SAME file as `buildStatsBody`, its only
	* reader. This used to be a `Record<string, any>` declared right here: eight
	* closures wrote forty-five names into it and the type system had nothing to
	* say about any of those writes, so a renamed field was a silently empty
	* panel card instead of a compile error. See `StatsBag` for the full account;
	* every field this file writes below is now checked against its declaration.
	*/
	const stats = createStatsBag({
		pluginVersion,
		port,
		autoStart,
		binaryPath: binary ?? null,
		binaryEnv,
		approvalMode,
		approvalModeRejected,
		reviewBriefMode,
		reviewBriefModeRejected,
		defaultWorkingDir: defaultWorkingDir ?? null,
		defaultProvider: defaultProvider ?? null,
		panelStorePath: providerStore.path(),
		panelSettingsStorePath: panelSettingsStore.path(),
		askRounds: askMaxRounds,
		retrySecs: daemonRetrySecs,
		authored: {
			approvalMode: authoredApprovalMode,
			workingDir: authoredWorkingDir,
			askMaxRounds: authoredAskMaxRounds,
			reviewBriefMode: authoredReviewBriefMode
		},
		defaults: {
			approvalMode: DEFAULT_APPROVAL_MODE,
			askMaxRounds: 25,
			reviewBriefMode: DEFAULT_REVIEW_BRIEF_MODE
		},
		persistedAsk
	});
	if (approvalModeRejected !== null) log(`config.approval_mode「${approvalModeRejected}」不是 AtomCode 接受的取值（${APPROVAL_MODES_TEXT}）；已回落到 ${DEFAULT_APPROVAL_MODE}，面板的文件行会标明被拒的值`);
	if (reviewBriefModeRejected !== null) log(`config.review_brief_mode「${reviewBriefModeRejected}」不是本插件接受的取值（${REVIEW_BRIEF_MODES.join(" / ")}）；已回落到 ${DEFAULT_REVIEW_BRIEF_MODE}，面板的文件行会标明被拒的值`);
	const sessions = createSessionStore(statePath, sessionKeyPrefix, {
		onError: (error) => {
			stats.sessionsError = error;
			if (error) log(`会话续接已降级（本轮回复不受影响）：${error}`);
		},
		daemonIdentity: () => readDaemonIdentity(port)
	});
	/** Refresh daemon liveness with a short cache (used by both ask + stats). */
	async function refreshHealth(force = false) {
		if (!force && Date.now() - stats.lastHealthAt < 5e3) return stats.daemonUp;
		try {
			const info = await healthInfo(port, AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS));
			stats.daemonUp = info.up;
			stats.daemonDownReason = info.reason;
			if (info.version && info.version !== stats.daemonVersion) {
				stats.daemonVersion = info.version;
				if (info.version && !/^5\./.test(info.version)) log(`unverified AtomCode daemon version ${info.version} — the bridged protocol was validated against 5.x`);
			}
		} catch {
			stats.daemonUp = false;
			stats.daemonDownReason = "unreachable";
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
			let answered = false;
			for (let i = 0; i < daemonStartAttempts; i++) {
				await sleep(1500);
				if (await refreshHealth(true)) {
					answered = true;
					break;
				}
			}
			if (!answered && daemonStartAttempts === 0) answered = await refreshHealth(true);
			return answered;
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
	* CodingPlan quota.
	*
	* TWO sources, in order: the daemon's STRUCTURED `GET /codingplan/usage/summary`
	* (real numbers — see `codingplan.ts`) first, and the localized `status` text as
	* the fallback. The structured one is preferred because a number cannot drift
	* the way a sentence can; the text path stays because the structured endpoint
	* refuses to answer in exactly the state its named diagnosis was built for (an
	* expired plan makes it 502). Whichever ran is stamped on the reading
	* (`source` / `sourceNote`), so the panel can say a fallback is a fallback.
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
	/** The last structured-source failure we logged, so the log fires on CHANGE, not per poll. */
	let lastStructuredError = "";
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
				reason: stats.daemonStarting ? "正在拉起 daemon…" : describeDaemonDown(stats.daemonDownReason),
				fetchedAt: now
			};
			if (!stats.daemonStarting) quotaCache = {
				at: now,
				value
			};
			return value;
		}
		let structuredError = "";
		try {
			const payload = await codingPlanUsage(port, "/codingplan/usage/summary", AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS));
			const summary = parseUsageSummary(payload);
			if (summary === null) structuredError = "summary 响应里没有可读的套餐/窗口字段";
			else {
				if (lastStructuredError !== "") {
					lastStructuredError = "";
					log("CodingPlan 结构化额度接口恢复，读数改回 JSON 源");
				}
				stats.quotaDriftSeen = false;
				value = summaryQuotaReport(summary, Date.now());
				quotaCache = {
					at: now,
					value
				};
				return value;
			}
		} catch (error) {
			structuredError = String(error && error.message ? error.message : error);
		}
		if (structuredError !== lastStructuredError) {
			lastStructuredError = structuredError;
			log(`CodingPlan 结构化额度接口不可用（${structuredError}），额度改读 status 文本`);
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
		value = buildQuotaReport(outcome, Date.now(), `结构化额度接口不可用（${structuredError}），本读数来自 status 文本`);
		if (value.drift === true) {
			if (!stats.quotaDriftSeen) {
				stats.quotaDriftSeen = true;
				log(value.upstreamFailure ? `CodingPlan 额度上游不可用（${value.upstreamFailure.kind}）—— 面板将显示原始文本` : "the daemon status text no longer matches any known quota shape (AtomCode may have been upgraded) — the panel will show the raw text");
			}
		} else stats.quotaDriftSeen = false;
		if (!(outcome.kind === "timeout" || outcome.kind === "transport")) quotaCache = {
			at: now,
			value
		};
		return value;
	}
	/**
	* Refresh the panel-facing provider state: the stored pick, and what the NEXT
	* call will actually use (and who decided that). One small JSON read — no
	* subprocess.
	*
	* The `[providers.X]` advisory used to be re-read here too, so a direct entry
	* added after mount would show up in a second dropdown. That dropdown is gone
	* along with the CLI that needed those entries, so nothing here reads
	* `~/.atomcode/config.toml` any more.
	*/
	function refreshPanelState() {
		const picks = readProviderPicks();
		stats.panelProvider = picks.ask;
		stats.panelStoreError = picks.error;
		stats.panelStoreForeign = picks.foreignVersion;
		const ask = resolveProvider("", picks);
		stats.effectiveAsk = ask.name || null;
		stats.effectiveAskSource = ask.source;
		const panelSettings = readPanelSettings();
		stats.panelBriefMode = panelSettings.briefMode;
		stats.panelWorkingDir = panelSettings.workingDir;
		stats.panelApprovalMode = panelSettings.approvalMode;
		stats.panelAskMaxRounds = panelSettings.askMaxRounds;
		stats.panelSettingsError = panelSettings.error;
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
			stats.modelCatalogError = `daemon 未在线（127.0.0.1:${port}：${describeDaemonDown(stats.daemonDownReason)}），列不出档位`;
			return;
		}
		try {
			const list = await listModels(port, AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS));
			stats.modelCatalog = Array.isArray(list) ? list.filter((m) => m && typeof m.provider === "string" && m.provider !== "").map((m) => ({
				provider: m.provider,
				isDefault: m.is_default === true,
				effortLevels: Array.isArray(m.effort_levels) ? m.effort_levels : void 0,
				currentEffort: typeof m.reasoning_effort === "string" ? m.reasoning_effort : null
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
	/**
	* Per-day CodingPlan usage (`GET /codingplan/usage/daily`) — the trend card.
	*
	* Its own cadence, much slower than the quota's: history changes at most once a
	* minute, and the endpoint returns 60 days. Cached for `USAGE_TREND_TTL_MS`, and
	* a FAILURE is published as a named reason rather than an empty list (红线 3) and
	* deliberately NOT cached for the full TTL — the moment the daemon answers, the
	* next poll should show the history (same rule as the model catalogue).
	*
	* @returns {Promise<object>} the `usageTrend` branch of the stats snapshot.
	*/
	const USAGE_TREND_TTL_MS = 3e5;
	const USAGE_TREND_DAYS = 14;
	let usageTrendAt = 0;
	async function readUsageTrend() {
		const now = Date.now();
		if (quotaRefreshSecs === 0) {
			stats.usageTrend = {
				available: false,
				reason: "额度显示已关闭（quota_refresh_secs = 0）",
				fetchedAt: now
			};
			return stats.usageTrend;
		}
		if (stats.usageTrend !== null && now - usageTrendAt < USAGE_TREND_TTL_MS) return stats.usageTrend;
		if (!stats.daemonUp) {
			stats.usageTrend = {
				available: false,
				reason: `daemon 未在线（127.0.0.1:${port}：${describeDaemonDown(stats.daemonDownReason)}），读不出按天用量`,
				fetchedAt: now
			};
			usageTrendAt = 0;
			return stats.usageTrend;
		}
		try {
			const payload = await codingPlanUsage(port, "/codingplan/usage/daily", AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS));
			const daily = parseUsageDaily(payload, USAGE_TREND_DAYS);
			stats.usageTrend = daily === null ? {
				available: false,
				reason: "daily 响应里没有可用的按天记录",
				fetchedAt: now
			} : {
				available: true,
				reason: "",
				fetchedAt: now,
				...daily
			};
			usageTrendAt = daily === null ? 0 : now;
		} catch (error) {
			const reason = String(error && error.message ? error.message : error);
			stats.usageTrend = {
				available: false,
				reason: `按天用量读取失败：${reason}`,
				fetchedAt: now
			};
			usageTrendAt = 0;
		}
		return stats.usageTrend;
	}
	return {
		stats,
		sessions,
		providerStore,
		panelSettingsStore,
		readPanelSettings,
		resolveBriefMode,
		resolveDefaultWorkingDir,
		resolveApprovalMode,
		resolveAskMaxRounds,
		resolveProvider,
		refreshHealth,
		ensureDaemonStarted,
		ensureDaemon,
		readQuota,
		readUsageTrend,
		refreshPanelState,
		refreshModelCatalog,
		setReasoningEffort: (effort) => setReasoningEffort({
			port,
			effort
		}),
		/**
		* Write the ask counters back to `usage.json`. Called after each ask turn
		* (success, refusal and daemon-down alike — a refused turn is still a call).
		* Best-effort: a write failure must not fail a turn that already finished,
		* so it is logged and the in-memory count stands.
		*/
		persistAskUsage: () => {
			try {
				usageStore.write(snapshotAskUsage());
			} catch (error) {
				log(`用量累计写盘失败（内存计数仍生效）：${String(error && error.message ? error.message : error)}`);
			}
		},
		listSessions: () => listSessions(port),
		isReviewInFlight,
		beginReview,
		endReview,
		/**
		* Release everything this runtime accumulated while mounted. Called from the
		* plugin's teardown. Without it the review guard's session ids outlive the
		* mount and a hot-reloaded plugin refuses reviews that are no longer running.
		*/
		dispose: () => {
			reviewInFlight.clear();
		}
	};
}

//#endregion
export { createRuntime };