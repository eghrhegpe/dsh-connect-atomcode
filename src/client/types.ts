/**
 * Types shared by the client half — renderer-only shapes.
 *
 * The SNAPSHOT branch types (`ConfigBranch`, `ProviderBranch`, `DaemonBranch`,
 * `ProtocolBranch`, `QuotaBranch`, `StatsSnapshot`, `ProviderSlotName`,
 * `UnknownRecord`) live in `src/shared/stats.ts` now, because both halves need
 * them: the host's `buildStatsBody` PRODUCES the snapshot and the renderer
 * CONSUMES it. Keeping one copy in one module is what makes a renamed key a
 * compile error on both sides instead of a silently empty card.
 *
 * Everything below is renderer-only: how a row is worded, how a dropdown
 * resolves, whether a quota number is known. These shapes exist because the
 * previous shape was `any` and the contract lived nowhere.
 */

import type { ProviderSlotName } from '../shared/stats.ts';

export type {
  ConfigBranch,
  DaemonBranch,
  ProtocolBranch,
  ProviderBranch,
  ProviderSlot,
  ProviderSlotName,
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