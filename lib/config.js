import { DEFAULT_PORT } from "./daemon.js";
import { defaultStatePath } from "./sessions.js";

//#region src/host/config.ts
/**
* Host config resolution — `readConfig` + the profile-key detector + the
* module-scope built-in constants.
*
* Extracted from `src/host/index.ts` (v0.4.3 split) so the God module is a
* thin assembly point. Nothing here has a runtime dependency beyond the
* default port and the default state path; every field is defaulted and
* type-guarded here so a malformed Loader patch row degrades to safe defaults
* instead of failing the mount.
*
* @module dsh-connect-atomcode/host/config
*/
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
/**
* Config arrives unvalidated from the Loader patch (the sibling bridge
* `dsh-connect-sensenova-token-plan` ships no DSH Config schema either);
* each field is defaulted and type-guarded here so a malformed row
* degrades to safe defaults instead of failing the mount. Recognized keys:
*   port (13459) · auto_start (true) · binary ('') · approval_mode ('bypass')
*   default_provider ('' = AtomCode's own default, ASK path) ·
*   review_default_provider ('' = auto-select, REVIEW path)
*   working_dir ('') · state_path ('') · review_no_web (true)
*   review_max_rounds (35; 0 = no round fuse, same as ask) ·
*   review_max_duration_secs (900)
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
	const askMaxRounds = Number.isInteger(config.ask_max_rounds) && config.ask_max_rounds >= 0 ? config.ask_max_rounds : 25;
	const authoredAskMaxRounds = askMaxRounds !== 25;
	const configuredPrefix = typeof config.session_key_prefix === "string" && config.session_key_prefix.trim() !== "" ? config.session_key_prefix.trim() : "";
	const sessionKeyPrefix = configuredPrefix || detectProfileKey();
	const sessionKeyPrefixSource = configuredPrefix !== "" ? "config" : sessionKeyPrefix !== "" ? "profile" : "none";
	const statePath = typeof config.state_path === "string" && config.state_path !== "" ? config.state_path : defaultStatePath();
	const reviewWorkingDir = typeof config.review_working_dir === "string" && config.review_working_dir !== "" ? config.review_working_dir : void 0;
	const reviewNoWeb = config.review_no_web !== false;
	const reviewMaxRounds = Number.isInteger(config.review_max_rounds) && config.review_max_rounds >= 0 ? config.review_max_rounds : 35;
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

//#endregion
export { DAEMON_COMMAND_TIMEOUT_MS, DAEMON_PROBE_TIMEOUT_MS, DEFAULT_APPROVAL_MODE, DEFAULT_ASK_MAX_ROUNDS, detectProfileKey, readConfig };