/**
 * Host-side status snapshot helpers (read-only, same-origin).
 *
 * Extracted from `src/host/index.ts` (apply() split). Mirrors the
 * dsh-connect-sensenova-token-plan snapshot route contract so the plugin
 * detail-page client can poll live startup/usage stats. Every function here is
 * pure: they take plain values and return plain values, so a caller can build a
 * snapshot body from a stats bag + a quota report without touching the network.
 *
 * `createStatsBag` lives HERE, next to its only reader (`buildStatsBody`), and
 * that placement is the point: the field names and the one function that reads
 * them are on one screen, so a rename cannot land on one end only. See
 * `StatsBag` for what that replaced.
 *
 * The `version` literal is passed in rather than hardcoded here: the release
 * discipline pins `package.json` and `src/host/index.ts` (the assembly point)
 * as the two hand-edited places that must agree, and `test/wiring.test.mjs`
 * asserts the literal lives in `src/host/index.ts`.
 *
 * @module dsh-connect-atomcode/host/stats
 */
import type { HealthFailure } from './daemon.ts';
import type { InFlightTurn, StatsSnapshot } from '../shared/stats.ts';
import { DAEMON_PROBE_TIMEOUT_MS } from './config.ts';

/** Host-side status endpoint helper (read-only, same-origin). */
export function writeJson(res: any, status: number, body: unknown, headers?: Record<string, string>) {
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
export function sameOrigin(request: any) {
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
export function describeDaemonDown(reason: HealthFailure): string {
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
      // The CLASSIFIED catch-all: the fetch failed, for a cause `probeFailure`
      // looked at and could not name. That is an answer — "we checked, we cannot
      // tell" — and it is deliberately not the same thing as `default`.
      return '探活失败，原因未能归类';
    case '':
      // Down, but no probe has finished yet — the panel can ask before the
      // mount's first probe resolves. Not a failure, and not worth inventing one.
      return '尚未探活';
    default:
      // Unreachable against the `HealthFailure` union, but REACHABLE at runtime:
      // a caller — or an older `lib/daemon.js` — can hand this a value this build
      // does not know. It used to return the SAME sentence as `unreachable`,
      // which made the two indistinguishable on the one surface that reads them
      // (红线 3: a panel that cannot tell "unclassified" from "unknown value"
      // has already lost the distinction). An unrecognized classification is
      // itself a drift signal (事实 3), so name the value instead of folding it
      // into the catch-all that means "we looked and found nothing to name".
      return `探活失败，归类「${String(reason)}」本版本不认识`;
  }
}

/**
 * One row of the ask dropdown: the model PROFILE name the dropdown sends, and
 * whether AtomCode itself treats it as the default. Only what the panel
 * consumes — `refreshModelCatalog` deliberately maps nothing else in.
 */
export interface ModelCatalogEntry {
  provider: string;
  isDefault: boolean;
}

/**
 * The live runtime bag — every field name `buildStatsBody` reads, as a TYPE.
 *
 * This is the same answer `config.ts` gave `HostConfig`, applied to the one
 * place that did not have it. The bag was `Record<string, any>`: nested
 * counters, caches, per-branch state, forty-five top-level names written by
 * eight closures in `runtime.ts`, `routes.ts`, `tools.ts` and `index.ts`, and
 * read by exactly one function. The runtime's own header named the disease
 * ("a closure is an INVISIBLE dependency… the type system had nothing to say
 * about those writes either") and the configuration was locked with a derived
 * type in the SAME release — so a mistyped field here was a silently empty
 * panel card (红线 3's forbidden shape), not a compile error.
 *
 * What it buys, concretely:
 *
 *  - a write of a field nobody declared is TS2339 (`stats.daemonUpX = true`);
 *  - a read in `buildStatsBody` of a field the bag never declared is TS2339;
 *  - a writer that assigns the WRONG shape to a declared field is caught too,
 *    which the old `any` could not do: `daemonDownReason` is `HealthFailure`,
 *    so `stats.daemonDownReason = 'not-responding'` no longer typechecks against
 *    the same union `describeDaemonDown` switches on.
 *
 * The fields are grouped in the order `buildStatsBody` reports them, so the
 * reader can walk both without a search.
 */
export interface StatsBag {
  // ── identity / uptime ─────────────────────────────────────────────────────
  startedAt: number;
  /** The hand-edited literal in `src/host/index.ts`, passed in at mount. */
  pluginVersion: string;
  // ── the mount's resolved configuration, mirrored for the panel ────────────
  port: number;
  autoStart: boolean;
  /**
   * The patch row's `binary` PATH, or null when it is unset.
   *
   * A path, not a flag — see `binary.configured` in `buildStatsBody` for why that
   * distinction turned out to be a live bug rather than a style choice.
   */
  binaryPath: string | null;
  binaryEnv: string | undefined;
  approvalMode: string;
  /**
   * The off-enum `approval_mode` spelling the patch supplied, or null when the
   * resolved value is legal. A configuration FACT, so it travels in the `config`
   * branch beside `approvalMode` — which is the value the code actually honours.
   */
  approvalModeRejected: string | null;
  defaultWorkingDir: string | null;
  reviewWorkingDir: string | null;
  defaultProvider: string | null;
  reviewDefaultProvider: string | null;
  // ── the panel's own state: its picks, and what the NEXT call will use ──────
  panelProvider: { ask: string | null; review: string | null };
  panelStorePath: string;
  panelStoreError: string;
  panelStoreForeign: boolean;
  effectiveAsk: string | null;
  /** 'panel' | 'config' | 'atomcode' — see `resolveProvider`. */
  effectiveAskSource: string;
  effectiveReview: string | null;
  /** 'panel' | 'config' | 'auto' — NOT 'atomcode' (红线 8). */
  effectiveReviewSource: string;
  modelCatalog: ModelCatalogEntry[] | null;
  modelCatalogAt: number;
  modelCatalogError: string;
  reviewCatalog: string[];
  reviewEndpoints: Record<string, string>;
  // ── daemon liveness + the auto-start bookkeeping ──────────────────────────
  daemonUp: boolean;
  daemonVersion: string;
  /** WHY it is down; `''` while up. Drives both `describeDaemonDown` readers. */
  daemonDownReason: HealthFailure;
  spawnTried: boolean;
  spawnAttempts: number;
  spawnFailures: number;
  lastSpawnAt: number;
  daemonStarting: boolean;
  lastHealthAt: number;
  reviewAvailable: boolean;
  reviewReason: string;
  // ── session glue ──────────────────────────────────────────────────────────
  sessionsTracked: number;
  /**
   * Age in ms of the oldest still-resumable session key (null when there is
   * none, or when its age is unknown). The map used to grow without bound and
   * nothing showed it — `tracked` alone cannot distinguish "one fresh line"
   * from "nine dead ids from last week".
   */
  sessionsOldestAgeMs: number | null;
  /** Why session glue is degraded right now (`''` when healthy). */
  sessionsError: string;
  // ── the two patch-only knobs, plus which of them the user authored ────────
  askRounds: number;
  retrySecs: number;
  authored: { approvalMode: boolean; workingDir: boolean; askMaxRounds: boolean };
  defaults: { approvalMode: string; askMaxRounds: number };
  // ── drift signals ─────────────────────────────────────────────────────────
  quotaDriftSeen: boolean;
  /** A UNION across the mount, never replaced — see `askChat`. */
  protocolUnknownTypes: string[];
  // ── counters. `ask` carries tokens; `review` has no such reading ──────────
  ask: {
    calls: number;
    ok: number;
    err: number;
    msTotal: number;
    tokens: number;
    /**
     * The ask turn running right now, or null.
     *
     * Held as a live object (with a start TIMESTAMP) rather than as the wire
     * shape: `elapsedMs` has to be computed when the snapshot is built, or the
     * panel would either render a frozen age or do clock arithmetic against a
     * server clock it cannot see. Cleared in a `finally` around the call, so
     * every exit path — success, daemon error, timeout, fuse, cancel — ends the
     * row; a "running" row that outlives its turn is worse than no row.
     *
     * ONE slot on the wire, so two overlapping asks show the NEWEST one — but
     * "newest" is recomputed on every exit rather than left as whatever was
     * written last (see `endInFlight`): the newest turn can finish FIRST, and a
     * plain `= null` there would blank the row while the older turn is still
     * running. That is the one ordering the identity check alone cannot see.
     * A per-turn LIST on the wire would say "2 in flight" for a panel that can
     * only usefully show one, so `askLive` stays host-side.
     */
    inFlight: LiveTurn | null;
  };
  /**
   * Every ask turn live right now, oldest first. HOST-ONLY bookkeeping.
   *
   * Kept OUTSIDE `ask` on purpose: `buildStatsBody` spreads `stats.ask` straight
   * onto the wire, so anything added inside that object ships whether or not the
   * shared contract declares it. This array only exists so `endInFlight` can
   * answer "after this one ends, which turn — if any — is still running?".
   */
  askLive: LiveTurn[];
  review: { calls: number; ok: number; err: number; msTotal: number };
}

/**
 * An in-flight ask turn as the host tracks it: the wire fields plus the start
 * timestamp they are derived from. See `InFlightTurn` (shared) for why the
 * elapsed time is not sent as a timestamp.
 */
export interface LiveTurn {
  startedAt: number;
  workingDir: string | null;
  provider: string;
  rounds: number;
  completed: number;
  chars: number;
  sessionId: string;
  lastTool: string;
  tokens: number;
}

/**
 * The mount-time facts the bag is seeded with. Everything NOT here starts at its
 * empty value inside `createStatsBag` — which is the useful split: this list is
 * "what the mount resolved", and reading it is how a caller sees at a glance
 * which panel numbers come from configuration and which are runtime readings.
 */
export interface StatsSeed {
  pluginVersion: string;
  port: number;
  autoStart: boolean;
  binaryPath: string | null;
  binaryEnv: string | undefined;
  approvalMode: string;
  approvalModeRejected: string | null;
  defaultWorkingDir: string | null;
  reviewWorkingDir: string | null;
  defaultProvider: string | null;
  reviewDefaultProvider: string | null;
  panelStorePath: string;
  reviewCatalog: string[];
  reviewEndpoints: Record<string, string>;
  reviewAvailable: boolean;
  reviewReason: string;
  askRounds: number;
  retrySecs: number;
  authored: { approvalMode: boolean; workingDir: boolean; askMaxRounds: boolean };
  defaults: { approvalMode: string; askMaxRounds: number };
}

/**
 * Build the live stats bag. One construction site, total: every field is
 * initialized here, so there is no such thing as a bag that is half-built, and
 * no field exists only as a write some closure performs later.
 *
 * @param {StatsSeed} seed - the mount-resolved values (see `StatsSeed`).
 */
export function createStatsBag(seed: StatsSeed): StatsBag {
  return {
    startedAt: Date.now(),
    pluginVersion: seed.pluginVersion,
    port: seed.port,
    autoStart: seed.autoStart,
    binaryPath: seed.binaryPath,
    binaryEnv: seed.binaryEnv,
    approvalMode: seed.approvalMode,
    approvalModeRejected: seed.approvalModeRejected,
    defaultWorkingDir: seed.defaultWorkingDir,
    reviewWorkingDir: seed.reviewWorkingDir,
    defaultProvider: seed.defaultProvider,
    reviewDefaultProvider: seed.reviewDefaultProvider,
    panelProvider: { ask: null, review: null },
    panelStorePath: seed.panelStorePath,
    panelStoreError: '',
    panelStoreForeign: false,
    effectiveAsk: null,
    effectiveAskSource: 'atomcode',
    effectiveReview: null,
    effectiveReviewSource: 'auto',
    modelCatalog: null,
    modelCatalogAt: 0,
    modelCatalogError: '',
    reviewCatalog: seed.reviewCatalog,
    reviewEndpoints: seed.reviewEndpoints,
    daemonUp: false,
    daemonVersion: '',
    daemonDownReason: '',
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
    sessionsError: '',
    askRounds: seed.askRounds,
    retrySecs: seed.retrySecs,
    authored: seed.authored,
    defaults: seed.defaults,
    quotaDriftSeen: false,
    protocolUnknownTypes: [],
    ask: { calls: 0, ok: 0, err: 0, msTotal: 0, tokens: 0, inFlight: null },
    askLive: [],
    review: { calls: 0, ok: 0, err: 0, msTotal: 0 },
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
export function buildStatsBody(stats: StatsBag, quota: any): StatsSnapshot {
  return {
    ok: true,
    name: 'dsh-connect-atomcode',
    displayName: 'DSH AtomCode Bridge',
    version: stats.pluginVersion,
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
      // The PATH the daemon will be launched with, not a flag. The panel's row
      // reads `configured || env || '自动探测（PATH）'` and renders the winner, so a
      // boolean here made the row EMPTY exactly when a binary was configured
      // (React drops a `true` child) while also masking `env` — the silently
      // blank row this panel exists to avoid. `source` already answers "where did
      // it come from", so nothing was lost by making this the value.
      configured: stats.binaryPath,
      env: stats.binaryEnv,
      source: stats.binaryPath ? 'config' : stats.binaryEnv ? 'env' : 'auto',
    },
    config: {
      approvalMode: stats.approvalMode,
      approvalModeRejected: stats.approvalModeRejected,
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
    sessions: {
      tracked: stats.sessionsTracked,
      oldestAgeMs: stats.sessionsOldestAgeMs,
      error: stats.sessionsError,
    },
    ask: { ...stats.ask, inFlight: viewInFlight(stats.ask.inFlight) },
    review: stats.review,
  };
}

/**
 * Turn the host's live record into the wire shape, or `null` when nothing is
 * running.
 *
 * The elapsed time is measured HERE, at snapshot build time, so the client
 * renders an age it was handed instead of subtracting two clocks — with a
 * client/server offset it would otherwise show a turn that started in the
 * future, which is the kind of number a reader trusts less than a blank.
 */
function viewInFlight(turn: LiveTurn | null): InFlightTurn | null {
  if (!turn) return null;
  return {
    elapsedMs: Math.max(0, Date.now() - turn.startedAt),
    rounds: turn.rounds,
    completed: turn.completed,
    chars: turn.chars,
    sessionId: turn.sessionId,
    lastTool: turn.lastTool,
    tokens: turn.tokens,
    workingDir: turn.workingDir,
    provider: turn.provider,
  };
}

/**
 * Register an ask turn as live and make it the row the panel shows.
 *
 * Exists as a function rather than the two writes it replaces so the slot and
 * the bookkeeping array can never disagree: the panel's newest-wins rule is
 * recomputed from `askLive` on every exit, so a turn pushed without becoming
 * `inFlight` would be invisible until the next turn ends.
 */
export function beginInFlight(stats: StatsBag, turn: LiveTurn): void {
  stats.askLive.push(turn);
  stats.ask.inFlight = turn;
}

/**
 * Retire an ask turn and re-point `inFlight` at whatever is STILL running.
 *
 * The old code nulled the slot behind an identity check, which covered "an
 * older turn finishes while a newer one runs" but not the reverse: the newer
 * turn finishing first nulled the row while the older turn was still executing,
 * and the panel said no turn was in flight. Recomputing from `askLive` covers
 * both orderings; `indexOf` (not blind pop) keeps a double-`finally` — or a
 * turn that never registered — from retiring somebody else's row.
 */
export function endInFlight(stats: StatsBag, turn: LiveTurn): void {
  const at = stats.askLive.indexOf(turn);
  if (at >= 0) stats.askLive.splice(at, 1);
  // `?? null` because indexing is `LiveTurn | undefined` under
  // `noUncheckedIndexedAccess` — the length check is what makes it real.
  stats.ask.inFlight = (stats.askLive.length > 0 ? stats.askLive[stats.askLive.length - 1] : null) ?? null;
}