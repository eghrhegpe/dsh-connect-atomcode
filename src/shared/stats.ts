/**
 * stats.ts — the stats snapshot contract, shared by both halves.
 *
 * The host's `buildStatsBody` PRODUCES this shape and the client's `useStats`
 * CONSUMES it. Before this module existed the shape was `any` on the host side
 * and hand-written (in `src/client/types.ts`) on the client side: the host had
 * no compile-time check that the object it sent matched the object the
 * renderer read, so a renamed key surfaced as a silently empty card — the same
 * species of drift as a regex that quietly stops matching `status` text.
 *
 * That check is now ENFORCED rather than intended: `buildStatsBody` is annotated
 * `: StatsSnapshot`, so the producer is compile-checked against this file. The
 * first run of that annotation found five disagreements (four fields the host
 * sends that this file never declared, and `binary.configured`, which this file
 * and the client both describe as a path while the host was sending a boolean —
 * a live empty panel row). Declaring a wire field here is therefore no longer
 * optional bookkeeping: a field the host sends without a row here is a TS2353.
 *
 * `src/shared/loopback.ts` already proved that a fact two halves need can live
 * in one module; this is the same rule applied to a TYPE instead of a function.
 *
 * Every field is optional-or-nullable on purpose: an OLDER host build, or the
 * desktop install copy, legitimately omits branches, and the renderer must
 * degrade rather than throw.
 *
 * @module dsh-connect-atomcode/shared/stats
 */

/** The `config` branch of the stats snapshot. */
export interface ConfigBranch {
  approvalMode?: string | null;
  /**
   * The `approval_mode` spelling the patch supplied that the daemon does NOT
   * accept (`config.ts` 的 APPROVAL_MODES), carried so the panel can name the
   * rejected value instead of showing the fallback as if the user had chosen it.
   * `null`/absent = the resolved value is legal.
   */
  approvalModeRejected?: string | null;
  /**
   * The resolved `review_brief_mode` (always / when-empty / never): which prompt
   * shape a review with empty user text takes. Absent on old hosts.
   */
  reviewBriefMode?: string | null;
  /**
   * The off-enum `review_brief_mode` spelling the patch supplied (null/absent =
   * the resolved value is legal). Same fail-visible shape as
   * `approvalModeRejected`.
   */
  reviewBriefModeRejected?: string | null;
  defaultWorkingDir?: string | null;
  defaultProvider?: string | null;
  askMaxRounds?: number | null;
  daemonRetrySecs?: number | null;
  /** Which patch-only knobs DEPART from the shipped default. Absent on old hosts. */
  authored?: { approvalMode?: boolean; workingDir?: boolean; askMaxRounds?: boolean; reviewBriefMode?: boolean } | null;
  /** The shipped defaults themselves, for the `（插件默认）` label. */
  defaults?: { approvalMode?: string; askMaxRounds?: number; reviewBriefMode?: string } | null;
  /**
   * The panel's brief-mode override (always / when-empty / never).
   * `null`/absent = no override, the patch value applies.
   */
  panelBriefMode?: string | null;
  /**
   * The panel's working-dir override. `null`/absent = no override,
   * the patch value applies.
   */
  panelWorkingDir?: string | null;
  /**
   * The panel's approval-mode override (build / accept_edits / bypass / plan).
   * `null`/absent = no override, the patch value applies.
   */
  panelApprovalMode?: string | null;
  /**
   * The panel's ask max-rounds override. `null`/absent = no override.
   */
  panelAskMaxRounds?: number | null;
  /** Where panel-settings.json lives (the panel names it). */
  panelSettingsStorePath?: string | null;
  /** Why the panel-settings file is degraded (`''` when healthy). */
  panelSettingsError?: string | null;
}

