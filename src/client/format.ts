/**
 * Renderer-side pure formatters and decision functions.
 *
 * These are the pieces the offline suite exercises through `__test`, so they must stay
 * free of React, of the DOM, and of the loader — everything here is a plain function of
 * its arguments. Keeping them in their own module is what makes that property checkable
 * rather than merely intended.
 *
 * Ported verbatim from the pre-TypeScript `client.js`; the string forms (including the
 * spaces in `' ms'` / `' s'`) are asserted by `test/client-fns.test.mjs`, so they are
 * behaviour, not formatting preference.
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
export function quotaColor(percent: number | null | undefined, limited?: boolean): string {
  if (limited || (typeof percent === 'number' && percent >= 100)) {
    return 'var(--dsw-alias-state-error-primary)';
  }
  return 'var(--dsw-alias-label-primary)';
}

/**
 * Seconds remaining, counted down locally between polls.
 *
 * A negative result means the snapshot is stale (the window reset since the fetch),
 * which is NOT the same as "no data": the caller must clamp to 0 and keep showing
 * "已重置" rather than rendering the "—" of a null input.
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
 * Extracted because the merge ORDER is the whole bug surface here, and no test renders
 * a portal: `Object.assign({}, surface, anchored, {left:0, top:0})` looks harmless but
 * clobbers the measured coordinates and pins the dialog to the viewport's top-left
 * corner. The off-screen fallback may apply ONLY while the anchoring hook has not
 * measured yet (it returns null), which is what this encodes.
 */
export function panelStyle(
  surface: Record<string, unknown> | null | undefined,
  anchored: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return Object.assign({}, surface, anchored ?? { visibility: 'hidden', left: 0, top: 0 });
}
