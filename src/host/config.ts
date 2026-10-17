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
import { DEFAULT_PORT } from './daemon.ts';
import { defaultStatePath } from './sessions.ts';

// ── Built-ins that take no input from the patch row ─────────────────────────
// Kept at module scope so `readConfig` stays a function of `rawConfig` alone.
// Field defaults live in `cordis.patch.yml`; these four are the ones the CODE
// needs a name for — the snapshot reports them, so the panel never keeps its
// own copy of "25".

/**
 * Hard deadline for the liveness and metadata probes. Loopback answers in
 * single-digit ms when healthy, so real elapsed time here means the daemon is
 * wedged half-open. Without it, `daemon_start_timeout_secs` — a budget built on
 * "each poll fails fast" — is ineffective in exactly the wedged state it was
 * configured for.
 */
export const DAEMON_PROBE_TIMEOUT_MS = 5_000;

/**
 * Budget for the quota `POST /command status`, the one daemon call on the
 * PANEL's schedule rather than the ask path's. Chosen under the panel's own
 * client deadline so both sides call the daemon wedged at the same moment.
 */
export const DAEMON_COMMAND_TIMEOUT_MS = 3_500;

export const DEFAULT_APPROVAL_MODE = 'bypass';
export const DEFAULT_ASK_MAX_ROUNDS = 25;

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
export const APPROVAL_MODES = ['build', 'accept_edits', 'bypass', 'plan'] as const;

/** Human-readable list for the panel/log, derived so it can never drift from the enum above. */
export const APPROVAL_MODES_TEXT = APPROVAL_MODES.join(' / ');

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
export const HOST_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
/** The same deadline in seconds — the unit every per-call knob speaks. */
export const HOST_TOOL_TIMEOUT_SECS = HOST_TOOL_TIMEOUT_MS / 1000;

/**
 * How much PROSE one tool return may carry, in CHARACTERS.
 *
 * Characters, not tokens: this side never sees the model's tokenizer, and a
 * character count is the one number that can be checked without one. It is a
 * budget for what the MODEL reads (`render`), not for the wire.
 *
 * ONE constant for both tools, deliberately. There used to be two literals —
 * `REPLY_CAP` in the ask path and `REPORT_CAP` in the review path, both
 * `200_000` — plus `TOOLS_CAP` and `FINDINGS_CAP` for the two array limits: four
 * numbers, no shared notion of "this turn's budget". And the review pair was
 * applied PER FIELD while the render prints the findings digest AND the raw
 * document, so a single return could carry roughly twice the intended budget. A
 * budget only some of the copies obey is not a budget — which is why the review
 * render now spends this constant across the whole return instead of per field.
 *
 * The markers that announce a cut are one helper too (`capProse` in tools.ts):
 * two truncations following two conventions is how a reader learns to trust one
 * and miss the other.
 */
export const OUTPUT_CAP = 200_000;

/**
 * The floor the review's raw document keeps even after the findings digest has
 * eaten into `OUTPUT_CAP`.
 *
 * Not zero: the digest normalizes severity/file/line/message, so a finding may
 * carry fields it drops, and a render that said "…the full text is below" while
 * printing none of it would be the silent amputation this budget exists to
 * prevent. The floor is also what makes the worst case a number someone can
 * hold — `OUTPUT_CAP + REVIEW_REPORT_FLOOR` — instead of a rule with an
 * exception nobody can size.
 */
export const REVIEW_REPORT_FLOOR = 20_000;

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
export const MAX_ROUNDS_CEILING = 1000;

/**
 * Clamp one already-picked round budget to the ceiling. `0` — the deliberate
 * "no fuse" word — passes through untouched.
 *
 * Exported separately from `resolveMaxRounds` because the CONFIG reader keeps
 * its own stricter gate (integers only; a fractional `ask_max_rounds` is a
 * typo, not 30.5 rounds) while the argument path floors whatever it is given.
 * One clamp, two gates — the ceiling itself never gets a second copy.
 */
