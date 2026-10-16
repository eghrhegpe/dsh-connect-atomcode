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
 *     at ~/.dsh/state/dsh-connect-atomcode/), so the model never carries ids.
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
 * @module dsh-connect-atomcode
 */
import {
  DEFAULT_PORT,
  TOOLS_CAP,
  askChat,
  healthInfo,
  listModels,
  runCommand,
  spawnDaemon,
} from './daemon.ts';
import type { HealthFailure } from './daemon.ts';
import { createSessionStore, defaultStatePath } from './sessions.ts';
import { createProviderStore, PROVIDER_SLOTS, normalizeProviderName } from './provider-store.ts';
import { runReview, checkReviewProvision, selectReviewProvider, probeLocalEndpoint, PROVIDER_FIX } from './review.ts';
import { isLoopbackBaseUrl } from '../shared/loopback.ts';
import { buildQuotaReport } from './quota.ts';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Host-side status endpoint helpers (read-only, same-origin).
 * Mirrors the dsh-connect-sensenova-token-plan snapshot route contract so the
 * plugin detail-page client can poll live startup/usage stats.
 */
function writeJson(res: any, status: number, body: unknown, headers?: Record<string, string>) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(headers || {}) });
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
function sameOrigin(request: any) {
  const reqHeaders = request && request.headers;
  const host = reqHeaders ? reqHeaders.host || reqHeaders.Host : undefined;
  const origin = reqHeaders ? reqHeaders.origin || reqHeaders.Origin : undefined;
  if (!origin) return true; // non-browser / same-origin fetch omits Origin
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

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
function describeDaemonDown(reason: HealthFailure): string {
  switch (reason) {
    case 'refused':
      return '没有任何进程在监听';
    case 'timeout':
      return `有进程在监听，但 ${DAEMON_PROBE_TIMEOUT_MS}ms 内无应答`;
    case 'http-error':
      return '端口上有服务，但 /health 返回非 2xx';
    case 'unreadable':
      return '端口上有服务，但应答不是可解析的 JSON';
    case 'not-atomcode':
      return '端口被非 AtomCode 服务占用（/health 未声明 atomcode-daemon）';
    case 'unreachable':
      return '探活失败，原因未能归类';
    case '':
      // Down, but no probe has finished yet — the panel can ask before the
      // mount's first probe resolves. Not a failure, and not worth inventing one.
      return '尚未探活';
    default:
      return '探活失败，原因未能归类';
  }
}

/** Snapshot body consumed by the plugin detail-page client. */
function buildStatsBody(stats: Record<string, any>, quota: any) {
  return {
    ok: true,
    name: 'dsh-connect-atomcode',
    displayName: 'DSH AtomCode Bridge',
    version: '0.4.2',
    uptimeMs: Date.now() - stats.startedAt,
    daemon: {
      up: stats.daemonUp,
      port: stats.port,
      autoStart: stats.autoStart,
      spawnTried: stats.spawnTried,
      spawnAttempts: stats.spawnAttempts,
      spawnFailures: stats.spawnFailures,
      // True while the 30s start poll is in flight, so the panel can say
      // "starting…" instead of "failed" for the first half-minute.
      starting: stats.daemonStarting,
      lastCheckedAt: stats.lastHealthAt,
      // The named cause, already worded, and `''` while up. Sent as a sentence
      // rather than a code for the renderer to translate: the tool errors say the
      // same thing from the same function, and a panel that re-derived its own
      // wording is how the two halves end up telling the user two stories.
      downMessage: stats.daemonUp ? '' : describeDaemonDown(stats.daemonDownReason),
    },
    binary: {
      configured: stats.binaryConfigured,
      env: stats.binaryEnv,
      source: stats.binaryConfigured ? 'config' : stats.binaryEnv ? 'env' : 'auto',
    },
    config: {
      approvalMode: stats.approvalMode,
      defaultWorkingDir: stats.defaultWorkingDir,
      reviewWorkingDir: stats.reviewWorkingDir,
      // The model profile bridged turns ask for when the call names none. On the
      // snapshot rather than hidden in the mount: a typo'd profile is only
      // diagnosable if the panel says which default the bridge is pinning.
      defaultProvider: stats.defaultProvider,
      // The review CLI's configured direct entry (a DIFFERENT namespace from the
      // field above — see 红线 8 in AGENTS.md).
      reviewDefaultProvider: stats.reviewDefaultProvider,
      askMaxRounds: stats.askRounds,
      daemonRetrySecs: stats.retrySecs,
      reviewAvailable: stats.reviewAvailable,
      // Which of the patch-only knobs the USER actually authored, and what the
      // built-in fallback is. The panel cannot edit these (no input exists), so
      // without this it can only print a value and let the reader guess whether it
      // is a live setting or our own default — and guessing is how the panel ended
      // up reporting six constant rows. Reporting the default here (rather than
      // hardcoding it client-side) keeps ONE source of truth for `25`.
      authored: stats.authored,
      defaults: stats.defaults,
      reviewReason: stats.reviewReason,
    },
    // The model knobs, one entry per slot. Kept as TWO entries with identical
    // shape on purpose: merging them would let the panel read them as one knob,
    // which is the confusion 红线 8 exists to prevent. `effective` answers the
    // question a click raises — "what will the NEXT call actually use, and why" —
    // so a pick that did not take effect is visible on the panel instead of
    // being a mystery that needs a host restart to diagnose.
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
        catalogError: stats.modelCatalogError,
      },
      review: {
        panel: stats.panelProvider.review,
        config: stats.reviewDefaultProvider,
        effective: stats.effectiveReview,
        source: stats.effectiveReviewSource,
        catalog: stats.reviewCatalog,
        // name → base_url, so the panel can say what the pick DEPENDS on. A
        // loopback entry means a local sidecar process (in the one measured
        // working setup, the proxy that turns CodingPlan quota into a standard
        // endpoint on a gateway that does not check signatures) — the user is
        // told at click time instead of when the review dies.
        endpoints: stats.reviewEndpoints,
      },
    },
    // Drift/provenance signals: which daemon build we talk to, and whether the
    // quota parser has stopped recognizing the status text. Both are silent
    // degradations in v0.3 — now they are observable facts on the panel.
    protocol: {
      daemonVersion: stats.daemonVersion,
      verifiedGeneration: '5.x',
      quotaTextDrift: stats.quotaDriftSeen,
      // Same species as `quotaTextDrift` above — a silent degradation turned
      // into an observable fact — and the sharper instance of it. A renamed
      // `tool_start` leaves every turn looking like a clean success (see
      // askChat's `unknownTypes`), while the round fuse that counts those
      // events quietly stops existing. The panel is where a human sees it
      // without having to read a tool result first.
      unknownTypes: stats.protocolUnknownTypes,
    },
    // CodingPlan quota. Only the daemon's `status` command carries it (as
    // localized text), so this branch is best-effort and says why when empty.
    quota: quota ?? { available: false, reason: 'not collected yet', fetchedAt: null },
    sessions: { tracked: stats.sessionsTracked, error: stats.sessionsError },
    ask: stats.ask,
    review: stats.review,
  };
}

