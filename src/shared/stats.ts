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
  defaultWorkingDir?: string | null;
  reviewWorkingDir?: string | null;
  defaultProvider?: string | null;
  reviewDefaultProvider?: string | null;
  askMaxRounds?: number | null;
  daemonRetrySecs?: number | null;
  reviewAvailable?: boolean;
  reviewReason?: string | null;
  /** Which patch-only knobs DEPART from the shipped default. Absent on old hosts. */
  authored?: { approvalMode?: boolean; workingDir?: boolean; askMaxRounds?: boolean } | null;
  /** The shipped defaults themselves, for the `（插件默认）` label. */
  defaults?: { approvalMode?: string; askMaxRounds?: number } | null;
}

/** One slot of the `provider` branch — ask and review are NOT the same namespace. */
export interface ProviderSlot {
  panel?: string | null;
  /**
   * The mount-time rung of THIS slot's ladder (ask → `default_provider`, review →
   * `review_default_provider`), i.e. the same fact as `config.*` but scoped to the
   * slot it belongs to — 红线 8's two namespaces are two fields upstairs, and a
   * slot-scoped copy is what a reader who only has the `provider` branch can use.
   *
   * Honest scope: the shipped renderer reads the `config` branch for this
   * (`providerRows(cfg)` → `cfg.defaultProvider` / `cfg.reviewDefaultProvider`),
   * so nothing dereferences this field TODAY. It is declared because the contract
   * describes the WIRE, and an undeclared field the host sends is exactly the
   * `TS2353` this annotation exists to raise.
   */
  config?: string | null;
  effective?: string | null;
  source?: string | null;
  /** OBJECTS on the ask path (`/models`), STRINGS on the review path. */
  catalog?: ReadonlyArray<string | { provider?: string; isDefault?: boolean }> | null;
  catalogError?: string | null;
  /**
   * base_url per usable provider name, so the pick's dependency is nameable.
   * REVIEW-ONLY: it lives on the SLOT, not on the `provider` branch root, because
   * that is where the host writes it (`buildStatsBody` → `provider.review`).
   * Reading it from the root is what made the loopback warning dead — the two
   * halves each had a test, and neither test joined them.
   */
  endpoints?: Record<string, string> | null;
}

/** The `provider` branch of the stats snapshot. */
export interface ProviderBranch {
  storePath?: string | null;
  storeError?: string | null;
  foreignVersion?: boolean;
  ask?: ProviderSlot | null;
  review?: ProviderSlot | null;
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

/** Which of the two provider namespaces a control addresses. They are NOT interchangeable. */
export type ProviderSlotName = 'ask' | 'review';

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
  ask?: ToolStats | null;
  review?: ToolStats | null;
}