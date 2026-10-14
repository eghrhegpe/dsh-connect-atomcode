/**
 * quota.js — CodingPlan quota extraction from the daemon's `status` command.
 *
 * There is NO structured quota API: the daemon exposes `/health`, `/models`,
 * `/providers`, `/config` and a catch-all SPA, and the SSE `done.stats` carries
 * token counts only. The one place quota appears is the human-readable `text`
 * returned by `POST /command {"command":"status"}`:
 *
 *   CodingPlan：CodingPlan Lite-体验版  ·  到期 2026-10-19（5d / 共 7d）
 *   用量：当前时间窗口用量约 77%  ·  重置于 20:32（29m 13s 后）
 *
 * That text is LOCALIZED, so this parser keys on structure rather than prose
 * wherever it can: "CodingPlan" is a proper noun, `%` is `%`, ISO dates and
 * `Hh Mm Ss` durations are numerals. Label words are matched in both Chinese and
 * English as a fallback. Anything unrecognized yields nulls plus the raw lines,
 * so a caller can always fall back to showing the source text rather than
 * inventing a number.
 *
 * Pure and dependency-free so it can be unit-tested against captured payloads.
 *
 * @module dsh-atomcode-bridge/quota
 */

/** A plan line looks like `CodingPlan：<name> · 到期 <date>（<used> / 共 <total>）`. */
const PLAN_LABEL = /coding\s*plan/i;
/**
 * Usage line: a percentage plus a reset hint.
 *
 * Deliberately NOT matching the bare word "window": English status text says
 * "Usage: current window ~45%" (matched via `usage`), and a loose `window`
 * would let an unrelated line like "Smoothing window: 50%" be mistaken for the
 * usage line. The `%` gate in the caller already narrows this, but the label
 * should still name the quota concept, not a generic noun.
 */
const USAGE_LABEL = /(用量|usage|quota)/i;
/**
 * Usage-line selection.
 *
 * Both branches require a `%` (without one there is no usage number to report)
 * AND a label that names the quota concept. The second branch exists for builds
 * that dropped the label word but kept the reset wording; it is anchored on
 * `重置于`/`resets at` rather than on any line merely CONTAINING "重置", so a
 * shape-alike line about something else ("下一窗口 12:00") is not adopted as
 * "the" usage line — a false positive there shows a fabricated percentage.
 */
const RESET_LABEL = /(?:重置于|resets?\s*(?:at)?\b|reset\s+at)/i;
const COLON = /[：:]/;

/**
 * Parse a duration like `29m 13s`, `1h29m`, `45s`, or `1h 2m 3s` into seconds.
 * @param {string} text
 * @returns {number|null}
 */
export function parseDurationSecs(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const m = text.match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?!s))?\s*(?:(\d+)\s*s)?/i);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const mins = m[2] ? Number(m[2]) : 0;
  const secs = m[3] ? Number(m[3]) : 0;
  const total = hours * 3600 + mins * 60 + secs;
  return Number.isFinite(total) ? total : null;
}

/** First `HH:MM` (optionally seconds) token on a line. */
function firstClockTime(line) {
  const m = line.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  return m ? m[1] : null;
}

/**
 * Extract the CodingPlan quota from a daemon `status` command payload (or its
 * raw `text`). Never throws.
 *
 * @param {string|{text?:string}} input - the command payload, or just its text.
 * @returns {{
 *   plan: string|null, expires: string|null, planWindow: string|null,
 *   usagePercent: number|null, resetAt: string|null, resetIn: string|null,
 *   resetInSecs: number|null, limited: boolean,
 *   raw: { planLine: string|null, usageLine: string|null }
 * }}
 */
export function parseStatusQuota(input) {
  const empty = {
    plan: null,
    expires: null,
    planWindow: null,
    usagePercent: null,
    resetAt: null,
    resetIn: null,
    resetInSecs: null,
    limited: false,
    raw: { planLine: null, usageLine: null },
  };
  const text = typeof input === 'string' ? input : input && typeof input.text === 'string' ? input.text : '';
  if (text.trim() === '') return empty;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const planLine = lines.find((l) => PLAN_LABEL.test(l) && COLON.test(l)) ?? null;
  const usageLine =
    lines.find((l) => l.includes('%') && USAGE_LABEL.test(l)) ??
    lines.find((l) => l.includes('%') && RESET_LABEL.test(l)) ??
    null;

  const out = { ...empty, raw: { planLine, usageLine } };

  if (planLine) {
    // Everything after the label is `<name> · <expiry>（<window>）`.
    const afterLabel = planLine.slice(planLine.search(COLON) + 1).trim();
    const [namePart, ...rest] = afterLabel.split(/\s*[·|]\s*/);
    const name = namePart.trim();
    // The name usually repeats the word CodingPlan; keep it as printed but strip
    // a leading duplicate label so the panel does not show "CodingPlan CodingPlan …".
    out.plan = name.replace(/^coding\s*plan\s*/i, '').trim() || name || null;

    const tail = rest.join(' · ');
    const date = tail.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (date) out.expires = date[1];
    const paren = tail.match(/[（(]([^）)]*)[）)]/);
    if (paren) out.planWindow = paren[1].trim() || null;
    // Some builds omit the parenthetical; fall back to a trailing "Nd / Md".
    if (!out.planWindow) {
      const bare = tail.match(/(\d+\s*d\s*\/\s*[^·|]*\d+\s*d)/i);
      if (bare) out.planWindow = bare[1].trim();
    }
  }

  if (usageLine) {
    const pct = usageLine.match(/(\d+(?:[.,]\d+)?)\s*%/);
    if (pct) {
      const value = Number(pct[1].replace(',', '.'));
      if (Number.isFinite(value)) out.usagePercent = value;
    }
    // Reset wall-clock time: prefer the label, fall back to any HH:MM on the line
    // (the percentage itself never matches that shape).
    const labelled = usageLine.match(/(?:重置于|resets?\s*(?:at)?)\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/i);
    out.resetAt = labelled ? labelled[1] : firstClockTime(usageLine);
    const paren = usageLine.match(/[（(]([^）)]*)[）)]/);
    if (paren) {
      const inner = paren[1].trim();
      const secs = parseDurationSecs(inner);
      if (secs !== null) {
        out.resetIn = inner;
        out.resetInSecs = secs;
      }
    }
  }

  out.limited = out.usagePercent !== null && out.usagePercent >= 100;
  return out;
}

/**
 * Shape the quota section of the plugin stats snapshot.
 *
 * @param {{ok:boolean, kind?:string, message?:string, text?:string}} result - a
 *   `runCommand('status')` outcome.
 * @param {number} fetchedAt - epoch ms of the fetch (for client-side countdown).
 * @returns {object} the `quota` branch of the stats body.
 */
export function buildQuotaReport(result, fetchedAt) {
  if (!result || result.ok !== true) {
    return {
      available: false,
      reason: (result && (result.message || result.error)) || 'status command unavailable',
      fetchedAt,
    };
  }
  const parsed = parseStatusQuota(result.text);
  const found = parsed.plan !== null || parsed.usagePercent !== null;
  return {
    available: true,
    ...parsed,
    fetchedAt,
    // `limited` at 100% is the client's cue to render the warning state.
    reason: found ? '' : 'status text carried no recognisable quota line',
    // Drift signal for the plugin: the status command succeeded but the
    // localized text no longer matches any known shape. The caller surfaces
    // this (log + panel) so a silent quota blackout after an AtomCode upgrade
    // is visible instead of looking like "0%" or a missing number.
    drift: !found,
  };
}