export function clampMaxRounds(value: number): number {
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
export function resolveMaxRounds(raw: unknown, fallback: number): number {
  const picked = Number.isFinite(raw) && (raw as number) >= 0 ? Math.floor(raw as number) : fallback;
  return clampMaxRounds(picked);
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
export const MAX_REVIEW_DURATION_SECS = HOST_TOOL_TIMEOUT_SECS - 60;

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
export function resolveDurationSecs(raw: unknown, fallback: number, ceiling: number): number {
  const picked = Number.isFinite(raw) && (raw as number) > 0 ? Math.floor(raw as number) : fallback;
  return Math.min(picked, ceiling);
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
export function detectProfileKey(argv: string[] = process.argv) {
  const env = String(process.env.DSH_PROFILE || '').trim();
  if (env !== '') return env;
  const tokens = argv.slice(1).map((t) => String(t).trim().toLowerCase());
  // The profile word must be its OWN argument, and the invocation must actually
  // be `dsh` — otherwise `web` inside a configuration filename would win.
  const isDshInvocation = tokens.some((t) => /(^|[\\/])dsh(\.exe|\.cmd|\.bat|\.js)?$/.test(t));
  if (!isDshInvocation) return '';
  if (tokens.includes('desktop')) return 'desktop';
  if (tokens.includes('web')) return 'web';
  return '';
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
export function readConfig(rawConfig: Record<string, any>) {
  // The Loader hands config values through as `{ get() }` boxes; unwrap
  // first (same normalization dsh-connect-qoder performs).
  const config: Record<string, any> = {};
  for (const [key, value] of Object.entries(rawConfig ?? {})) {
    config[key] = value && typeof value.get === 'function' ? value.get() : value;
  }

  // A port outside 1..65535 can neither be listened on nor dialed; fall back to
  // the default rather than letting a typo drive a spawn against a nonsense port.
  const port =
    Number.isInteger(config.port) && config.port > 0 && config.port <= 65535
      ? config.port
      : DEFAULT_PORT;
  const autoStart = config.auto_start !== false;
  const binary = typeof config.binary === 'string' && config.binary !== '' ? config.binary : undefined;
  // `approval_mode` is a CLOSED enum upstream (APPROVAL_MODES) and the daemon
  // 422s anything else on every turn, so an off-enum value falls back to the
  // default HERE — and the rejected spelling is carried up (`approvalModeRejected`)
  // so the panel can name it instead of showing a legal-looking value the user
  // never chose. Rejecting silently would be the same fail-late bug one layer down.
  const requestedApprovalMode =
    typeof config.approval_mode === 'string' ? config.approval_mode.trim() : '';
  const approvalModeRejected =
    requestedApprovalMode !== '' && !(APPROVAL_MODES as readonly string[]).includes(requestedApprovalMode)
      ? requestedApprovalMode
      : null;
  const approvalMode = approvalModeRejected === null && requestedApprovalMode !== ''
    ? requestedApprovalMode
    : DEFAULT_APPROVAL_MODE;
  const defaultWorkingDir =
    typeof config.working_dir === 'string' && config.working_dir !== '' ? config.working_dir : undefined;
  // Whether each knob DEPARTS FROM the value this plugin ships in its own
  // `cordis.patch.yml`, which is the only question the panel can usefully answer.
  //
  // NOT "did the config object contain the key": the shipped patch writes EVERY key
  // explicitly (that is what a patch file is for — it is the field documentation of
  // record), so a key-presence test returns true on every install and the panel's
  // "（已改）" tag would fire on everything, which is the exact noise this feature was
  // built to remove. Measured live: a stock patch reported authored=true for
  // approval_mode / ask_max_rounds while the user had changed neither.
  // The ask-rounds knob is resolved below, so its flag is computed after it.
  const authoredApprovalMode = approvalMode !== DEFAULT_APPROVAL_MODE;
  const authoredWorkingDir = defaultWorkingDir !== undefined;
  // Two model knobs because there are two namespaces (红线 8): ask takes a daemon
  // model PROFILE, review takes a direct `[providers.<name>]` entry. What each
  // accepts — and what empty does — is documented in `cordis.patch.yml`.
  const defaultProvider =
    typeof config.default_provider === 'string' && config.default_provider.trim() !== ''
      ? config.default_provider.trim()
      : undefined;
  // Fills `selectReviewProvider()`'s explicit-request slot, so it outranks that
  // function's own auto-selection.
  const reviewDefaultProvider =
    typeof config.review_default_provider === 'string' && config.review_default_provider.trim() !== ''
      ? config.review_default_provider.trim()
      : undefined;
  // `0` is a DELIBERATE value someone wrote down, not a missing one: patch.yml,
  // the README and `daemon.ts` all read it as "no fuse". A `> 0` gate here used to
  // turn an explicit 0 into 25 — three documents promising a knob the code never
  // honoured. Only values that cannot BE a round count (non-integers, negatives)
  // fall back. The clamp runs HERE as well as at the argument path so the value
  // the panel displays is the budget the code will actually honour.
  const askMaxRounds = clampMaxRounds(
    Number.isInteger(config.ask_max_rounds) && config.ask_max_rounds >= 0
      ? config.ask_max_rounds
      : DEFAULT_ASK_MAX_ROUNDS,
  );
  const authoredAskMaxRounds = askMaxRounds !== DEFAULT_ASK_MAX_ROUNDS;
  const configuredPrefix =
    typeof config.session_key_prefix === 'string' && config.session_key_prefix.trim() !== ''
      ? config.session_key_prefix.trim()
      : '';
  const sessionKeyPrefix = configuredPrefix || detectProfileKey();
  // WHERE the prefix came from, so the caller can name the case where there is
  // none. An empty prefix is not a neutral default — it puts both profiles on
  // one key space in a shared sessions.json.
  const sessionKeyPrefixSource = configuredPrefix !== '' ? 'config' : sessionKeyPrefix !== '' ? 'profile' : 'none';
  const statePath =
    typeof config.state_path === 'string' && config.state_path !== '' ? config.state_path : defaultStatePath();
  // Separate from `working_dir` on purpose: that one is the ask turn's cwd, while
  // an empty review root REFUSES rather than falling back to the host process cwd
  // (see `cordis.patch.yml`).
  const reviewWorkingDir =
    typeof config.review_working_dir === 'string' && config.review_working_dir !== ''
      ? config.review_working_dir
      : undefined;
  const reviewNoWeb = config.review_no_web !== false;
  // `0` means the same thing it does for `ask_max_rounds`: no round fuse. The CLI
  // is not told — the bridge omits `--max-rounds`, which the CLI documents as
  // UNLIMITED (see `buildReviewArgs`). Reading 0 as "use 35" made the two
  // same-named knobs mean opposite things. `review_max_duration_secs` is a
  // separate fuse, unaffected by this.
  const reviewMaxRounds = clampMaxRounds(
    Number.isInteger(config.review_max_rounds) && config.review_max_rounds >= 0
      ? config.review_max_rounds
      : 35,
  );
  // Same clamp as the per-call argument, so the configured default cannot be
  // the one inflated value that slips past the ceiling.
  const reviewMaxDurationSecs = resolveDurationSecs(config.review_max_duration_secs, 900, MAX_REVIEW_DURATION_SECS);
  // CodingPlan quota refresh interval. 0 disables the extra `/command status`
  // call entirely; the panel then reports that quota display is switched off.
  const quotaRefreshSecs =
    Number.isInteger(config.quota_refresh_secs) && config.quota_refresh_secs >= 0
      ? config.quota_refresh_secs
      : 60;
  // How long to wait for a spawned daemon to answer /health before giving up.
  // Also the budget the ask path spends when it has to start the daemon itself.
  const daemonStartTimeoutSecs =
    Number.isInteger(config.daemon_start_timeout_secs) && config.daemon_start_timeout_secs >= 0
      ? config.daemon_start_timeout_secs
      : 30;
  /** Start poll ticks every 1.5s. A 0s budget (attempts===0) spawns and does
   *  one post-spawn probe (no polling wait) — see ensureDaemonStarted, which
   *  reports the real answered state rather than failing unconditionally. */
  const daemonStartAttempts = Math.max(0, Math.ceil((daemonStartTimeoutSecs * 1000) / 1500));
  // Keeps the shared start promise from becoming a permanent tombstone: a panel
  // poll past the cooldown retries even after the user has fixed the machine.
  const daemonRetrySecs =
    Number.isInteger(config.daemon_retry_secs) && config.daemon_retry_secs >= 0
      ? config.daemon_retry_secs
      : 60;

  const binaryEnv =
    typeof process.env.ATOMCODE_BIN === 'string' && process.env.ATOMCODE_BIN !== ''
      ? process.env.ATOMCODE_BIN
      : undefined;

  return {
    port,
    autoStart,
    binary,
    approvalMode,
    approvalModeRejected,
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
    daemonStartAttempts,
    daemonRetrySecs,
    binaryEnv,
  };
}

/**
 * The resolved configuration, DERIVED from `readConfig` instead of written out
 * beside it (one fact, one place — a hand-maintained copy is a copy that starts
 * lying the day a field moves).
 *
 * The three assembly functions below used to take `config: Record<string, any>`,
 * which erased the type of every field at the exact seam where the 24 field
 * names are matched up. What hid behind that is not theoretical: a mistyped
 * `daemonStartAttempsX` destructures to `undefined`, and because every field has
 * a fallback for a missing value, `for (i < undefined)` merely polls zero times
 * — the daemon then silently never starts and NOTHING raises. That is red line
 * 3's forbidden shape, sitting in the one place the compiler was not watching.
 *
 * Measured before the change: injecting a destructure of a key `readConfig`
 * never returns typechecked CLEAN. With this type it is a TS2339, which is what
 * makes the 24 names a checked contract rather than a convention.
 */
export type HostConfig = ReturnType<typeof readConfig>;