export const name = 'atomcode-bridge';
export const inject = ['tools', 'webServer'];

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
  const DAEMON_PROBE_TIMEOUT_MS = 5_000;
  /**
   * Budget for the quota `POST /command status` call — the one daemon call that
   * runs on the PANEL's schedule (every `quota_refresh_secs`) rather than the
   * ask path's. Selected under the panel's client deadline so both sides agree
   * on "the daemon is wedged" at roughly the same moment; see `readQuota`.
   */
  const DAEMON_COMMAND_TIMEOUT_MS = 3_500;
  // The built-in fallbacks for the patch-only knobs. Named once so the snapshot can
  // report them and the panel never hardcodes a second copy of "25" (a copy that
  // would silently start lying the moment this default moved).
  const DEFAULT_APPROVAL_MODE = 'bypass';
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
function readConfig(rawConfig: Record<string, any>) {
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
  const reviewMaxRounds =
    Number.isInteger(config.review_max_rounds) && config.review_max_rounds > 0
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
type HostConfig = ReturnType<typeof readConfig>;

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
 * @param {{ config: HostConfig, log: (message: any) => void }} deps
 */
function createRuntime({
  config,
  log,
}: {
  config: HostConfig;
  log: (message: any) => void;
}) {
  const {
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
    statePath,
    reviewWorkingDir,
    quotaRefreshSecs,
    daemonStartAttempts,
    daemonRetrySecs,
    binaryEnv,
  } = config;

  // Session glue degrades rather than throws (sessions.ts), and every
  // degradation is NAMED here instead of swallowed (红线 3): a state file this
  // process cannot write is a fact about the mount, not a reason to hand a
  // finished turn back as an error. `''` means recovered — same channel.
  // The observer writes `stats`, which is declared further down: safe because it
  // can only fire from get/set/drop/count, and every one of those runs long
  // after the mount finished. Nothing between here and the declaration may call
  // the store, or this becomes a temporal-dead-zone throw at mount.
  const sessions = createSessionStore(statePath, sessionKeyPrefix, {
    onError: (error) => {
      stats.sessionsError = error;
      if (error) log(`会话续接已降级（本轮回复不受影响）：${error}`);
    },
  });
  // The panel's model choice, in the SAME directory so one `state_path` knob
  // governs both files. Read PER CALL (like sessions, and like the review probe)
  // so a pick made in the panel applies to the very next turn — no host restart.
  const providerStore = createProviderStore(join(dirname(statePath), 'provider.json'));
  /**
   * The store is total by design (never throws). A throw here means something
   * moved under us (the state dir was swapped mid-run); that must not take a tool
   * call down, so it degrades to "no panel pick" AND names itself in the log —
   * silence would read as "the user never chose anything" (红线 3).
   */
  const readProviderPicks = () => {
    try {
      return providerStore.read();
    } catch (error: any) {
      const reason = String(error && error.message ? error.message : error);
      log(`provider state read failed, ignoring the panel pick: ${reason}`);
      return { ask: null, review: null, foreignVersion: false, error: reason };
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
  const resolveProvider = (slot: any, argument: any, alreadyRead?: any) => {
    const arg = typeof argument === 'string' && argument.trim() !== '' ? argument.trim() : '';
    const picks = alreadyRead || readProviderPicks();
    const panel = slot === 'ask' ? picks.ask : picks.review;
    if (arg) return { name: arg, source: 'argument', picks };
    if (panel) return { name: panel, source: 'panel', picks };
    const configured = slot === 'ask' ? defaultProvider : reviewDefaultProvider;
    if (configured) return { name: configured, source: 'config', picks };
    // The empty-pick fallback differs by slot ON PURPOSE: leaving ask empty means
    // "the daemon applies its own default profile", while leaving review empty
    // hands the choice to selectReviewProvider()'s own ladder — a different
    // thing (红线 8: the two slots are two namespaces, not one knob).
    return { name: '', source: slot === 'ask' ? 'atomcode' : 'auto', picks };
  };

  // Probe review CLI availability at mount time (best-effort: no live spawn).
  const reviewProvision = checkReviewProvision();

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Live status snapshot, mirrored by the plugin detail-page client over the
   * read-only `/api/atomcode-bridge/stats` route. Counters accumulate for the
   * life of the plugin mount; `daemonUp`/`lastHealthAt` are refreshed on each
   * stats poll (5s cache) and on every ask dispatch.
   */
  // A mutable bag assembled across the mount and read by the module-level
  // `buildStatsBody`. Deliberately a plain record: the fields are written
  // incrementally by several closures (health, catalogue, counters), and the
  // snapshot's shape is asserted by the offline suites rather than inferred here.
  const stats: Record<string, any> = {
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
    // The panel's own picks (provider.json) and the model catalogue the dropdown
    // lists. `modelCatalog === null` means "not fetched yet or the daemon is
    // down" — the client renders a reason instead of an empty dropdown.
    panelProvider: { ask: null, review: null },
    panelStorePath: providerStore.path(),
    panelStoreError: '',
    panelStoreForeign: false,
    effectiveAsk: null,
    // 'panel' | 'config' | 'atomcode' — who is actually answering for the next
    // ask call. The review slot uses 'auto' instead of 'atomcode' because that is
    // what leaving it empty really means there (红线 8).
    effectiveAskSource: 'atomcode',
    effectiveReview: null,
    effectiveReviewSource: 'auto',
    modelCatalog: null,
    modelCatalogAt: 0,
    modelCatalogError: '',
    reviewCatalog: reviewProvision.providers || [],
    reviewEndpoints: reviewProvision.endpoints || {},
    daemonUp: false,
    daemonVersion: '',
    // Which probe failure put `daemonUp` at false (`''` while up). One flag for
    // four different causes was the whole problem — see describeDaemonDown.
    daemonDownReason: '' as HealthFailure,
    spawnTried: false,
    spawnAttempts: 0,
    spawnFailures: 0,
    lastSpawnAt: 0,
    daemonStarting: false,
    lastHealthAt: 0,
    reviewAvailable: reviewProvision.available,
    reviewReason: reviewProvision.reason,
    sessionsTracked: 0,
    // Why session glue is degraded right now ('' when healthy) — see the
    // session store's onError observer. Surfaced on the panel so a state file
    // that cannot be written is visible rather than merely logged.
    sessionsError: '',
    askRounds: askMaxRounds,
    retrySecs: daemonRetrySecs,
    // Which patch-only knobs the user authored, and our built-in fallbacks. Both
    // live on `stats` (not read from the mount closure) because buildStatsBody is
    // module-level — the panel's "（已改）/（插件默认）" tags must come from the host
    // rather than a client-side guess at what the default is.
    authored: {
      approvalMode: authoredApprovalMode,
      workingDir: authoredWorkingDir,
      askMaxRounds: authoredAskMaxRounds,
    },
    defaults: { approvalMode: DEFAULT_APPROVAL_MODE, askMaxRounds: DEFAULT_ASK_MAX_ROUNDS },
    quotaDriftSeen: false,
    // SSE event types the daemon sent that we did not recognize. Accumulated as
    // a UNION across every ask turn of this mount: the fact worth keeping is
    // "has this ever been seen", and letting a later clean turn erase the
    // evidence would make a one-off (or an intermittent) drift invisible on the
    // panel — the very silent degradation red line 3 forbids.
    protocolUnknownTypes: [] as string[],
    ask: { calls: 0, ok: 0, err: 0, msTotal: 0, tokens: 0 },
    review: { calls: 0, ok: 0, err: 0, msTotal: 0 },
  };

  /** Refresh daemon liveness with a short cache (used by both ask + stats). */
  async function refreshHealth(force = false) {
    if (!force && Date.now() - stats.lastHealthAt < 5000) return stats.daemonUp;
    try {
      const info = await healthInfo(port, AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS));
      stats.daemonUp = info.up;
      // Carry the CAUSE alongside the flag. Down is one bit; why it is down is
      // what the error reply and the panel actually need (see describeDaemonDown).
      stats.daemonDownReason = info.reason;
      // Surface which daemon protocol generation we are talking to (the panel
      // shows it; an unknown major is the plugin's earliest drift signal).
      if (info.version && info.version !== stats.daemonVersion) {
        stats.daemonVersion = info.version;
        if (info.version && !/^5\./.test(info.version)) {
          log(`unverified AtomCode daemon version ${info.version} — the bridged protocol was validated against 5.x`);
        }
      }
    } catch {
      // `healthInfo` is contractually non-throwing, so this only fires if that
      // contract breaks. Say so rather than borrowing a cause we did not observe.
      stats.daemonUp = false;
      stats.daemonDownReason = 'unreachable';
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
  let daemonStartPromise: Promise<boolean> | null = null;
  function ensureDaemonStarted() {
    if (daemonStartPromise !== null) return daemonStartPromise;
    if (!autoStart) return Promise.resolve(false);
    // A previous failure is re-attempted only after the cooldown; otherwise the
    // panel's 5s poll would hammer spawn attempts every poll.
    if (stats.spawnTried && Date.now() - stats.lastSpawnAt < daemonRetrySecs * 1000) {
      return Promise.resolve(false);
    }
    // Mark "starting" up front so the very first panel poll says so instead of
    // reporting a bare "not running" until the health probe resolves.
    stats.daemonStarting = true;
    stats.spawnTried = true;
    stats.spawnAttempts += 1;
    stats.lastSpawnAt = Date.now();
    daemonStartPromise = (async () => {
      // Health first: this is what keeps a host restart — or a second profile —
      // from spawning a duplicate daemon against a port that is already served.
      if (await refreshHealth()) return true;
      await spawnDaemon({
        port,
        ...(binary ? { binary } : {}),
        ...(defaultWorkingDir ? { workingDir: defaultWorkingDir } : {}),
        log,
      });
      let answered = false;
      for (let i = 0; i < daemonStartAttempts; i++) {
        await sleep(1500);
        if (await refreshHealth(true)) {
          answered = true;
          break;
        }
      }
      // A 0s budget (daemonStartAttempts === 0) means "spawn and don't poll",
      // but we must still report whether the daemon actually answered —
      // otherwise the panel shows a phantom "auto-start failed" even though the
      // spawn succeeded and the daemon may already be up. Do exactly one
      // post-spawn probe when there were no poll ticks. (This is why a 0s
      // budget no longer unconditionally fails; see the config comment above.)
      if (!answered && daemonStartAttempts === 0) {
        answered = await refreshHealth(true);
      }
      return answered;
    })()
      .catch(() => false)
      .finally(() => {
        stats.daemonStarting = false;
        if (stats.daemonUp === false) {
          // Do not cache the failure: the next call (after the cooldown) retries.
          daemonStartPromise = null;
          stats.spawnFailures += 1;
        }
      });
    return daemonStartPromise;
  }

  /** Resolves `false` as soon as `signal` aborts, so a caller can stop awaiting. */
  function waitForAbort(signal: AbortSignal) {
    return new Promise((resolve) => {
      if (signal.aborted) resolve(false);
      else signal.addEventListener('abort', () => resolve(false), { once: true });
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
  async function ensureDaemon(signal?: AbortSignal) {
    if (signal?.aborted) return false;
    if (await refreshHealth()) return true;
    if (signal?.aborted) return false;
    // The daemon is not answering. A start that is still IN FLIGHT must stay
    // shared: dropping it here would let a second poll spawn a second daemon
    // against the same port — the exact thing the shared promise exists to
    // prevent — and would orphan the first start, whose health poll then keeps
    // running with nobody awaiting it. `stats.daemonStarting` is the honest
    // in-flight signal; it is set synchronously when the start begins and
    // cleared in its `finally`.
    //
    // Only a SETTLED start may be discarded, so that a start which succeeded
    // before the daemon idle-exited (30min) or was killed is re-evaluated
    // instead of being trusted forever.
    if (daemonStartPromise !== null && !stats.daemonStarting) daemonStartPromise = null;
    const started = signal
      ? await Promise.race([ensureDaemonStarted(), waitForAbort(signal)])
      : await ensureDaemonStarted();
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
  let quotaCache: { at: number; value: any } = { at: 0, value: null };
  async function readQuota() {
    if (quotaRefreshSecs === 0) {
      return {
        available: false,
        reason: '额度显示已关闭（quota_refresh_secs = 0）',
        fetchedAt: Date.now(),
      };
    }
    const now = Date.now();
    if (quotaCache.value !== null && now - quotaCache.at < quotaRefreshSecs * 1000) {
      return quotaCache.value;
    }
    // Type-only: the early return above means only the `buildQuotaReport` shape
    // survives to the `drift` read below, but the JS reuses one binding.
    let value: any;
    if (!(await refreshHealth())) {
      // While a spawn is in flight, say so and do NOT cache the negative answer —
      // otherwise the panel would keep showing "not running" for a whole TTL
      // after the daemon has already come up.
      value = {
        available: false,
        // The quota branch used to say a blanket 'daemon 未运行' for every
        // daemon-down shape — the same collapse the daemon branch just grew out
        // of. Name it from the same function so a "额度不可用" red line tells the
        // user whether the port is empty, held by a stranger, or just silent.
        reason: stats.daemonStarting ? '正在拉起 daemon…' : describeDaemonDown(stats.daemonDownReason),
        fetchedAt: now,
      };
      if (!stats.daemonStarting) quotaCache = { at: now, value };
      return value;
    }
    // A named budget, and it is DELIBERATELY under the panel's client deadline
    // (`POLL_MS - 1000` in src/client/index.ts): the client aborts its fetch at
    // 4s and reports its own timeout string, so a server budget above that
    // guarantees the host's answer is never read AND leaves a handler running
    // for the rest of the 15s default. Answer first and the panel gets the
    // HOST's named reason, which the quota chip and the detail page share.
    const result = await runCommand({
      port,
      command: 'status',
      workingDir: defaultWorkingDir || homedir(),
      timeoutMs: DAEMON_COMMAND_TIMEOUT_MS,
    });
    // `runCommand` maps a transport abort to a DOMException string ("The
    // operation was aborted due to timeout"), which as a panel reason is true
    // but useless. The only transport shape THIS call can hit on a healthy
    // socket is our own budget, so say that instead of quoting Node.
    const outcome =
      result.ok === true || result.kind !== 'transport' || !/abort|timeout/i.test(result.message || '')
        ? result
        : { ...result, kind: 'timeout', message: `daemon 未在 ${DAEMON_COMMAND_TIMEOUT_MS}ms 内应答 /command status（daemon 可能卡住）` };
    value = buildQuotaReport(outcome, Date.now());
    if (value.drift === true) {
      if (!stats.quotaDriftSeen) {
        stats.quotaDriftSeen = true;
        log('the daemon status text no longer matches any known quota shape (AtomCode may have been upgraded) — the panel will show the raw text');
      }
    } else {
      stats.quotaDriftSeen = false;
    }
    quotaCache = { at: now, value };
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
    stats.panelProvider = { ask: picks.ask, review: picks.review };
    stats.panelStoreError = picks.error;
    stats.panelStoreForeign = picks.foreignVersion;
    // The SAME ladder the execute path runs, asked with no per-call argument:
    // "what will the NEXT call use, and who decided". Duplicating this here is
    // how the two answers drifted apart (the copy had no `argument` rung, and
    // the panel-side wording for a rung its own snapshot never produces).
    const ask = resolveProvider('ask', '', picks);
    stats.effectiveAsk = ask.name || null;
    stats.effectiveAskSource = ask.source;
    const review = resolveProvider('review', '', picks);
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
  const MODEL_CATALOG_TTL_MS = 30_000;
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
      stats.modelCatalog = Array.isArray(list)
        ? list
            .filter((m) => m && typeof m.provider === 'string' && m.provider !== '')
            // ONLY what the panel consumes: the profile name the dropdown sends,
            // and whether AtomCode itself treats it as the default (the one fact
            // that tells a user whether pinning is even necessary). `model` and
            // `effort_levels` used to be mapped in here and read by NOTHING —
            // payload shipped on every 30s poll to be dropped at the renderer.
            .map((m) => ({
              provider: m.provider,
              isDefault: m.is_default === true,
            }))
        : [];
      stats.modelCatalogAt = Date.now();
      stats.modelCatalogError = '';
    } catch (error: any) {
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
    reviewProvision,
  };
}

/**
 * The two HTTP routes this plugin serves: the read-only stats snapshot the
 * detail page polls, and the write endpoint behind the model dropdown.
 *
 * They are mounted together because they share everything that matters — one
 * `webServer` registration surface, one runtime — and because mounting them
 * apart is how the teardown ended up as four separate `if (typeof … ===
 * 'function')` checks in apply(), a shape where a fifth disposer goes missing
 * without any compiler complaint.
 *
 * `webServer` is resolved by the caller: getting it needs `ctx`, and keeping
 * `ctx` out of this function is the same rule createRuntime() follows. A host
 * without the service is not an error — both registrations degrade to no-ops.
 *
 * @returns {() => void} one disposer for both routes.
 */
function mountRoutes({
  webServer,
  runtime,
  log,
}: {
  webServer: any;
  runtime: ReturnType<typeof createRuntime>;
  log: (message: any) => void;
}) {
  const {
    stats,
    sessions,
    refreshHealth,
    ensureDaemonStarted,
    readQuota,
    refreshPanelState,
    refreshModelCatalog,
    providerStore,
  } = runtime;

  const disposeStats = webServer && typeof webServer.register === 'function'
    ? webServer.register({
        kind: 'exact',
        path: '/api/atomcode-bridge/stats',
        handler: async (request: any, response: any) => {
          if (request && request.method && request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' });
            response.end();
            return;
          }
          if (!sameOrigin(request)) {
            response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('forbidden');
            return;
          }
          // Reflect the live tracked-session count on read (prefix-scoped: only this
          // store's keys, so a sibling profile's lines never inflate it).
          stats.sessionsTracked = sessions.count();
          await refreshHealth();
          // Opening the panel is itself a good moment to bring the daemon up.
          // Fire-and-forget: the start poll can run 30s, and this handler must
          // answer well inside the panel's 5s poll. `ensureDaemonStarted` is
          // shared, so this cannot race the mount or an ask into two daemons.
          if (!stats.daemonUp) void ensureDaemonStarted();
          const quota = await readQuota();
          // Panel-facing knobs: the stored picks + the catalogue the dropdowns
          // list. Sync read of a ~200-byte file, then one cached metadata call.
          refreshPanelState();
          await refreshModelCatalog();
          // HEAD gets headers only — a body on HEAD violates HTTP semantics.
          // The panel only ever GETs, but the method gate above lets HEAD
          // through deliberately, so honor it correctly here.
          if (request.method === 'HEAD') {
            response.writeHead(200, { 'cache-control': 'no-store' });
            response.end();
            return;
          }
          writeJson(response, 200, buildStatsBody(stats, quota), { 'cache-control': 'no-store' });
        },
      })
    : () => {};

  // ── 面板的模型选择写入点（同源，读自己那份 state 文件） ───────────────────
  // This route is what makes the dropdown a control instead of a decoration: the
  // pick is persisted to the PLUGIN's own state file (`provider.json`, next to
  // sessions.json) and read back per call — never into `~/.atomcode/config.toml`
  // (红线 8: that file is another application's configuration and stays read-only
  // for us). Same-origin gated like the stats route; a bounded JSON body; the slot
  // must be one of the two namespaces, and clearing is expressed as null.
  const PROVIDER_BODY_LIMIT = 4096;
  async function readJsonBody(request: any) {
    const chunks = [];
    let received = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
        received += buffer.byteLength;
        if (received > PROVIDER_BODY_LIMIT) return { ok: false, error: `request body is larger than ${PROVIDER_BODY_LIMIT} bytes` };
        chunks.push(buffer);
      }
    } catch {
      return { ok: false, error: 'could not read the request body' };
    }
    if (chunks.length === 0) return { ok: false, error: 'a JSON body is required' };
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return { ok: false, error: 'the body is not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'the body must be a JSON object' };
    }
    return { ok: true, value: parsed };
  }

  const disposeProvider = webServer && typeof webServer.register === 'function'
    ? webServer.register({
        kind: 'exact',
        path: '/api/atomcode-bridge/provider',
        handler: async (request: any, response: any) => {
          const method = request && request.method ? request.method : 'GET';
          if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
            writeJson(response, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, HEAD, POST' });
            return;
          }
          if (!sameOrigin(request)) {
            writeJson(response, 403, { ok: false, error: 'forbidden: origin mismatch' });
            return;
          }
          if (method === 'POST') {
            const body = await readJsonBody(request);
            if (!body.ok) {
              writeJson(response, 400, { ok: false, error: body.error });
              return;
            }
            const slot = body.value.slot;
            if (!PROVIDER_SLOTS.includes(slot)) {
              writeJson(response, 400, {
                ok: false,
                error: `slot must be one of ${PROVIDER_SLOTS.join(' / ')} (the two paths take different provider names — 红线 8)`,
              });
              return;
            }
            // A MISSING key is not a CLEAR. `normalizeProviderName(undefined)`
            // reads null as "clear the pick", which is how the wire spells
            // 未插手 — but that also made a body without the field silently
            // erase the user's selection (an older client, a hand-typed curl,
            // a truncated body). Clearing must be an OBSERVABLE act: the field
            // has to be present and null/''; absent is a 400 that says so.
            if (!Object.prototype.hasOwnProperty.call(body.value, 'provider')) {
              writeJson(response, 400, {
                ok: false,
                error: 'provider field is missing: name it, or send null explicitly to clear the pick',
              });
              return;
            }
            // normalizeProviderName is the ONLY validation: null/'' clears, and a
            // name we do not recognize is still passed through — the daemon or the
            // CLI judges it, and the turn reports the provider that ACTUALLY ran
            // (`runtime_info`), so a typo surfaces instead of being guessed away.
            const normalized = normalizeProviderName(body.value.provider);
            if (!normalized.ok) {
              writeJson(response, 400, { ok: false, error: normalized.error });
              return;
            }
            const written = providerStore.set(slot, normalized.value);
            if (!written.ok) {
              // A refused write is never swallowed: the panel shows the reason, and
              // a foreign (newer-build) file gets its own status so the user knows
              // this is a version situation, not a broken button. The status is
              // chosen from the store's CODE, never from its wording — matching
              // prose is how a correct refusal becomes a mysterious 500.
              const status = written.code === 'foreign-version' ? 409 : 500;
              log(`provider pick refused (${slot}): ${written.error}`);
              writeJson(response, status, { ok: false, error: written.error });
              return;
            }
            log(`provider pick saved (${slot}): ${written.value === null ? 'cleared' : written.value}`);
          }
          refreshPanelState();
          // HEAD gets headers only — a body on HEAD violates HTTP semantics, and
          // the method gate above lets HEAD through deliberately. The stats route
          // already honors this; this route must not be the half that does not.
          if (method === 'HEAD') {
            response.writeHead(200, { 'cache-control': 'no-store' });
            response.end();
            return;
          }
          // `ok` is part of the contract on BOTH methods: the client treats any
          // response without `ok: true` as a failure, so a successful write that
          // answered with a bare provider branch would render as an error.
          writeJson(response, 200, { ok: true, ...buildStatsBody(stats, null).provider }, { 'cache-control': 'no-store' });
        },
      })
    : () => {};

  return () => {
    disposeStats();
    disposeProvider();
  };
}

/**
 * `atomcode_ask` — one full autonomous daemon turn, with side-conversation
 * continuity.
 *
 * The description is assembled HERE rather than at the mount site: `providerHint`
 * names the live state of `default_provider`, so it and the `register()` call that
 * consumes it belong in the same scope. They used to be separated by hundreds of
 * lines, which is how a description goes quietly stale against the code it
 * describes with nothing failing.
 *
 * @returns {() => void} the tool’s disposer.
 */
function mountAskTool({
  tools,
  config,
  runtime,
}: {
  tools: any;
  config: HostConfig;
  runtime: ReturnType<typeof createRuntime>;
}) {
  const {
    port,
    autoStart,
    approvalMode,
    defaultWorkingDir,
    defaultProvider,
    askMaxRounds,
  } = config;
  const {
    stats,
    sessions,
    resolveProvider,
    ensureDaemon,
  } = runtime;

  // Said out loud in BOTH tool descriptions. The most common wrong move against
  // this bridge is assuming `provider` takes a model id — it does not: AtomCode
  // 5.x names its model PROFILES ("AtomGit-glm5.3-flash"), and that profile name
  // is what /chat's `provider` and config.toml's `default_provider` both hold.
  // Telling the model before the call beats a wrong-provider turn (红线 1's
  // "inform before, not after" discipline, applied to model selection).
  // The parenthetical names the state of `default_provider`, so it belongs TO that
  // rung — not after the last one. Appending it to "AtomCode 自己的默认档位" made the
  // ladder read "… > 默认档位（当前…） > 默认档位", i.e. the same rung twice, and this
  // string is the model's ONLY input about the order (红线 8: describe the ladder,
  // never its outcome). Rung counts are pinned by test/ask-glue.test.mjs.
  const providerHint =
    '换模型：provider 参数收的是 AtomCode 的模型档位名（daemon GET /models 里的 provider 字段，' +
    '如 "AtomGit-glm5.3-flash"；不是裸模型 id "glm5.3-flash"）。' +
    '优先级：本参数 > 详情页面板上选的档位 > 插件配置 default_provider' +
    (defaultProvider ? `（当前 default_provider="${defaultProvider}"）` : '（当前未配 default_provider）') +
    ' > AtomCode 自己的默认档位；返回里的 provider= 是 daemon 报的真实生效值。';

  // ── atomcode_ask：侧边对话（daemon 自主回合 + 会话连续性） ──────────────
  const disposeAsk = tools.register({
    name: 'atomcode_ask',
    description:
      '把一条消息转发给本机 AtomCode（终端 AI 编程助手，官方二进制）的 daemon 执行一个完整自主回合（它自带工具循环，approval_mode 默认 bypass 无人值守放行），取回整轮回复。' +
      '用于"帮我问 AtomCode / 让 AtomCode 处理 / 侧边咨询"场景；拿到结果后把 reply 转达给用户。' +
      'continue=true 接续本工作目录上一次侧边对话（自动恢复 session，无需记 id）；默认开新线。续线接到死会话时用 reset_session=true 重新开线。' +
      '整回合可能数分钟。' +
      providerHint,
    // Declare timeoutMs so the DSH tool timeout policy can see this tool.
    // askChat's own timeout (timeout_secs param) is the actual wire budget;
    // 30min here mirrors askChat's default and keeps the host guard from
    // killing mid-turn.
    timeoutMs: 30 * 60 * 1000,
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '转发给 AtomCode 的消息（通常是用户最新一句话的原文）' },
        continue: { type: 'boolean', description: '可选：接续本工作目录上一次侧边对话（默认 false，开新会话）。注意：会话按 working_dir 记忆，同一仓库的两次不相干对话会共用同一条侧边线' },
        session_id: { type: 'string', description: '可选：显式接续某个 AtomCode 会话（优先于 continue）' },
        reset_session: { type: 'boolean', description: '可选：清掉本工作目录记录的侧边会话（续线接到一条已过期的 daemon 会话、或想彻底开新线时用；不影响本回合）' },
        provider: { type: 'string', description: '可选：点名 AtomCode 模型档位，传它就换本次回合用的模型。名字以 daemon GET /models 的 provider 字段为准（如 "AtomGit-glm5.3-flash"），不要传裸模型 id（"glm5.3-flash"）。留空时按顺序取：面板上选的档位 → 插件配置 default_provider → AtomCode 自己的默认' },
        working_dir: { type: 'string', description: '可选：回合的工作目录，同时是侧边对话的会话键；缺省用插件配置' },
        timeout_secs: { type: 'number', description: '可选：整回合超时秒数，默认 1800' },
        max_rounds: { type: 'number', description: '可选：工具调用轮数上限（按 daemon SSE 的 tool_start 事件计数；一次 agent 回合可能含多次并行工具调用，故事件数 ≤ agent 轮数。默认取插件配置，当前 ' + askMaxRounds + '；传 0 关掉本端熔断，交回 daemon 自带治理）。超限只中止本端等待并返回错误，不保证停掉 daemon 侧回合' },
      },
      required: ['message'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reply: { type: 'string' },
          session_id: { type: 'string' },
          continued: { type: 'boolean' },
          truncated: { type: 'boolean', description: 'reply 超过上限被截断（截断处有标记；让 AtomCode 把长内容落盘再读，别只靠这一份摘要）' },
          tokens: { type: 'number' },
          tool_calls: { type: 'number' },
          round_count: { type: 'number', description: '本回合 tool_start 事件数（≤ agent 轮数；并行工具会多次计数）' },
          tools: {
            type: 'array',
            description: `本回合的工具记录，最多 ${TOOLS_CAP} 条（超出部分被省略，见 tools_truncated；tool_calls 仍是真实总数）`,
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, success: { type: 'boolean' } },
              required: ['name', 'success'],
              additionalProperties: false,
            },
          },
          tools_truncated: { type: 'boolean', description: 'tools 数组被截断（只回了前若干条；tool_calls 是真实总数，不代表 tools 就是全部）' },
          stop_reason: { type: 'string' },
          provider: { type: 'string' },
          providerReported: { type: 'boolean', description: 'provider 是否来自 daemon SSE 的 runtime_info（true = 远端实测值；false = daemon 未报，回显本插件请求值、未经远端证实——daemon 升级后若不再发 runtime_info，每回合都会带 false 并标注）' },
          protocol_unknown_types: {
            type: 'array',
            description: '本回合 daemon 发来、本插件不认识的事件类型（空数组 = 词汇表未变，是常态；恒有本字段，故「没观察到漂移」与「没检查漂移」不会混淆）。非空说明 AtomCode 可能已升级或改了事件名。注意：轮数熔断靠计数 tool_start 生效，若被改名的正是这类被计数的事件，熔断会少计甚至完全不触发——此时 round_count 不可信',
            items: { type: 'string' },
          },
          error: { type: 'string' },
        },
        required: ['ok', 'reply', 'session_id', 'continued', 'truncated', 'tokens', 'tool_calls', 'tools', 'tools_truncated', 'stop_reason', 'provider', 'providerReported', 'protocol_unknown_types', 'error'],
        additionalProperties: false,
      },
      render(_args: any, value: any) {
        const lines = [];
        if (value.ok) {
          lines.push(value.continued ? 'AtomCode 接续回复（侧边对话）:' : 'AtomCode 回复:', value.reply || '(空回复)', '');
          // A completed turn can still carry a mid-stream error event (the
          // daemon reported a problem, then the turn recovered and `done`
          // arrived). That caveat used to be erased at aggregation; showing it
          // here keeps red line 3 honest: the model must see "completed WITH a
          // reported failure", not a bare success.
          if (value.error) {
            lines.push(`[注意：本回合收到 done 但流中带有 error 事件，回复可能残缺: ${value.error}]`, '');
          }
          if (value.truncated) {
            lines.push('[注意：reply 已截断，让 AtomCode 把完整内容写到文件里再读]', '');
          }
          // Same reason as `truncated`: a clipped tool list reads as the full
          // story, and the model would then reason "it called 30 tools" when it
          // called more. `tool_calls` is printed below, so the pair is legible.
          if (value.tools_truncated) {
            lines.push(
              `[注意：tools 只回了前 ${TOOLS_CAP} 条，本回合工具调用不止这些（见 tool_calls）]`,
              '',
            );
          }
          if (value.providerReported === false) {
            lines.push('[注意：daemon 未报 runtime_info，provider= 是本插件回传请求值、未经远端证实（daemon 可能已升级）]', '');
          }
          // The drift shape NEITHER error path can report, because the turn
          // SUCCEEDED and carried content — so it reads as a clean turn unless
          // said out loud here. It is worse than a plain caveat: the round fuse
          // that bounds this turn counts `tool_start`, so a renamed tool event
          // leaves the fuse silently disarmed while every surface still reports
          // success. Say which of the two it is rather than hedging.
          if (Array.isArray(value.protocol_unknown_types) && value.protocol_unknown_types.length > 0) {
            lines.push(
              `[注意：本回合 daemon 发来本插件不认识的事件类型（${value.protocol_unknown_types.join(', ')}），` +
                'AtomCode 可能已升级或改了事件名。本端轮数熔断靠计数 tool_start 生效——' +
                (value.round_count === 0
                  ? '而本回合轮数为 0：若被改名的是这类事件，熔断此刻已是失效状态。'
                  : '若被改名的是这类事件，熔断会少计，下面的 round_count 偏小。') +
                '可调小 max_rounds 或人工盯防本轮]',
              '',
            );
          }
          const meta = [];
          meta.push(`session_id=${value.session_id}`);
          meta.push(`tokens=${value.tokens}`);
          if (value.round_count != null && value.round_count > 0) meta.push(`rounds=${value.round_count}`);
          meta.push(`tool_calls=${value.tool_calls}`);
          meta.push(`stop_reason=${value.stop_reason}`);
          meta.push(`provider=${value.provider}`);
          lines.push(`[${meta.join(' ')}]`);
        } else {
          lines.push(`AtomCode 调用失败: ${value.error}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: any, exec: any) {
      // Resolved ONCE, before any failure path, so a refused/failed turn still
      // reports which model the bridge was asking for (`empty()` below) instead
      // of a misleading 'default'. Ladder: argument > panel pick > patch field >
      // AtomCode's own default (send nothing).
      const askProvider = resolveProvider('ask', args.provider).name;
      const empty = (error: any) => ({
        ok: false,
        reply: '',
        session_id: '',
        continued: false,
        truncated: false,
        tokens: 0,
        tool_calls: 0,
        round_count: 0,
        tools: [],
        tools_truncated: false,
        stop_reason: '',
        provider: askProvider || 'default',
        providerReported: false,
        protocol_unknown_types: [],
        error,
      });
      const workDir =
        typeof args.working_dir === 'string' && args.working_dir.trim() !== ''
          ? args.working_dir
          : defaultWorkingDir;
      // Normalise the working directory so that `C:\Repo`, `c:\repo` and
      // `C:\repo\` all map to the SAME session key. `resolve` on Windows
      // uppercases the drive letter and collapses trailing slashes; on
      // POSIX it makes the path absolute. Without this, Windows users
      // silently get two session lines for the same repo.
      const sessionKey = workDir ? resolve(workDir) : 'default';

      let sessionId =
        typeof args.session_id === 'string' && args.session_id.trim() !== ''
          ? args.session_id.trim()
          : args.continue === true
            ? sessions.get(sessionKey)
            : undefined;

      // `reset_session` clears the stale mapping WITHOUT ending this turn's own
      // resume. An explicit `session_id` is the caller's own pin and always
      // wins: it is (re)recorded so the NEXT `continue: true` resumes it
      // instead of the stale one. Without a pin, the stale mapping is dropped
      // AND this turn does not resume it — "forget that line, start fresh".
      // This is the escape hatch the old code lacked (its `drop()` had no
      // caller, so a stale id could only be cleared by editing sessions.json).
      if (args.reset_session === true) {
        const pinned =
          typeof args.session_id === 'string' && args.session_id.trim() !== ''
            ? args.session_id.trim()
            : undefined;
        sessions.drop(sessionKey);
        if (pinned) sessions.set(sessionKey, pinned);
        else if (args.continue === true) sessionId = undefined;
      }
      // Computed AFTER the reset, so `continued` describes the session this
      // turn actually replayed (not the one that was just discarded).
      const continued = sessionId !== undefined;

      const t0 = Date.now();
      stats.ask.calls += 1;
      if (!(await ensureDaemon(exec?.signal))) {
        stats.ask.err += 1;
        stats.ask.msTotal += Date.now() - t0;
        // Cancel-during-startup is not a daemon outage; say which it was.
        return empty(
          exec?.signal?.aborted
            ? '已取消：调用方在等待 AtomCode daemon 就绪期间中止了本次调用'
            : `AtomCode daemon 不可用（http://127.0.0.1:${port}：${describeDaemonDown(stats.daemonDownReason)}${autoStart ? '，自动拉起也失败' : ''}）`,
        );
      }
      const timeoutMs =
        Number.isFinite(args.timeout_secs) && args.timeout_secs > 0
          ? Math.floor(args.timeout_secs) * 1000
          : 30 * 60 * 1000;
      // Same contract as the config field above: an explicit 0 is "no fuse", not
      // a missing value, so it must not fall back to the configured budget.
      // DELIBERATELY ASYMMETRIC with the review path below (mountReviewTool, this file):
      // there 0 means "unset -> use default 35", here 0 means "no fuse". Reason:
      // review forwards its fuse to the CLI as `--max-rounds`, and a literal 0
      // there aborts the review immediately (see review.ts buildReviewArgs), so
      // review cannot honour "0 = no fuse" without also changing that argv
      // contract. Ask governs the fuse in-process and has no such boundary.
      // Do NOT "unify" these two predicates — they encode different contracts.
      const maxRounds =
        Number.isFinite(args.max_rounds) && args.max_rounds >= 0 ? Math.floor(args.max_rounds) : askMaxRounds;
      const result = await askChat({
        message: String(args.message || ''),
        port,
        approvalMode,
        timeoutMs,
        // Forwarded unconditionally, 0 included: dropping it here would be the
        // same "0 is not honoured" bug one layer down.
        maxRounds,
        ...(sessionId ? { sessionId } : {}),
        ...(askProvider ? { provider: askProvider } : {}),
        ...(workDir ? { workingDir: workDir } : {}),
        ...(exec?.signal ? { signal: exec.signal } : {}),
      });
      stats.ask.msTotal += Date.now() - t0;
      if (result.ok) {
        stats.ask.ok += 1;
        if (Number.isFinite(result.tokens)) stats.ask.tokens += result.tokens;
      } else {
        stats.ask.err += 1;
      }
      // Accumulate protocol drift for the panel, on EVERY turn rather than only
      // successful ones: drift is a fact about the wire, not a property of the
      // reply, and a failed turn that still named an unknown type is exactly the
      // evidence a later diagnosis needs. Union, never replace — see the bag.
      for (const unknownType of result.unknownTypes) {
        if (!stats.protocolUnknownTypes.includes(unknownType)) stats.protocolUnknownTypes.push(unknownType);
      }
      if (result.ok && result.sessionId) sessions.set(sessionKey, result.sessionId);
      // Truncation is MARKED, never silent: a silently clipped 200KB reply reads
      // to the model like a complete answer, which is how a half-copied report
      // becomes a confidently wrong summary.
      const REPLY_CAP = 200_000;
      const truncated = result.reply.length > REPLY_CAP;
      const reply = truncated
        ? `${result.reply.slice(0, REPLY_CAP)}\n\n[truncated by dsh-connect-atomcode: ${
            result.reply.length - REPLY_CAP
          } more characters; ask AtomCode to write the full text to a file and read that instead]`
        : result.reply;
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
        protocol_unknown_types: result.unknownTypes,
        error: result.error,
      };
    },
  });

  return disposeAsk;
}

