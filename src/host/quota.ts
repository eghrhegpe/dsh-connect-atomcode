/**
 * quota.ts — CodingPlan quota extraction from the daemon's `status` command.
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
/**
 * Reverse-semantics markers: a percentage on a usage line that says what is
 * LEFT rather than what is SPENT. `100% remaining` read as `limited` would
 * tell the user their window is exhausted when it is full, so a line matching
 * this is refused outright (see `parseIssue`).
 *
 * Deliberately narrow — `剩余|remaining|\bleft\b` are the shapes an English
 * drift could actually produce. A bare `余` would also match 余额/余裕 and
 * silently black out a healthy quota, which is the failure mode this guards.
 */
const REMAINING_LABEL = /(剩余|remaining|\bleft\b)/i;
const COLON = /[：:]/;

/** Which line shape we REFUSED to interpret (drift, not absence). */
export type ParseIssue = 'multiple-percentages' | 'reverse-semantics';

/** The two source lines the parse was derived from, kept for display. */
export interface QuotaRaw {
  planLine: string | null;
  usageLine: string | null;
}

/** Everything `parseStatusQuota` can tell you about a `status` payload. */
export interface ParsedQuota {
  plan: string | null;
  expires: string | null;
  planWindow: string | null;
  usagePercent: number | null;
  resetAt: string | null;
  resetIn: string | null;
  resetInSecs: number | null;
  limited: boolean;
  parseIssue: ParseIssue | null;
  raw: QuotaRaw;
}

/** A `runCommand('status')` outcome, as far as this module reads it. */
export interface CommandOutcome {
  ok?: boolean;
  kind?: string;
  message?: string;
  error?: string;
  text?: string;
}

/** The stats body's `quota` branch when the status command did not answer. */
export interface QuotaUnavailable {
  available: false;
  reason: string;
  fetchedAt: number;
}

/** The stats body's `quota` branch when it did — includes `drift`, see below. */
export interface QuotaAvailable extends ParsedQuota {
  available: true;
  reason: string;
  fetchedAt: number;
  drift: boolean;
}

export type QuotaReport = QuotaUnavailable | QuotaAvailable;

/**
 * Parse a duration like `29m 13s`, `1h29m`, `45s`, or `1h 2m 3s` into seconds.
 * @param text
 */
