/**
 * Types shared by the client half.
 *
 * These exist because the snapshot is HOST-SUPPLIED and was previously `any` everywhere:
 * `config.authored` / `config.defaults` are read by the renderer with no contract at all,
 * which is how a stale host (one without those keys) could only be handled by a runtime
 * fallback. Naming the shape puts that contract in one place.
 *
 * Every field is optional-or-nullable on purpose: an OLDER host build, or the desktop
 * install copy, legitimately omits branches, and the renderer must degrade rather than throw.
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

/** What `quotaView` decides: either "we know the number" or "we do not". */
export type QuotaView =
  | { known: false }
  | {
      known: true;
      pct: number;
      limited: boolean;
      label: string;
      color: string;
      facts: string[];
      barWidth: number;
    };

/** Anything an index access might return when the key is absent. */
export type UnknownRecord = Record<string, unknown>;

/** Which of the two provider namespaces a control addresses. They are NOT interchangeable. */
export type ProviderSlotName = 'ask' | 'review';

/** One model control's wording, from `providerRows`. */
export interface ProviderRow {
  slotName: ProviderSlotName;
  label: string;
  value: string;
  fallback: string;
  pinned: boolean;
  title: string;
}

/** What `providerSelectModel` decides for one control. */
export interface ProviderSelectModel {
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  reason: string;
  effective: string;
  source: string;
  /** Non-empty ONLY when the effective value differs from what this control shows. */
  note: string;
  /**
   * Non-empty when the SELECTED entry points at a loopback endpoint — a local
   * process this pick then depends on. A different sentence kind from `note`.
   */
  warning: string;
}

/** One row of the「回合边界」card. */
export interface BoundaryRow {
  label: string;
  text: string;
  title: string;
}