/**
 * `atomcode_review` — one-shot code review through the CLI subcommand.
 *
 * Same reason as mountAskTool() for building the description here: the note
 * about which provider will be used has to sit next to the `register()` that
 * ships it, so the two cannot describe different ladders.
 *
 * @returns {() => void} the tool’s disposer.
 */
function mountReviewTool({
  tools,
  config,
  runtime,
  log,
}: {
  tools: any;
  config: HostConfig;
  runtime: ReturnType<typeof createRuntime>;
  log: (message: any) => void;
}) {
  const {
    binary,
    reviewDefaultProvider,
    reviewWorkingDir,
    reviewNoWeb,
    reviewMaxRounds,
    reviewMaxDurationSecs,
  } = config;
  const {
    stats,
    resolveProvider,
    reviewProvision,
  } = runtime;

  // ── atomcode_review：one-shot 代码评审（CLI 子命令） ─────────────────────
  // Dynamically build the description: if the local config has no direct
  // [providers.<name>] entry with base_url that the review CLI can resolve,
  // prefix with a status warning.
  const reviewBaseDesc =
    '让本机 AtomCode（官方二进制）对一次代码变更做 one-shot 代码评审：默认评未提交改动；也可给 base 分支 / GitHub PR / diff 文本 / 自定义任务。' +
    '有界的一次性 agent 运行（轮数 + 墙钟双保险丝，默认关 web 搜索），完成时 report 里是 CLI 的 --json 原始文本（findings JSON，可能夹带日志行），需自己读出结论并转达用户。' +
    '注意 working_dir 缺省是插件配置的目录，插件也没配时是宿主进程的 cwd——评某个仓库务必显式传 working_dir。' +
    '可能数分钟。';
  const reviewUsableProviders = reviewProvision.providers || [];
  // Four different things can be named here and the model must not confuse them:
  // the per-call `provider` argument, the pick the panel wrote to provider.json,
  // the plugin's `review_default_provider`, and the `default_provider` key INSIDE
  // ~/.atomcode/config.toml (which the CLI consults itself). Spell each one out.
  //
  // Phrased as an ORDER with the refusal made CONDITIONAL, not as a claim about
  // the outcome. A tool description is registered ONCE at mount, while the panel
  // pick is read PER CALL — so any unconditional sentence ("留空即点名它" / "留空会
  // 被要求点名") is a coin flip on being false by the next turn. The first version
  // of this note stated both outcomes at once and an external review caught it;
  // the second version would have gone stale the moment someone touched the
  // dropdown. This form stays true in every state.
  const reviewProviderNote =
    reviewUsableProviders.length === 0
      ? ''
      : `（本机可用的直连 provider：${reviewUsableProviders.join(' / ')}；` +
        'provider 留空时按顺序取：详情页面板选的条目 → 插件配置 review_default_provider' +
        `（当前${reviewDefaultProvider ? `="${reviewDefaultProvider}"` : '未配'}）` +
        ' → config.toml 的 default_provider → 唯一的可用直连条目自动顶上；' +
        '只有前面几档都没配上、而本机又存在多个可用直连条目时才会要求你点名，不会替你猜计费通道）';
  const reviewDesc = reviewProvision.available
    ? reviewBaseDesc + reviewProviderNote
    : `注意：本机 AtomCode 配置下 review CLI 不可用（${reviewProvision.reason}），只能走 daemon 侧的 atomcode_ask 做侧边咨询或让 AtomCode 评审。` +
      reviewBaseDesc;

  const disposeReview = tools.register({
    name: 'atomcode_review',
    // timeoutMs: the review CLI has its own max_duration fuse; set 30min so
    // the host guard never kills before the CLI's own fuse.
    timeoutMs: 30 * 60 * 1000,
    description: reviewDesc,
    parameters: {
      type: 'object',
      properties: {
        working_dir: { type: 'string', description: '仓库根目录（--repo）。必填（或用插件配置的 review_working_dir）——不传会报错而不是悄悄评错仓库' },
        task: { type: 'string', description: '可选：自定义任务文本，替代 diff 评审（问题/目标代码/上下文都写进来）' },
        base: { type: 'string', description: '可选：base git ref，评审 <base>...HEAD；缺省评未提交改动' },
        staged: { type: 'boolean', description: '可选：只评已暂存改动（git diff --staged）' },
        pr: { type: 'number', description: '可选：GitHub PR 号（需本机 gh CLI）' },
        diff_text: { type: 'string', description: '可选：原始 diff 文本（写临时文件走 --diff-file；适合非 git 场景/CI 产物）' },
        provider: { type: 'string', description: '可选：点名 AtomCode provider，原样透传给 review CLI 的 --provider。名字以 ~/.atomcode/config.toml 的 [providers.<name>] 条目为准（这条路径不看 daemon /models，也不是裸模型 id——别传 "glm5.3-flash"）；要换该 provider 用的模型，改它条目里的 model。留空时按顺序取：面板上选的条目 → 插件配置 review_default_provider → config.toml 的 default_provider → 自动选择（见工具描述）' },
        max_rounds: { type: 'number', description: '可选：评审 agent 轮数保险丝（默认取插件配置，通常 ' + reviewMaxRounds + '）' },
        max_duration_secs: { type: 'number', description: '可选：墙钟保险丝秒数（默认取插件配置，通常 900）。有效上限约 1740s——进程级兜底取 maxDuration+60s，超过宿主 30min 工具超时就会先被宿主杀掉' },
        enable_web: { type: 'boolean', description: '可选：允许评审用 web_search（默认 false，适配受限网络）' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          report: { type: 'string' },
          truncated: { type: 'boolean', description: 'report 超过上限被截断（findings 原文不完整，必要时改用 task 缩小范围）' },
          error: { type: 'string' },
          exit_code: { type: 'number', description: '进程退出码；-1 = 未能启动，或被信号终止（超时/取消）。两种含义共用 -1（被信号杀时真实 code 为 null），具体原因看 error' },
          duration_ms: { type: 'number' },
        },
        required: ['ok', 'report', 'truncated', 'error', 'exit_code', 'duration_ms'],
        additionalProperties: false,
      },
      render(_args: any, value: any) {
        const lines = [];
        if (value.ok) {
          lines.push(`AtomCode 评审完成（${Math.round(value.duration_ms / 1000)}s）:`, value.report || '(空 findings)');
          if (value.truncated) lines.push('[注意：findings 已截断，末尾内容不完整]');
        } else {
          lines.push(`AtomCode 评审失败: ${value.error}`);
          if (value.report) lines.push('--- 部分输出 ---', value.report.slice(0, 5000));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: any, exec: any) {
      // Repo requirement FIRST: a missing repository is the caller's own
      // mistake, and reporting it beats both reviewing the wrong tree and
      // burying it under a config diagnostic. The host process cwd is an
      // implementation detail of how DSH was launched, never the user's repo.
      const workDir =
        typeof args.working_dir === 'string' && args.working_dir.trim() !== ''
          ? args.working_dir
          : reviewWorkingDir;
      if (!workDir) {
        stats.review.calls += 1;
        stats.review.err += 1;
        return {
          ok: false,
          report: '',
          truncated: false,
          error:
            'atomcode_review needs a repository: pass working_dir (<repo root>), or set the plugin config ' +
            '`review_working_dir`. Falling back to the host process cwd would review the ' +
            'wrong tree (or nothing) while reporting success.',
          exit_code: -1,
          duration_ms: 0,
        };
      }
      // The mount-time probe is only a hint in the DESCRIPTION; the truth is
      // re-read here, so a config.toml edit after mount is honoured. It is
      // stronger than a description warning: the call is refused before it
      // spawns a process that would fail with a diagnostic aimed at a human.
      const currentProvision = checkReviewProvision();
      if (!currentProvision.available) {
        stats.review.calls += 1;
        stats.review.err += 1;
        return {
          ok: false,
          report: '',
          truncated: false,
          error:
            `atomcode_review is unavailable on this host: ${currentProvision.reason} ` +
            'Use atomcode_ask instead (the daemon carries the AtomGit gateway signing). ' +
            'If this looks wrong, fix ~/.atomcode/config.toml and retry — this check re-reads it on every call.',
          exit_code: -1,
          duration_ms: 0,
        };
      }
      // Which direct provider will this run use? The CLI's own default is
      // default_provider, which on an AtomGit login host has no base_url ("missing
      // base URL") even when a usable direct entry exists — selection makes that
      // an explicit, single-candidate auto-pick (or a named refusal when several
      // candidates exist, never a guess about which channel to bill).
      // Same ladder as ask, different namespace: argument > panel pick >
      // review_default_provider > the CLI's own auto-selection (红线 8).
      const selection = selectReviewProvider(resolveProvider('review', args.provider).name);
      if (selection.error) {
        stats.review.calls += 1;
        stats.review.err += 1;
        return {
          ok: false,
          report: '',
          truncated: false,
          error: `atomcode_review: ${selection.error}`,
          exit_code: -1,
          duration_ms: 0,
        };
      }
      if (selection.auto) {
        log(`review provider auto-selected: ${selection.provider} — ${selection.reason}`);
      }
      // A loopback base_url means a local sidecar process (e.g. the
      // atomcode-open-api proxy) is a live dependency: probe it BEFORE spawning
      // so a dead proxy yields this named diagnostic instead of the CLI's opaque
      // "review did not complete (initial pass: Cancelled)". Remote base_urls are
      // deliberately not probed — this host's egress is proxy-gated, and a probe
      // false-negative would refuse a call the CLI could have completed.
      if (selection.baseUrl && isLoopbackBaseUrl(selection.baseUrl)) {
        const probe = await probeLocalEndpoint(selection.baseUrl);
        if (!probe.alive) {
          stats.review.calls += 1;
          stats.review.err += 1;
          return {
            ok: false,
            report: '',
            truncated: false,
            error:
              `atomcode_review: local provider endpoint ${selection.baseUrl} (provider "${selection.provider}") ` +
              `is not responding (${probe.detail}; tried ${probe.tried.join(', ') || 'no URL'}). ` +
              `${PROVIDER_FIX} ` +
              'Daemon-side atomcode_ask is unaffected (it does not go through this endpoint).',
            exit_code: -1,
            duration_ms: 0,
          };
        }
      }
      // Normalize to positive numbers here too (mirrors buildReviewArgs) so the
      // process-level backstop is computed from the same values the CLI gets.
      // DELIBERATELY ASYMMETRIC with the ask path (mountAskTool, this file): there 0
      // means "no fuse", here 0 means "unset -> use default 35". An explicit 0
      // is NOT "no fuse" because review forwards the fuse to the CLI as
      // `--max-rounds`, and a literal 0 would abort the review immediately
      // (see review.ts buildReviewArgs). Honouring "0 = no fuse" here would
      // require changing that argv contract first. The two predicates are
      // intentionally different; do not merge them blindly.
      const maxRounds =
        Number.isFinite(args.max_rounds) && args.max_rounds > 0
          ? Math.floor(args.max_rounds)
          : reviewMaxRounds;
      const maxDurationSecs =
        Number.isFinite(args.max_duration_secs) && args.max_duration_secs > 0
          ? Math.floor(args.max_duration_secs)
          : reviewMaxDurationSecs;
      const t0 = Date.now();
      stats.review.calls += 1;
      const result = await runReview({
        workingDir: workDir,
        ...(typeof args.task === 'string' && args.task.trim() !== '' ? { task: args.task } : {}),
        ...(typeof args.base === 'string' && args.base.trim() !== '' ? { base: args.base } : {}),
        ...(args.staged === true ? { staged: true } : {}),
        ...(Number.isFinite(args.pr) && args.pr > 0 ? { pr: args.pr } : {}),
        ...(typeof args.diff_text === 'string' && args.diff_text.trim() !== '' ? { diffText: args.diff_text } : {}),
        ...(selection.provider ? { provider: selection.provider } : {}),
        maxRounds,
        maxDurationSecs,
        // Independent process-level backstop: fires only if the CLI overruns its
        // own --max-duration (the CLI stops itself and reports findings, which is
        // the graceful path). Without this the bridge would wait forever.
        timeoutMs: (maxDurationSecs + 60) * 1000,
        noWeb: args.enable_web === true ? false : reviewNoWeb,
        ...(binary ? { binary } : {}),
        ...(exec?.signal ? { signal: exec.signal } : {}),
        log,
      });
      stats.review.msTotal += Date.now() - t0;
      if (result.ok) stats.review.ok += 1;
      else stats.review.err += 1;
      const REPORT_CAP = 200_000;
      const truncated = result.report.length > REPORT_CAP;
      return {
        ok: result.ok,
        report: truncated
          ? `${result.report.slice(0, REPORT_CAP)}\n\n[truncated by dsh-connect-atomcode: ${
              result.report.length - REPORT_CAP
            } more characters]`
          : result.report,
        truncated,
        error: result.error,
        exit_code: result.exitCode ?? -1,
        duration_ms: result.durationMs,
      };
    },
  });

  return disposeReview;
}

export function apply(ctx: any, rawConfig: Record<string, any> = {}) {
  // Resolved once, here, and handed to every mount function as the whole
  // `config` object — each one destructures only the fields it consumes, so a
  // field nobody reads any more disappears from a short list instead of
  // lingering as a stale binding at the top of a long function. Same names
  // everywhere, on purpose: a move that also renamed things would stop being
  // readable as proof that nothing else changed.
  const config = readConfig(rawConfig);

  // `log` lives before its other uses so the store’s observer can share the one
  // `[atomcode-bridge]` prefix instead of re-typing it (and so a second logger
  // call site cannot drift from it).
  const log = (message: any) => ctx.logger?.warn(`[atomcode-bridge] ${message}`);

  // An UNDETERMINED profile is named at mount, not left to be discovered as a
  // wrong continuation weeks later: with no prefix, both profiles write the same
  // `default::` key in the shared sessions.json, so a `continue: true` in one
  // resumes the other’s side conversation — a wrong-context answer with no trace
  // of why. Named here (红线 3), and fixable by the user with one config line.
  if (config.sessionKeyPrefixSource === 'none') {
    log(
      '无法判定 DSH profile（DSH_PROFILE 未设置，argv 里也没有 dsh 的 web/desktop 子命令）：' +
        'sessions.json 将不带 profile 前缀。若本机同时跑 web 与 desktop，两侧的会话续接会共用同一个键、互相串线——' +
        '在插件配置里设 session_key_prefix 可消除歧义。',
    );
  }

  // Everything that accumulates across the mount — the live stats bag, the two
  // state stores, daemon liveness and spawning, the quota cache and the
  // panel-facing state — lives in one object rather than as ~420 lines of
  // closures declared right here.
  const runtime = createRuntime({ config, log });

  const tools = ctx.get('tools');
  if (tools === undefined) return; // inject declares it; belt and braces.

  // Each tool owns its own description string end to end.
  const disposeAsk = mountAskTool({ tools, config, runtime });
  const disposeReview = mountReviewTool({ tools, config, runtime, log });

  // `webServer` is declared in `inject`, but degrade quietly if a host mounts
  // this plugin without the route service rather than failing the whole mount.
  const webServer = ctx.get ? ctx.get('webServer') : ctx.webServer;
  // Both routes — the stats read and the panel's provider write — now live in
  // mountRoutes(): `webServer` is their only outside dependency, and both read
  // the same runtime, so they are mounted and disposed as one unit.
  const disposeRoutes = mountRoutes({ webServer, runtime, log });

  // NOTE: the daemon is intentionally NOT started at mount. Mounting a plugin
  // should not spawn background processes. `auto_start: true` is honored at the
  // two places the daemon is actually needed: the ask path (which awaits it) and
  // the stats route (which kicks it off), so simply LOOKING at the panel or the
  // composer chip is enough to bring it up — no tool call required.

  // Teardown only runs when the plugin unmounts: `ctx.effect(fn)` executes `fn`
  // at setup and treats its RETURN VALUE as the cleanup, so the disposers must
  // be returned (not invoked in the body — that would unregister the tools
  // immediately). Matches the dsh-connect-sensenova-token-plan pattern.
  ctx.effect(() => {
    return () => {
      disposeAsk();
      disposeReview();
      // One call for both routes: mountRoutes() composed them, so a route added
      // there cannot be forgotten here (which is how the four separate checks
      // that used to live on these lines let a fifth disposer go missing).
      disposeRoutes();
    };
  });
}