export function parseDurationSecs(text: unknown): number | null {
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
function firstClockTime(line: string): string | null {
  const m = line.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  return m ? (m[1] ?? null) : null;
}

/**
 * Extract the CodingPlan quota from a daemon `status` command payload (or its
 * raw `text`). Never throws.
 *
 * `parseIssue` names a line we REFUSED to interpret
 * (`multiple-percentages` / `reverse-semantics`); it is the caller's cue to
 * surface drift rather than render a number that may not be the usage.
 *
 * @param input - the command payload, or just its text.
 */
export function parseStatusQuota(input: unknown): ParsedQuota {
  const empty: ParsedQuota = {
    plan: null,
    expires: null,
    planWindow: null,
    usagePercent: null,
    resetAt: null,
    resetIn: null,
    resetInSecs: null,
    limited: false,
    parseIssue: null,
    raw: { planLine: null, usageLine: null },
  };
  const text =
    typeof input === 'string'
      ? input
      : input && typeof (input as { text?: unknown }).text === 'string'
        ? ((input as { text: string }).text)
        : '';
  if (text.trim() === '') return empty;

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const planLine = lines.find((l) => PLAN_LABEL.test(l) && COLON.test(l)) ?? null;
  const usageLine =
    lines.find((l) => l.includes('%') && USAGE_LABEL.test(l)) ??
    lines.find((l) => l.includes('%') && RESET_LABEL.test(l)) ??
    null;

  const out: ParsedQuota = { ...empty, raw: { planLine, usageLine } };

  if (planLine) {
    // Everything after the label is `<name> · <expiry>（<window>）`.
    const afterLabel = planLine.slice(planLine.search(COLON) + 1).trim();
    const [namePart = '', ...rest] = afterLabel.split(/\s*[·|]\s*/);
    const name = namePart.trim();
    // The name usually repeats the word CodingPlan; keep it as printed but strip
    // a leading duplicate label so the panel does not show "CodingPlan CodingPlan …".
    out.plan = name.replace(/^coding\s*plan\s*/i, '').trim() || name || null;

    const tail = rest.join(' · ');
    const date = tail.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (date) out.expires = date[1] ?? null;
    const paren = tail.match(/[（(]([^）)]*)[）)]/);
    if (paren) out.planWindow = (paren[1] ?? '').trim() || null;
    // Some builds omit the parenthetical; fall back to a trailing "Nd / Md".
    if (!out.planWindow) {
      const bare = tail.match(/(\d+\s*d\s*\/\s*[^·|]*\d+\s*d)/i);
      if (bare) out.planWindow = (bare[1] ?? '').trim();
    }
  }

  if (usageLine) {
    // How many percentages does this line actually carry? Taking the FIRST one
    // is only safe when there is exactly one. A drifted line such as
    // "Usage: 20% off, current window 77%" would otherwise yield 20 — a number
    // that is present, finite, and NOT the usage. That is the failure red line 2
    // exists for, and it is worse than no number because nothing flags it:
    // `found` below would be true, so drift would stay silent.
    const pcts = usageLine.match(/\d+(?:[.,]\d+)?\s*%/g) ?? [];
    if (pcts.length > 1) {
      // Ambiguous: refuse to pick. Do NOT "anchor on the first % after the
      // label" either — in "Usage: 20% off, …" the label precedes the wrong
      // number, so anchoring still grabs 20.
      out.parseIssue = 'multiple-percentages';
    } else if (REMAINING_LABEL.test(usageLine)) {
      // Reverse semantics: the number counts what is left, not what is spent.
      // Reporting it as usage (and `limited` at 100) would claim a full window
      // is exhausted. Refuse rather than convert — `100 - x` is the same guess
      // wearing a different hat.
      out.parseIssue = 'reverse-semantics';
    } else if (pcts.length === 1) {
      const value = Number((pcts[0] ?? '').replace(/[^0-9.,]/g, '').replace(',', '.'));
      if (Number.isFinite(value)) out.usagePercent = value;
    }
    // Reset wall-clock time: prefer the label, fall back to any HH:MM on the line
    // (the percentage itself never matches that shape). Parsed even when the
    // percentage was refused: it comes from its own labelled field, so refusing
    // the number does not make the clock untrustworthy.
    const labelled = usageLine.match(/(?:重置于|resets?\s*(?:at)?)\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/i);
    out.resetAt = labelled ? (labelled[1] ?? null) : firstClockTime(usageLine);
    const paren = usageLine.match(/[（(]([^）)]*)[）)]/);
    if (paren) {
      const inner = (paren[1] ?? '').trim();
      const secs = parseDurationSecs(inner);
      if (secs !== null) {
        out.resetIn = inner;
        out.resetInSecs = secs;
      }
    }
  }

  // `limited` only ever follows an INTERPRETED percentage; a refused line leaves
  // usagePercent null and therefore never raises the alarm.
  out.limited = out.usagePercent !== null && out.usagePercent >= 100;
  return out;
}

/**
 * Shape the quota section of the plugin stats snapshot.
 *
 * @param result - a `runCommand('status')` outcome.
 * @param fetchedAt - epoch ms of the fetch (for client-side countdown).
 * @returns the `quota` branch of the stats body.
 */
export function buildQuotaReport(
  result: CommandOutcome | null | undefined,
  fetchedAt: number,
): QuotaReport {
  if (!result || result.ok !== true) {
    return {
      available: false,
      reason: (result && (result.message || result.error)) || 'status command unavailable',
      fetchedAt,
    };
  }
  const parsed = parseStatusQuota(result.text);
  // `found` requires the usage line to parse. The plan line alone is not
  // enough: the plan line is anchored on the proper noun "CodingPlan" (the
  // least likely to change), while the usage line is anchored on translated
  // prose (the most likely to drift). If the plan parses but the usage line
  // goes unrecognised — the most realistic drift shape — `found` must be
  // false so the drift banner lights. Without this the panel would render a
  // healthy plan row next to a missing percentage and report `drift: false`,
  // leaving the client to invent a reason via `|| '额度读数不可用'` — the
  // second source of truth this project forbids.
  const found = parsed.usagePercent !== null && parsed.parseIssue === null;
  const ISSUE_REASON: Record<ParseIssue, string> = {
    'multiple-percentages': '用量行含多个百分数，无法判定哪个是窗口用量（已拒绝猜测，不显示百分比）',
    'reverse-semantics': '用量行按"剩余"语义表述，与本面板的"已用"语义相反（已拒绝换算，不显示百分比）',
  };
  return {
    available: true,
    ...parsed,
    fetchedAt,
    // `limited` at 100% is the client's cue to render the warning state.
    reason: parsed.parseIssue
      ? ISSUE_REASON[parsed.parseIssue]
      : found
        ? ''
        : parsed.plan !== null
          ? '用量行未被识别（daemon 的 status 文本可能已升级），计划行正常'
          : 'status text carried no recognisable quota line',
    // Drift signal for the plugin: the status command succeeded but the
    // localized text no longer matches any known shape. The caller surfaces
    // this (log + panel) so a silent quota blackout after an AtomCode upgrade
    // is visible instead of looking like "0%" or a missing number.
    drift: !found,
  };
}