/**
 * The `provider` branch of the stats snapshot — ONE ladder, not two.
 *
 * It used to be `{ask: ProviderSlot, review: ProviderSlot}`, two identically
 * shaped entries for two namespaces (红线 8), and every reader had to know
 * which one it was looking at. The `[providers.<name>]` namespace died with the
 * review CLI, so there is one question left ("which model profile do bridged
 * turns ask for") and one flat answer; `catalog` is now objects-only because
 * the daemon's `/models` is its only source.
 */
export interface ProviderBranch {
  storePath?: string | null;
  storeError?: string | null;
  foreignVersion?: boolean;
  /** The stored panel pick (`''` / `null` = none). */
  panel?: string | null;
  /** The mount-time rung of the ladder (`default_provider`), restated here. */
  config?: string | null;
  effective?: string | null;
  source?: string | null;
  /** Daemon model profiles (`/models`) — objects, one per entry. */
  catalog?: ReadonlyArray<string | { provider?: string; isDefault?: boolean; effortLevels?: string[]; currentEffort?: string | null }> | null;
  catalogError?: string | null;
}

/** The `daemon` branch of the stats snapshot. */
export interface DaemonBranch {
  up?: boolean;
  port?: number | null;
  autoStart?: boolean;
  starting?: boolean;
  spawnTried?: boolean;
  spawnFailures?: number;
  /** How many times this mount has TRIED to spawn, failures included. */
  spawnAttempts?: number | null;
  /** When the liveness flag was last refreshed — i.e. how fresh `up` is. */
  lastCheckedAt?: number | null;
  /**
   * WHY it is down, ALREADY WORDED by the host (`describeDaemonDown`), and `''`
   * while up. Render it; never re-derive it. The tool errors carry the same
   * sentence from the same function, and a panel that words its own version is
   * how one port ends up with two stories — the failure mode this whole branch
   * was collapsed into before (`up: false` for four different causes, all of
   * them reported to the user as "未监听").
   */
  downMessage?: string | null;
}

/** The `protocol` branch of the stats snapshot — drift/provenance signals. */
export interface ProtocolBranch {
  /** Which daemon build the bridged (private, unversioned) protocol is spoken against. */
  daemonVersion?: string | null;
  /**
   * The generation the private protocol was VALIDATED against (`'5.x'`) — a
   * constant of this build, shipped so a mismatch against `daemonVersion` is
   * visible on the panel rather than only in the host's log line.
   */
  verifiedGeneration?: string | null;
  /** The quota parser stopped recognizing the daemon's `status` text. */
  quotaTextDrift?: boolean;
  /**
   * SSE event types the daemon sent that this client did NOT recognize, and `[]`
   * when the vocabulary matched. Absent on an older host.
   *
   * The same species as `quotaTextDrift` one layer sharper: a renamed
   * `tool_start` leaves every turn looking like a clean success while the
   * bridge's round fuse — which COUNTS those events — silently stops tripping.
   * The host publishes it so the panel can say out loud what the turn could not.
   */
  unknownTypes?: string[] | null;
}

/** The `quota` branch, as the renderer consumes it. */
export interface QuotaBranch {
  available?: boolean;
  plan?: string | null;
  pct?: number | null;
  resetAt?: string | null;
  expires?: string | null;
  planWindow?: string | null;
  limited?: boolean;
  reason?: string | null;
  /** The parsed percentage. Absent when the host could not parse one. */
  usagePercent?: number | null;
  /** Seconds until the window resets, as of `fetchedAt`. */
  resetInSecs?: number | null;
  /** When the snapshot carrying `resetInSecs` was taken, for the local countdown. */
  fetchedAt?: number | null;
  raw?: { usageLine?: string | null; planLine?: string | null } | null;
}

/** Anything an index access might return when the key is absent. */
export type UnknownRecord = Record<string, unknown>;

