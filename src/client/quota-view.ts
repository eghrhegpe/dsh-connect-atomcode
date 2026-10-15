/**
 * The quota readout model.
 *
 * Moved verbatim from the pre-TypeScript `client.js`; the only edits are the de-indent,
 * the `export` keyword, and parameter type annotations.
 *
 * `quotaFacts` feeds the chip tooltip; `quotaView` is the single decision layer both chip
 * variants share, which is why it must stay pure.
 */

import { barWidth, fmtCountdown, liveRemaining } from './format.ts';
import type { QuotaBranch, QuotaView } from './types.ts';

/**
 * The chip's tooltip text, as a LIST of facts.
 *
 * Split rather than pre-joined so the panel can lay each row out on its
 * own line; the panel joins them itself. `null` entries are dropped, which
 * is what lets a partially-known quota (plan known, expiry not) show the
 * rows it has instead of a ragged sentence with holes in it.
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
 *
 * @param {object|undefined} quota  the snapshot's quota branch
 * @param {number} nowMs            clock for the locally advanced countdown
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
