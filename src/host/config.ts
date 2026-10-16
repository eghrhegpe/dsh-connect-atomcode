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
import { DEFAULT_PORT } from './daemon.ts';
import { defaultStatePath } from './sessions.ts';

// ── Built-ins that take no input from the patch row ─────────────────────────
// Kept at module scope so `readConfig` stays a function of `rawConfig` alone,
// and so their comments travel with them instead of being re-typed (a second
// copy of a default is a copy that starts lying the day the default moves).
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
export const DAEMON_PROBE_TIMEOUT_MS = 5_000;

/**
 * Budget for the quota `POST /command status` call — the one daemon call that
 * runs on the PANEL's schedule (every `quota_refresh_secs`) rather than the
 * ask path's. Selected under the panel's client deadline so both sides agree
 * on "the daemon is wedged" at roughly the same moment; see `readQuota`.
 */
export const DAEMON_COMMAND_TIMEOUT_MS = 3_500;

// The built-in fallbacks for the patch-only knobs. Named once so the snapshot
// can report them and the panel never hardcodes a second copy of "25" (a copy
// that would silently start lying the moment this default moved).
export const DEFAULT_APPROVAL_MODE = 'bypass';
export const DEFAULT_ASK_MAX_ROUNDS = 25;

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
  const approvalMode =
    typeof config.approval_mode === 'string' && config.approval_mode !== ''
      ? config.approval_mode
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
  // ── 模型档位：两条路、两个命名空间，所以两个字段（红线 8）────────────────
  // ASK (daemon POST /chat). Which AtomCode MODEL bridged turns ask for when the
  // CALL does not name one. Value = the model PROFILE name: `daemon GET /models`
  // returns {provider:"AtomGit-glm5.3-flash", model:"glm5.3-flash", is_default},
  // and that `provider` is exactly the kind of value ~/.atomcode/config.toml puts
  // in its own `default_provider`. Measured on 5.2.x: POST /chat
  // {"provider":"<profile>"} really does switch models (the SSE `runtime_info`
  // event reports the one that ran). Empty = do NOT send a provider at all, so
  // AtomCode's own default stays authoritative. The bridge never writes
  // config.toml — switching the default GLOBALLY is an AtomCode-side edit
  // (`default_provider` + `default_model`, then `POST /config/reload`).
  const defaultProvider =
    typeof config.default_provider === 'string' && config.default_provider.trim() !== ''
      ? config.default_provider.trim()
      : undefined;
  // REVIEW (CLI --provider). A DIFFERENT namespace: the review CLI resolves
  // providers from direct `[providers.<name>]` entries only, so this takes
  // "atomcode-local"-style names, and a daemon profile name ("AtomGit-...")
  // would point it at a provider it cannot bill against. Fills
  // selectReviewProvider()'s explicit-request slot, which therefore outranks its
  // own default_provider auto-selection. Empty = keep today's behavior.
  const reviewDefaultProvider =
    typeof config.review_default_provider === 'string' && config.review_default_provider.trim() !== ''
      ? config.review_default_provider.trim()
      : undefined;
  // 0 is a DELIBERATE value someone wrote down, not a missing one. cordis.patch.yml
  // ("Set 0 to hand the budget back to the daemon's own loop"), README ("0 = 不限")
  // and daemon.ts (`roundFuse = maxRounds > 0 ? n : 0`) all agree that 0 means
  // "no fuse"; a `> 0` gate here silently turned an explicit 0 into 25, i.e. three
  // documents promising a knob the code never honoured. Only values that cannot BE
  // a round count (non-integers, negatives) fall back to the default.
  const askMaxRounds =
    Number.isInteger(config.ask_max_rounds) && config.ask_max_rounds >= 0
      ? config.ask_max_rounds
      : DEFAULT_ASK_MAX_ROUNDS;
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
  // Review's default repo root. Kept SEPARATE from `working_dir` on purpose:
  // `working_dir` is the ask turn's cwd (a conversation notion), while a
  // review without `working_dir` used to fall through to the HOST PROCESS's
  // cwd — silently reviewing the wrong repository. Set this, or pass
  // working_dir per call.
  const reviewWorkingDir =
    typeof config.review_working_dir === 'string' && config.review_working_dir !== ''
      ? config.review_working_dir
      : undefined;
  const reviewNoWeb = config.review_no_web !== false;
  // 0 means the SAME thing it means for `ask_max_rounds` above: no round fuse.
  // It is not a missing value, and the CLI does not have to be told so — the
  // bridge expresses it by leaving `--max-rounds` off the argv, which the CLI
  // documents as UNLIMITED (see buildReviewArgs). Only values that cannot BE a
  // round count (non-integers, negatives) fall back to the default. Reading 0 as
  // "use 35" made the two same-named knobs mean opposite things.
  // `review_max_duration_secs` is a separate fuse and is unaffected by this.
  const reviewMaxRounds =
    Number.isInteger(config.review_max_rounds) && config.review_max_rounds >= 0
      ? config.review_max_rounds
      : 35;
  const reviewMaxDurationSecs =
    Number.isInteger(config.review_max_duration_secs) && config.review_max_duration_secs > 0
      ? config.review_max_duration_secs
      : 900;
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
  // Cooldown before a FAILED auto-start is retried. Without this the shared
  // start promise is a permanent tombstone: the first failure (binary not yet
  // installed, daemon wedged) would silence auto-start for the whole mount,
  // even after the user fixed the machine. With it, a panel poll after the
  // cooldown tries again. 0 = retry on the very next poll.
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