/**
 * Quota display — pure formatters and the readout model.
 *
 * Moved out of the factory closure so they can be unit-tested without a
 * browser. The production code in index.ts calls these same functions.
 */

import type { UnknownRecord, QuotaBranch, QuotaView } from './types.ts';

// ── formatters ────────────────────────────────────────────────────────────

export function fmtDuration(ms: number | null | undefined): string {
  if (!Number.isFinite(ms) || (ms as number) <= 0) return '—';
  const n = ms as number;
  if (n < 1000) return Math.round(n) + ' ms';
  return (n / 1000).toFixed(1) + ' s';
}

/** Compact countdown for the CodingPlan rolling-window reset. */
export function fmtCountdown(secs: number | null | undefined): string {
  if (!Number.isFinite(secs) || (secs as number) < 0) return '—';
  const s = secs as number;
  if (s >= 3600) return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
  if (s >= 60) return Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's';
  return Math.round(s) + 's';
}

/** Quota colour: the window being exhausted is the only true error state. */
export function quotaColor(percent: number | null | undefined, limited?: boolean | null): string {
  if (limited || (typeof percent === 'number' && percent >= 100)) {
    return 'var(--dsw-alias-state-error-primary)';
  }
  return 'var(--dsw-alias-label-primary)';
}

/**
 * Seconds remaining, counted down locally between polls.
 *
 * A negative result means the snapshot is stale (the window reset since the
 * fetch), which is NOT the same as "no data": the caller must clamp to 0
 * and keep showing "已重置" rather than rendering the "—" of a null input.
 */
export function liveRemaining(
  resetInSecs: number | null | undefined,
  fetchedAt: number | null | undefined,
  nowMs: number,
): number | null {
  if (typeof resetInSecs !== 'number' || !Number.isFinite(resetInSecs)) return null;
  if (!Number.isFinite(fetchedAt)) return null;
  return Math.max(0, resetInSecs - Math.round((nowMs - (fetchedAt as number)) / 1000));
}

/** The chip label / progress-bar width, given an already-clamped percent. */
export function pctLabel(percent: number | null | undefined): string {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—';
  return Math.round(percent) + '%';
}

/** Bar width percent, clamped into [0,100]. */
export function barWidth(percent: number | null | undefined): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

/**
 * Merge the panel's surface style with the measured anchor position.
 *
 * The merge ORDER is the whole bug surface here: `Object.assign({}, surface,
 * anchored, {left:0, top:0})` looks harmless but clobbers the measured
 * coordinates. The off-screen fallback may apply ONLY while the anchoring
 * hook has not measured yet (it returns null).
 */
export function panelStyle(
  surface: UnknownRecord | null | undefined,
  anchored: UnknownRecord | null | undefined,
): UnknownRecord {
  return Object.assign({}, surface, anchored ?? { visibility: 'hidden', left: 0, top: 0 });
}

// ── readout model ─────────────────────────────────────────────────────────

/**
 * The chip's tooltip text, as a LIST of facts.
 *
 * Split rather than pre-joined so the panel can lay each row out on its
 * own line; `null` entries are dropped, which is what lets a partially-known
 * quota show the rows it has instead of a ragged sentence with holes.
 */
export function quotaFacts(quota: QuotaBranch, pct: number, liveSecs: number | null): string[] {
  return [
    (quota.plan ? 'CodingPlan ' + quota.plan : 'CodingPlan'),
    [quota.expires, quota.planWindow].filter(Boolean).join(' · '),
    '5 小时窗口已用 ' + pct + '%',
    liveSecs === null ? null : '约 ' + fmtCountdown(liveSecs) + ' 后重置',
  ].filter(Boolean) as string[];
}

/**
 * Everything the readout renders, derived from ONE stats snapshot.
 *
 * Extracted because both chip variants must agree on what "no quota"
 * means, and the label must be unconstructable while `known` is false:
 * building `'atom · 5小时 ' + pct + '%'` from a `pct` that defaulted to
 * null is what printed `atom · 5小时 null%` for the frame before the first
 * stats response landed. Here `label` simply does not exist unless the
 * quota is known, so the bug cannot be reintroduced by a caller.
 */
export function quotaView(quota: QuotaBranch | null | undefined, nowMs: number): QuotaView {
  const known = !!quota && quota.available === true && typeof quota.usagePercent === 'number';
  if (!known) return { known: false };
  const pct = Math.round(quota!.usagePercent as number);
  const limited = quota!.limited === true;
  const liveSecs = liveRemaining(quota!.resetInSecs, quota!.fetchedAt, nowMs);
  return {
    known: true,
    pct,
    limited,
    label: 'atom · 5小时 ' + pct + '%',
    // `quotaColor` answers "is this an alarm?" and returns the PRIMARY
    // label for the normal case — right for the detail page's big metric,
    // wrong here. In the dock the normal state must read as an ambient
    // environment fact beside the session readouts, so the mapping is
    // done here rather than by weakening the shared helper.
    color: limited || (quota!.usagePercent as number) >= 100
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-label-tertiary)',
    facts: quotaFacts(quota!, pct, liveSecs),
    barWidth: barWidth(pct),
  };
}
