/**
 * Renderer-side pure formatters.
 *
 * Moved verbatim from the pre-TypeScript `client.js`; the only edits are the de-indent,
 * the `export` keyword, and parameter type annotations.
 */

import type { UnknownRecord } from './types.ts';

/**
 * Pure formatters, hoisted OUT of the factory closure and attached to the
 * returned module as `__test`. They were untestable while nested inside
 * `factory(require)` (the only way in was the module loader, which needs
 * a browser), and they are exactly the kind of edge-case code that needs
 * tests: 0ms, negative countdowns, null quota, 100% state.
 *
 * The production code below calls these same functions.
 */
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
 * Extracted because the merge ORDER is the whole bug surface here, and no
 * test renders a portal: `Object.assign({}, surface, anchored, {left:0,
 * top:0})` looks harmless but clobbers the measured coordinates and pins
 * the dialog to the viewport's top-left corner. The off-screen fallback
 * may apply ONLY while the anchoring hook has not measured yet (it returns
 * null), which is what this encodes.
 *
 * @param {object} surface  the static panel surface
 * @param {object|null} anchored  the hook's measured position, or null
 */
export function panelStyle(
  surface: UnknownRecord | null | undefined,
  anchored: UnknownRecord | null | undefined,
): UnknownRecord {
  return Object.assign({}, surface, anchored ?? { visibility: 'hidden', left: 0, top: 0 });
}