/**
 * A turn that is running RIGHT NOW, as read by a panel poll.
 *
 * An `atomcode_ask` turn is aggregated and returned in one piece, so between the
 * call and its return the turn is a black box: minutes of tool calls, file
 * writes and shell commands with nothing on screen. These fields exist so the
 * 5s poll has something true to say in that window — counts and names only,
 * never partial content (a second, worse copy of a deliverable is exactly what
 * a progress channel should not become).
 *
 * `elapsedMs` is measured by the HOST when it builds the snapshot, not sent as a
 * start timestamp: a client clock offset would otherwise print as a turn that
 * started in the future.
 */
export interface InFlightTurn {
  elapsedMs: number;
  /** `tool_start` events seen so far (≥ agent rounds: parallel calls each count). */
  rounds: number;
  /** Calls that already have a result; `rounds - completed` are still in flight. */
  completed: number;
  /** Reply characters accumulated so far — a size, not the text. */
  chars: number;
  /** The session id once assigned; `''` before the daemon sends one. */
  sessionId: string;
  /** Name of the most recent tool call; `''` before the first one. */
  lastTool: string;
  /** Tokens reported so far; the daemon often only reports them at the end. */
  tokens: number;
  /** The directory this turn runs in; `null` = the daemon's own cwd. */
  workingDir: string | null;
  /** The model profile this turn was asked for. */
  provider: string;
}

/** One tool's statistics counters inside the snapshot. */
export interface ToolStats {
  calls: number;
  ok: number;
  err: number;
  msTotal: number;
  tokens?: number;
  /**
   * Present ONLY while a turn of this tool is running. Absent means "nothing in
   * flight", which is the normal state — not "unknown".
   */
  inFlight?: InFlightTurn | null;
}

/** The `binary` branch — which AtomCode binary the daemon was launched with. */
export interface BinaryBranch {
  /**
   * The patch row's `binary` PATH, or null/absent when it is unset — a PATH, not
   * a flag. The panel's row renders `configured || env || '自动探测（PATH）'`, so a
   * host that sent a BOOLEAN here made the row blank exactly when a binary was
   * configured (React drops a `true` child) and masked `env` with `true`. That
   * was a live bug, not a hypothetical: this field's type, the client's
   * expression and the host's own joining test all assumed a path.
   */
  configured?: string | null;
  /** The `ATOMCODE_BIN` path. Absent (not null) when the variable is unset. */
  env?: string | null;
  /** Which rung of `configured > env > auto` answered. */
  source?: string | null;
  /** Never sent by this host; reserved for a probe-the-PATH result. */
  detected?: string | null;
}

/** The `sessions` branch — the tracked-session store's reading. */
export interface SessionsBranch {
  /** Resumable keys only — expired ones are no longer counted as tracked. */
  tracked: number;
  /**
   * Age in ms of the oldest resumable key; null when there is none or its age
   * is unknown. Absent on an older host.
   */
  oldestAgeMs?: number | null;
  error?: string | null;
}

/**
 * The FULL stats snapshot served at `/api/atomcode-bridge/stats`.
 *
 * This is the single source of truth for the wire shape. The host's
 * `buildStatsBody` must return a compatible object; the client's `useStats`
 * must be able to consume any subset (all branches optional).
 */
export interface StatsSnapshot {
  ok: boolean;
  name: string;
  displayName: string;
  version: string;
  uptimeMs: number;
  daemon?: DaemonBranch | null;
  binary?: BinaryBranch | null;
  config?: ConfigBranch | null;
  provider?: ProviderBranch | null;
  protocol?: ProtocolBranch | null;
  quota?: QuotaBranch | null;
  sessions?: SessionsBranch | null;
  /** Counters for the one model tool. */
  ask?: ToolStats | null;
  /**
   * A retained snapshot key with NO writer: it counted the retired
   * `atomcode_review` tool, and a review is now an ordinary ask turn that lands
   * in `ask`. Nothing increments it, so it is always zero.
   *
   * Kept because this shape is a contract with whatever panel build is loaded:
   * a renderer older than the retirement reads the key, and it must find a
   * number rather than `undefined`.
   */
  review?: ToolStats | null;
}