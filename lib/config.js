import { DEFAULT_PORT } from "./daemon.js";
import { defaultStatePath } from "./sessions.js";

//#region src/host/config.ts
/**
* Host config resolution — `readConfig` + the profile-key detector + the
* module-scope built-in constants.
*
* Extracted from `src/host/index.ts` so the God module is a thin assembly point.
* Nothing here has a runtime dependency beyond the default port and the default
* state path; every field is defaulted and type-guarded here so a malformed
* Loader patch row degrades to safe defaults instead of failing the mount.
*
* WHAT THIS FILE DOCUMENTS, AND WHAT IT DOES NOT: `cordis.patch.yml` is the
* field documentation of record — it carries what every knob means, what an
* empty value does, and which of the two paths each one feeds, and
* `test/wiring.test.mjs` guards that file. This module does NOT restate any of
* it. What belongs here is only the half the code alone can know: how a raw
* value is PARSED (why `0` is an answer rather than a missing value, why
* "authored" cannot be a key-presence test) and why each built-in constant is
* the number it is. A comment that repeats patch.yml is a second copy that
* starts lying the day the field moves.
*
* @module dsh-connect-atomcode/host/config
*/
/**
* Hard deadline for the liveness and metadata probes. Loopback answers in
* single-digit ms when healthy, so real elapsed time here means the daemon is
* wedged half-open. Without it, `daemon_start_timeout_secs` — a budget built on
* "each poll fails fast" — is ineffective in exactly the wedged state it was
* configured for.
*/
const DAEMON_PROBE_TIMEOUT_MS = 5e3;
/**
* Budget for the quota `POST /command status`, the one daemon call on the
* PANEL's schedule rather than the ask path's. Chosen under the panel's own
* client deadline so both sides call the daemon wedged at the same moment.
*/
const DAEMON_COMMAND_TIMEOUT_MS = 3500;
const DEFAULT_APPROVAL_MODE = "bypass";
const DEFAULT_ASK_MAX_ROUNDS = 25;
/**
* The tool timeout both `register()` calls declare to the DSH host, and the
* ceiling every wall-clock knob in this plugin answers to.
*
* It exists as a constant because the number used to be written out three
* times — twice as `30 * 60 * 1000` in the registrations and once as the ask
* default — while the parameter descriptions promised a cap the CODE never
* enforced: `timeout_secs: 1e9` produced a 1e12 ms wire budget that only the
* host's own guard could cut, and the caller got "已取消" where the description
* had promised a timeout. A knob whose limit lives in prose is a knob with no
* limit; the clamp below is that limit, in one place.
*/
const HOST_TOOL_TIMEOUT_MS = 18e5;
/** The same deadline in seconds — the unit every per-call knob speaks. */
const HOST_TOOL_TIMEOUT_SECS = HOST_TOOL_TIMEOUT_MS / 1e3;
/**
* Ceiling for every round-count knob (`max_rounds` on both tools, and the
* `ask_max_rounds` / `review_max_rounds` config fields behind them).
*
* A round budget is a FUSE, and a fuse you can switch off by inflating the
* number is not a fuse: `max_rounds: 1e9` used to pass every gate untouched,
* leaving only the 30-minute wall clock between an unattended daemon turn and
* the user's quota. Disabling the fuse is a deliberate WORD in this plugin —
* `0`, which both tools and both config fields honour — not a magnitude.
*
* 1000 tool events is far past any legitimate turn (the defaults are 25 and
* 35); the clamp is there for hallucinated arguments and inflation attempts,
* and it never rewrites a real budget downward.
*/
const MAX_ROUNDS_CEILING = 1e3;
/**
* Clamp one already-picked round budget to the ceiling. `0` — the deliberate
* "no fuse" word — passes through untouched.
*
* Exported separately from `resolveMaxRounds` because the CONFIG reader keeps
* its own stricter gate (integers only; a fractional `ask_max_rounds` is a
* typo, not 30.5 rounds) while the argument path floors whatever it is given.
* One clamp, two gates — the ceiling itself never gets a second copy.
*/
function clampMaxRounds(value) {
	if (value === 0) return 0;
	return Math.min(value, MAX_ROUNDS_CEILING);
}
/**
* Resolve one round-count knob — per-call argument first, configured default
* behind it — and CLAMP it to `MAX_ROUNDS_CEILING`. Lives here, next to the
* defaults and the ceiling, because the config reader and both tools' argument
* paths must answer with ONE policy: when this lived in `tools.ts`, the config
* values flowed to the panel unclamped and only the per-call arguments were
* bounded, so the panel could display a budget the code would never honour.
*
* This was also two hand-written predicates that read the same name
* differently: ask accepted `0` as "no fuse" while review read `0` as "unset,
* use 35". Both were defensible alone and each was explained by its own
* comment — and a model reading two JSON Schemas with one parameter name had
* no way to learn that `max_rounds: 0` meant opposite things depending on which
* tool it was calling. Three comments explaining a trap is worse than one
* function that cannot have it: `0` means "no round fuse" here, and each
* backend spells that in its own way (ask counts SSE events in-process and
* passes 0 through; review omits `--max-rounds`, which the CLI documents as
* UNLIMITED).
*
* An explicit `0` is therefore passed through UNTOUCHED by the clamp: it is the
* one deliberate way to hand governance back to the daemon/CLI, and clamping
* it into a number would turn a word into a lie.
*
* @param {unknown} raw - the per-call argument (`0` and up are honoured).
* @param {number} fallback - the configured default for the flanking tool.
* @returns {number} the round budget for this call, or 0 for "no fuse".
*/
function resolveMaxRounds(raw, fallback) {
	return clampMaxRounds(Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback);
}
/**
* Ceiling for `atomcode_review`'s wall-clock fuse (`max_duration_secs`).
*
* The process-level backstop waits `maxDuration + 60s`, so a duration above
* `HOST_TOOL_TIMEOUT_SECS - 60` pushes the backstop past the host's own 30min
* guard — the value then does not fail safe, it fails INVISIBLE: the host kills
* the call and the caller sees a cancel where the description promised the
* CLI's own fuse. Clamped so the fuse this plugin actually owns stays the
* binding one.
*/
const MAX_REVIEW_DURATION_SECS = 1740;
/**
* Read one wall-clock knob in seconds, clamped to `ceiling`.
*
* `0` and anything that cannot be a duration fall back to `fallback` — "no
* fuse" is not a word on this knob (unlike `max_rounds`), and the config
* reader already guarantees the fallback is a positive integer.
*
* @param {unknown} raw - the per-call argument.
* @param {number} fallback - the configured default.
* @param {number} ceiling - the largest value that still takes effect.
* @returns {number} the effective seconds for this call.
*/
function resolveDurationSecs(raw, fallback, ceiling) {
	return Math.min(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback, ceiling);
}
/**
* Which DSH profile this host process belongs to, as a key-space prefix.
*
* The prefix keeps two profiles (web + desktop) writing DISJOINT keys in the
* shared `sessions.json`. Without one they collide on the same `default::` key,
* and a `continue: true` in one profile resumes the OTHER profile's side
* conversation — a wrong-repo answer with no trace of why.
*
* Two detection rules are stricter than they look, and the bugs that made them
* so are recorded in `docs/DECISIONS.md`:
*
*  1. An explicit `DSH_PROFILE` is AUTHORITATIVE — it is not filtered through an
*     allowlist, because a legitimate value outside a guessed three-word set
*     used to be tossed and the answer fell through to a guess.
*  2. The argv fallback requires an actual `dsh` invocation AND the profile word
*     as its OWN argument, because a regex against the joined argv matched
*     inside unrelated strings (`/opt/dsh-tools/webpack.config.js` satisfied the
*     `web` branch). A WRONG prefix is worse than a missing one: it silently
*     merges or splits the wrong conversations.
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
* `dsh-connect-sensenova-token-plan` ships no DSH Config schema either), so
* every field is defaulted and type-guarded here and a malformed row degrades
* to safe defaults instead of failing the mount.
*
* The recognized keys and what each one means are documented ONCE, in
* `cordis.patch.yml` — read them there. The comments below cover only what
* PARSING does with a value: which inputs are honoured, which are impossible,
* and why a value that looks like "missing" sometimes is not.
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
	const askMaxRounds = clampMaxRounds(Number.isInteger(config.ask_max_rounds) && config.ask_max_rounds >= 0 ? config.ask_max_rounds : 25);
	const authoredAskMaxRounds = askMaxRounds !== 25;
	const configuredPrefix = typeof config.session_key_prefix === "string" && config.session_key_prefix.trim() !== "" ? config.session_key_prefix.trim() : "";
	const sessionKeyPrefix = configuredPrefix || detectProfileKey();
	const sessionKeyPrefixSource = configuredPrefix !== "" ? "config" : sessionKeyPrefix !== "" ? "profile" : "none";
	const statePath = typeof config.state_path === "string" && config.state_path !== "" ? config.state_path : defaultStatePath();
	const reviewWorkingDir = typeof config.review_working_dir === "string" && config.review_working_dir !== "" ? config.review_working_dir : void 0;
	const reviewNoWeb = config.review_no_web !== false;
	const reviewMaxRounds = clampMaxRounds(Number.isInteger(config.review_max_rounds) && config.review_max_rounds >= 0 ? config.review_max_rounds : 35);
	const reviewMaxDurationSecs = resolveDurationSecs(config.review_max_duration_secs, 900, MAX_REVIEW_DURATION_SECS);
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
export { DAEMON_COMMAND_TIMEOUT_MS, DAEMON_PROBE_TIMEOUT_MS, DEFAULT_APPROVAL_MODE, DEFAULT_ASK_MAX_ROUNDS, HOST_TOOL_TIMEOUT_MS, HOST_TOOL_TIMEOUT_SECS, MAX_REVIEW_DURATION_SECS, MAX_ROUNDS_CEILING, clampMaxRounds, detectProfileKey, readConfig, resolveDurationSecs, resolveMaxRounds };