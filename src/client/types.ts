/**
 * Types shared by the client half — renderer-only shapes.
 *
 * The SNAPSHOT branch types (`ConfigBranch`, `ProviderBranch`, `DaemonBranch`,
 * `ProtocolBranch`, `QuotaBranch`, `StatsSnapshot`, `UnknownRecord`) live in
 * `src/shared/stats.ts` now, because both halves need them: the host's
 * `buildStatsBody` PRODUCES the snapshot and the renderer CONSUMES it. Keeping
 * one copy in one module is what makes a renamed key a compile error on both
 * sides instead of a silently empty card.
 *
 * There used to be a `ProviderSlotName` here for "which of the two namespaces a
 * control addresses"; there is one namespace now (the `[providers.<name>]`
 * direct-entry one died with the review CLI), so one control addresses all of
 * it and nothing needs naming.
 *
 * Everything below is renderer-only: how a row is worded, how a dropdown
 * resolves, whether a quota number is known. These shapes exist because the
 * previous shape was `any` and the contract lived nowhere.
 */


export type {
  ConfigBranch,
  DaemonBranch,
  InFlightTurn,
  ProtocolBranch,
  ProviderBranch,
  QuotaBranch,
  SessionsBranch,
  StatsSnapshot,
  ToolStats,
  UnknownRecord,
} from '../shared/stats.ts';

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

/** One model control's wording, from `providerRows`. */
export interface ProviderRow {
  label: string;
  value: string;
  fallback: string;
  pinned: boolean;
  title: string;
}

/** What `providerSelectModel` decides for one control. */
export interface ProviderSelectModel {
  value: string;
  options: Array<{ value: string; label: string; effortLevels?: string[]; currentEffort?: string | null }>;
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
  /** The effort levels the selected model supports (empty = none / unknown). */
  effortLevels?: string[];
  /** The daemon's current persistent effort for the selected model (null = unset). */
  currentEffort?: string | null;
}

/** One row of the「回合边界」card. */
export interface BoundaryRow {
  label: string;
  text: string;
  title: string;
}