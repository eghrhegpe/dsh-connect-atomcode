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
* The `approval_mode` values the daemon ACCEPTS — a closed enum measured, not
* assumed (`docs/AtomCode-CLI与daemon接口参考.md` §approval_mode; probe
* `scripts/probes/approval-mode.mjs`, 2026-10-17 against daemon 5.2.3, which
* enumerated it through the 422 parameter gate at zero quota).
*
* It is copied here because the daemon answers an unknown value with a 422 on
* EVERY `/chat` — a typo in the patch file used to survive untouched from
* `readConfig()` to the wire, so the first symptom was every ask turn failing
* with a daemon error instead of "this value is not one of the four". The copy
* is safe in the direction that matters: an enum that GROWS upstream is refused
* here and reported on the panel as a rejection (fail-visible, one boot), while
* a value the daemon would have 422'd is caught before it ever reaches a turn.
* When this list is ever widened, widen `test/stats-route.test.mjs` with it.
*/
const APPROVAL_MODES = [
	"build",
	"accept_edits",
	"bypass",
	"plan"
];
/** Human-readable list for the panel/log, derived so it can never drift from the enum above. */
const APPROVAL_MODES_TEXT = APPROVAL_MODES.join(" / ");
/**
* The closed set the review brief injection accepts — a plugin-side enum, not a
* daemon one, so no upstream 422 gate: it picks which prompt `runReviewCommand`
* and the `/atomcode-review` command send when the user text is empty.
*
* `always`     — the brief is sent on every review; non-empty user text is
*                appended after it (the pre-v1 behaviour, kept for scope-fanatics).
* `when-empty` — the brief is sent only when the user text is empty; non-empty
*                text goes through verbatim, without the brief (the shipped
*                default, 2026-10-18 — the user-facing ask: "打招呼" should not
*                trigger a six-round review).
* `never`      — the brief is never sent; the user text goes through verbatim,
*                and an empty text is refused by the caller (a review with no
*                target is a wasted turn, so it fails fast and visibly).
*
* A spelling outside the set is refused and the field falls back to the
* default; the raw spelling rides on `reviewBriefModeRejected`, mirroring
* `approvalModeRejected` — report what was actually refused, don't guess.
*/
const REVIEW_BRIEF_MODES = [
	"always",
	"when-empty",
	"never"
];
const DEFAULT_REVIEW_BRIEF_MODE = "when-empty";
/**
* The tool timeout the `register()` call declares to the DSH host, and the
* ceiling the per-call `timeout_secs` answers to.
*
* It exists as a constant because the number used to be written out three
* times — twice as `30 * 60 * 1000` in the registrations and once as the ask
* default — while the parameter descriptions promised a cap the CODE never
* enforced: `timeout_secs: 1e9` produced a 1e12 ms wire budget that only the
* host's own guard could cut, and the caller got "已取消" where the description
* had promised a timeout. A knob whose limit lives in prose is a knob with no
* limit; `tools.ts` clamps to this one number.
*/
const HOST_TOOL_TIMEOUT_MS = 18e5;
/** The same deadline in seconds — the unit every per-call knob speaks. */
const HOST_TOOL_TIMEOUT_SECS = HOST_TOOL_TIMEOUT_MS / 1e3;
/**
* How much PROSE one tool return may carry, in CHARACTERS.
*
* Characters, not tokens: this side never sees the model's tokenizer, and a
* character count is the one number that can be checked without one. It is a
* budget for what the MODEL reads (`render`), not for the wire.
*
* ONE constant for both tools, deliberately.
*
* It used to be two literals — `REPLY_CAP` in the ask path and `REPORT_CAP` in
* the review path, both `200_000` — plus `TOOLS_CAP` and `FINDINGS_CAP` for the
* two array limits: four numbers, no shared notion of "this turn's budget". The
* two review constants went away with the CLI path: `FINDINGS_CAP` bounded the
* `findings[]` document the review CLI returned (there is no such document any
* more — the daemon answers in prose), and the per-field split it was paired
* with is likewise gone, so this budget is spent once, across the whole return.
*
* The markers that announce a cut are one helper too (`capProse` in tools.ts):
* two truncations following two conventions is how a reader learns to trust one
* and miss the other.
*/
const OUTPUT_CAP = 2e5;
/**
* Ceiling for the one round-count knob (`ask_max_rounds`) and the per-call
* `max_rounds` argument, which every entry point reads through one clamp.
*
* A round budget is a FUSE, and a fuse you can switch off by inflating the
* number is not a fuse: `max_rounds: 1e9` used to pass every gate untouched,
* leaving only the 30-minute wall clock between an unattended daemon turn and
* the user's quota. Disabling the fuse is a deliberate WORD in this plugin —
* `0`, which both the field and the argument honour — not a magnitude.
*
* 1000 tool events is far past any legitimate turn (the default is 25); the
* clamp is there for hallucinated arguments and inflation attempts, and it
* never rewrites a real budget downward.
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
* Resolve the round-count knob — per-call argument first, configured default
* behind it — and CLAMP it to `MAX_ROUNDS_CEILING`. Lives here, next to the
* default and the ceiling, because the config reader and the argument path must
* answer with ONE policy: when this lived in `tools.ts`, the config value flowed
* to the panel unclamped and only the per-call argument was bounded, so the panel
* could display a budget the code would never honour.
*
* The `0` semantics are why this is one function and not two predicates. It used
* to be two, and the same parameter name meant opposite things depending on
* which tool a model called (ask read `0` as "no fuse", review as "unset, use
* 35"). One function cannot have that trap: `0` means "no round fuse" here, and
* `tools.ts` spells that by passing it through and counting nothing.
*
* An explicit `0` is therefore passed through UNTOUCHED by the clamp: it is the
* one deliberate way to hand governance back to the daemon, and clamping
* it into a number would turn a word into a lie.
*
* @param {unknown} raw - the per-call argument (`0` and up are honoured).
* @param {number} fallback - the configured default for the knob.
* @returns {number} the round budget for this call, or 0 for "no fuse".
*/
function resolveMaxRounds(raw, fallback) {
	return clampMaxRounds(Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback);
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
	const requestedApprovalMode = typeof config.approval_mode === "string" ? config.approval_mode.trim() : "";
	const approvalModeRejected = requestedApprovalMode !== "" && !APPROVAL_MODES.includes(requestedApprovalMode) ? requestedApprovalMode : null;
	const approvalMode = approvalModeRejected === null && requestedApprovalMode !== "" ? requestedApprovalMode : DEFAULT_APPROVAL_MODE;
	const requestedBriefMode = typeof config.review_brief_mode === "string" ? config.review_brief_mode.trim() : "";
	const reviewBriefModeRejected = requestedBriefMode !== "" && !REVIEW_BRIEF_MODES.includes(requestedBriefMode) ? requestedBriefMode : null;
	const reviewBriefMode = reviewBriefModeRejected === null && requestedBriefMode !== "" ? requestedBriefMode : DEFAULT_REVIEW_BRIEF_MODE;
	const authoredReviewBriefMode = reviewBriefMode !== DEFAULT_REVIEW_BRIEF_MODE;
	const defaultWorkingDir = typeof config.working_dir === "string" && config.working_dir !== "" ? config.working_dir : void 0;
	const authoredApprovalMode = approvalMode !== DEFAULT_APPROVAL_MODE;
	const authoredWorkingDir = defaultWorkingDir !== void 0;
	const defaultProvider = typeof config.default_provider === "string" && config.default_provider.trim() !== "" ? config.default_provider.trim() : void 0;
	const defaultReasoningEffort = typeof config.default_reasoning_effort === "string" && config.default_reasoning_effort.trim() !== "" ? config.default_reasoning_effort.trim() : void 0;
	const askMaxRounds = clampMaxRounds(Number.isInteger(config.ask_max_rounds) && config.ask_max_rounds >= 0 ? config.ask_max_rounds : 25);
	const authoredAskMaxRounds = askMaxRounds !== 25;
	const configuredPrefix = typeof config.session_key_prefix === "string" && config.session_key_prefix.trim() !== "" ? config.session_key_prefix.trim() : "";
	const sessionKeyPrefix = configuredPrefix || detectProfileKey();
	const sessionKeyPrefixSource = configuredPrefix !== "" ? "config" : sessionKeyPrefix !== "" ? "profile" : "none";
	const statePath = typeof config.state_path === "string" && config.state_path !== "" ? config.state_path : defaultStatePath();
	const quotaRefreshSecs = Number.isInteger(config.quota_refresh_secs) && config.quota_refresh_secs >= 0 ? config.quota_refresh_secs : 60;
	const daemonStartTimeoutSecs = Number.isInteger(config.daemon_start_timeout_secs) && config.daemon_start_timeout_secs >= 0 ? config.daemon_start_timeout_secs : 30;
	return {
		port,
		autoStart,
		binary,
		approvalMode,
		approvalModeRejected,
		reviewBriefMode,
		reviewBriefModeRejected,
		defaultWorkingDir,
		defaultProvider,
		defaultReasoningEffort,
		askMaxRounds,
		authoredApprovalMode,
		authoredWorkingDir,
		authoredAskMaxRounds,
		authoredReviewBriefMode,
		sessionKeyPrefix,
		sessionKeyPrefixSource,
		statePath,
		quotaRefreshSecs,
		daemonStartTimeoutSecs,
		daemonStartAttempts: Math.max(0, Math.ceil(daemonStartTimeoutSecs * 1e3 / 1500)),
		daemonRetrySecs: Number.isInteger(config.daemon_retry_secs) && config.daemon_retry_secs >= 0 ? config.daemon_retry_secs : 60,
		binaryEnv: typeof process.env.ATOMCODE_BIN === "string" && process.env.ATOMCODE_BIN !== "" ? process.env.ATOMCODE_BIN : void 0
	};
}

//#endregion
export { APPROVAL_MODES, APPROVAL_MODES_TEXT, DAEMON_COMMAND_TIMEOUT_MS, DAEMON_PROBE_TIMEOUT_MS, DEFAULT_APPROVAL_MODE, DEFAULT_ASK_MAX_ROUNDS, DEFAULT_REVIEW_BRIEF_MODE, HOST_TOOL_TIMEOUT_MS, HOST_TOOL_TIMEOUT_SECS, MAX_ROUNDS_CEILING, OUTPUT_CAP, REVIEW_BRIEF_MODES, clampMaxRounds, detectProfileKey, readConfig, resolveMaxRounds };