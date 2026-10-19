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
import type { AskUsageCounters } from './usage-store.ts';
import type { UsageTrend } from './codingplan.ts';

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
  effortLevels?: string[];
  currentEffort?: string | null;
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
  /**
   * The resolved `review_brief_mode` (always / when-empty / never) — which prompt
   * shape a review with empty user text takes. Mirrored for the panel the same
   * way `approvalMode` is: a resolved CONFIGURATION fact, not a runtime reading.
   */
  reviewBriefMode: string;
  /** The off-enum `review_brief_mode` spelling, or null when legal. Same shape as `approvalModeRejected`. */
  reviewBriefModeRejected: string | null;
  defaultWorkingDir: string | null;
  defaultProvider: string | null;
  // ── the panel's own state: its pick, and what the NEXT call will use ───────
  /**
   * The panel's stored pick, one name for the whole plugin.
   *
   * It used to be `{ask, review}` — two picks for two provider namespaces
   * (红线 8). The `[providers.<name>]` namespace died with the review CLI, so
   * there is one question left ("which model profile do bridged turns ask for")
   * and one answer to it.
   */
  panelProvider: string | null;
  panelStorePath: string;
  panelStoreError: string;
  panelStoreForeign: boolean;
  effectiveAsk: string | null;
  /** 'panel' | 'config' | 'atomcode' — see `resolveProvider`. */
  effectiveAskSource: string;
  modelCatalog: ModelCatalogEntry[] | null;
  modelCatalogAt: number;
  modelCatalogError: string;
  /**
   * The per-day CodingPlan usage branch (`GET /codingplan/usage/daily`), or null
   * before the first read. Stored as the finished branch, not as raw rows: the
   * reader is a renderer, and every decision about what to keep was made where
   * the payload was parsed (`codingplan.ts`).
   */
  usageTrend: UsageTrend | null;
  // ── panel settings (briefMode + workingDir + approvalMode + askMaxRounds overrides) ──
  panelBriefMode: string | null;
  panelWorkingDir: string | null;
  panelApprovalMode: string | null;
  panelAskMaxRounds: number | null;
  panelSettingsStorePath: string;
  panelSettingsError: string;
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
  authored: { approvalMode: boolean; workingDir: boolean; askMaxRounds: boolean; reviewBriefMode: boolean };
  defaults: { approvalMode: string; askMaxRounds: number; reviewBriefMode: string };
  // ── drift signals ─────────────────────────────────────────────────────────
  quotaDriftSeen: boolean;
  /** A UNION across the mount, never replaced — see `askChat`. */
  protocolUnknownTypes: string[];
  // ── counters. `ask` is the one tool that reports here (and the only one
  //    carrying a token reading); `review` is a retained wire slot with no
  //    writer — see the field's own comment below. ──────────────────────────
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
  /**
   * Always zero. It counted calls to the retired `atomcode_review` tool, and a
   * review is now an ask turn counted in `ask` — no code path increments this.
   * It is still built into the snapshot because the shared contract declares it
   * (`shared/stats.ts`) and an already-loaded panel build may read it.
   *
   * Kept rather than deleted so the wire shape does not change under a renderer
   * that is older than the retirement; the panel itself renders no row for it.
   */
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
  reviewBriefMode: string;
  reviewBriefModeRejected: string | null;
  defaultWorkingDir: string | null;
  defaultProvider: string | null;
  panelStorePath: string;
  panelSettingsStorePath: string;
  askRounds: number;
  retrySecs: number;
  authored: { approvalMode: boolean; workingDir: boolean; askMaxRounds: boolean; reviewBriefMode: boolean };
  defaults: { approvalMode: string; askMaxRounds: number; reviewBriefMode: string };
  /**
   * The ask counters carried over from `usage.json`, so the panel's 累计 reads
   * across restarts rather than only for this mount. Omitted (or all zeroes)
   * when there is nothing to carry over — the caller reads the store at mount
   * and hands its answer here; `createStatsBag` never touches the disk itself.
   */
  persistedAsk?: AskUsageCounters;
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
    reviewBriefMode: seed.reviewBriefMode,
    reviewBriefModeRejected: seed.reviewBriefModeRejected,
    defaultWorkingDir: seed.defaultWorkingDir,
    defaultProvider: seed.defaultProvider,
    panelProvider: null,
    panelStorePath: seed.panelStorePath,
    panelStoreError: '',
    panelStoreForeign: false,
    effectiveAsk: null,
    effectiveAskSource: 'atomcode',
    modelCatalog: null,
    modelCatalogAt: 0,
    modelCatalogError: '',
    usageTrend: null,
    panelBriefMode: null,
    panelWorkingDir: null,
    panelApprovalMode: null,
    panelAskMaxRounds: null,
    panelSettingsStorePath: seed.panelSettingsStorePath,
    panelSettingsError: '',
    daemonUp: false,
    daemonVersion: '',
    daemonDownReason: '',
    spawnTried: false,
    spawnAttempts: 0,
    spawnFailures: 0,
    lastSpawnAt: 0,
    daemonStarting: false,
    lastHealthAt: 0,
    sessionsTracked: 0,
    sessionsOldestAgeMs: null,
    sessionsError: '',
    askRounds: seed.askRounds,
    retrySecs: seed.retrySecs,
    authored: seed.authored,
    defaults: seed.defaults,
    quotaDriftSeen: false,
    protocolUnknownTypes: [],
    ask: {
      calls: seed.persistedAsk?.calls ?? 0,
      ok: seed.persistedAsk?.ok ?? 0,
      err: seed.persistedAsk?.err ?? 0,
      msTotal: seed.persistedAsk?.msTotal ?? 0,
      tokens: seed.persistedAsk?.tokens ?? 0,
      inFlight: null,
    },
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
      reviewBriefMode: stats.reviewBriefMode,
      reviewBriefModeRejected: stats.reviewBriefModeRejected,
      defaultWorkingDir: stats.defaultWorkingDir,
      // The model profile bridged turns ask for when the call names none. On the
      // snapshot rather than hidden in the mount: a typo'd profile is only
      // diagnosable if the panel says which default the bridge is pinning.
      // There used to be a second row here for the review CLI's own namespace
      // (红线 8); that namespace died with the CLI, and this bridge now has one
      // knob and one name for it.
      defaultProvider: stats.defaultProvider,
      askMaxRounds: stats.askRounds,
      daemonRetrySecs: stats.retrySecs,
      // Which of the patch-only knobs the USER actually authored, and what the
      // built-in fallback is. The panel cannot edit these (no input exists), so
      // without this it can only print a value and let the reader guess whether it
      // is a live setting or our own default — and guessing is how the panel ended
      // up reporting six constant rows. Reporting the default here (rather than
      // hardcoding it client-side) keeps ONE source of truth for `25`.
      authored: stats.authored,
      defaults: stats.defaults,
      // Panel-side overrides, read per call from panel-settings.json.
      // null = no override, the patch value applies.
      panelBriefMode: stats.panelBriefMode,
      panelWorkingDir: stats.panelWorkingDir,
      panelApprovalMode: stats.panelApprovalMode,
      panelAskMaxRounds: stats.panelAskMaxRounds,
      panelSettingsStorePath: stats.panelSettingsStorePath,
      panelSettingsError: stats.panelSettingsError,
    },
    // `effective` answers the question a click raises — "what will the NEXT call
    // actually use, and why" — so a pick that did not take effect is visible on
    // the panel instead of being a mystery that needs a host restart to
    // diagnose. It used to be two identically-shaped entries, one per namespace
    // (红线 8), and every reader had to pick one; with the review CLI gone there
    // is one ladder and one answer.
    provider: {
      storePath: stats.panelStorePath,
      storeError: stats.panelStoreError,
      foreignVersion: stats.panelStoreForeign,
      panel: stats.panelProvider,
      config: stats.defaultProvider,
      effective: stats.effectiveAsk,
      source: stats.effectiveAskSource,
      catalog: stats.modelCatalog,
      catalogError: stats.modelCatalogError,
    },
    // Drift/provenance signals: which daemon build we talk to, and whether the
    // quota parser has stopped recognizing the status text. Both are silent
    // degradations from an earlier minor — now they are observable facts on the panel.
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
    // CodingPlan quota. The daemon's structured `GET /codingplan/usage/summary`
    // is preferred and the localized `status` text is the fallback (which one ran
    // is stamped on the reading itself); this branch is best-effort either way and
    // says why when empty.
    quota: quota ?? { available: false, reason: 'not collected yet', fetchedAt: null },
    // Per-day usage history, the panel's trend card. Its own branch rather than
    // more rows on `quota`: it answers a different question (where the month went,
    // not what is left right now) and it has its own cadence and failure mode.
    usageTrend: stats.usageTrend,
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