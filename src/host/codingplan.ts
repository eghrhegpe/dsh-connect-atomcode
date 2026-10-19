/**
 * codingplan.ts — the daemon's STRUCTURED CodingPlan quota and usage.
 *
 * The plugin was built on a documented assumption that turned out to be
 * incomplete: that CodingPlan quota exists ONLY as localized prose inside
 * `POST /command {"command":"status"}`. The daemon also serves two JSON
 * endpoints, and unlike the text they carry real numbers (a limit, a used count,
 * a window length) instead of a sentence to re-parse:
 *
 *   GET /codingplan/usage/summary  → the plan + the current metering window
 *   GET /codingplan/usage/daily    → per-day tokens/requests for 60 days
 *
 * Both take the same bearer token the rest of the daemon API takes. Both are
 * still PRIVATE and UNVERSIONED (事实 3), so every field below is read
 * defensively: a missing or mistyped field yields null, never a guess, and a
 * payload with nothing usable yields `null` so the caller falls back to the text
 * path instead of showing junk (红线 2 — an invented number is worse than none).
 *
 * Captured verbatim on 2026-10-19 with a healthy plan:
 *
 *   {"schema_version":1,"available":true,
 *    "plan":{"name":"CodingPlan Lite-体验版","status":1,"claimed_at":"2026-10-19",
 *            "expires_at":"2026-10-26","total_days":7,"remaining_days":7},
 *    "primary_window":{"metric":"calls","window_hours":5,"window_size_seconds":18000,
 *            "limit":200,"used":0,"remaining":200,"usage_percent":0,
 *            "remaining_percent":100,"quota_exhausted":false,
 *            "next_reset_at":"2026-10-19T17:02:20","next_reset_display":"17:02",
 *            "seconds_until_reset":17490,
 *            "reset_label":"当前窗口结束即重置额度（每 5 小时一个窗口）",
 *            "usage_description":"当前时间窗口用量约 0%"},
 *    "windows":[…],"quota_hint":null}
 *
 * An EXPIRED plan answers HTTP 502 on `summary`
 * (`{"success":false,"error":"Unable to load CodingPlan usage"}`) — observed
 * while the trial had lapsed, and it started answering again the moment the plan
 * was re-claimed. That is exactly why this module is a PREFERRED source rather
 * than a replacement: the text path (and its named "额度未生效" diagnosis) still
 * catches the states where the structured one refuses to answer.
 *
 * @module dsh-connect-atomcode/codingplan
 */
import type { QuotaAvailable } from './quota.ts';

/** One metering window, as the summary reports it. */
export interface CodingPlanWindow {
  /** `calls` today — the unit the `limit`/`used` pair is counted in. */
  metric: string | null;
  hours: number | null;
  limit: number | null;
  used: number | null;
  /** The window's used percentage, as the daemon computed it. */
  usagePercent: number | null;
  exhausted: boolean;
  /** Wall-clock reset time as the daemon displays it (`17:02`). */
  resetAt: string | null;
  resetInSecs: number | null;
}

/** `GET /codingplan/usage/summary`, reduced to what the panel reads. */
export interface CodingPlanSummary {
  /** The plan name WITH the `CodingPlan` prefix stripped, matching the text path. */
  planName: string | null;
  expires: string | null;
  /** `7d / 共 7d` — the same field the text path fills from `到期 …（5d / 共 7d）`. */
  planWindow: string | null;
  window: CodingPlanWindow | null;
}

/** One day of `GET /codingplan/usage/daily`. */
export interface CodingPlanDay {
  date: string;
  tokens: number;
  requests: number;
}

/** `GET /codingplan/usage/daily`, trimmed to the tail the panel can show. */
export interface CodingPlanDaily {
  schemaVersion: number | null;
  days: number | null;
  startDate: string | null;
  endDate: string | null;
  models: string[];
  /** Oldest → newest, at most `keepDays` rows. */
  rows: CodingPlanDay[];
}

/** The stats body's `usageTrend` branch: a reading, or a named reason it is missing. */
export type UsageTrend =
  | ({ available: true; reason: string; fetchedAt: number } & CodingPlanDaily)
  | { available: false; reason: string; fetchedAt: number };

/** A string field, or null — an empty/whitespace string is an ABSENT value here. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A finite number, or null. Booleans and numeric strings are NOT numbers here. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A plain object, or null — arrays and null are rejected. */
function rec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseWindow(input: unknown): CodingPlanWindow | null {
  const w = rec(input);
  if (!w) return null;
  const out: CodingPlanWindow = {
    metric: str(w.metric),
    hours: num(w.window_hours),
    limit: num(w.limit),
    used: num(w.used),
    usagePercent: num(w.usage_percent),
    // Only an explicit `true` raises the alarm — a missing field must not.
    exhausted: w.quota_exhausted === true,
    resetAt: str(w.next_reset_display) ?? str(w.next_reset_at),
    resetInSecs: num(w.seconds_until_reset),
  };
  // A window with no numbers in it is not a window; saying so keeps the panel
  // from rendering a metric block with three em-dashes.
  return out.limit === null && out.used === null && out.usagePercent === null ? null : out;
}

/**
 * Parse `GET /codingplan/usage/summary`.
 *
 * @returns the reduced summary, or `null` when the payload is not a usable
 *          reading (unavailable, not an object, or nothing the panel can show).
 */
export function parseUsageSummary(input: unknown): CodingPlanSummary | null {
  const root = rec(input);
  if (!root || root.available !== true) return null;
  const plan = rec(root.plan);
  const name = plan ? str(plan.name) : null;
  const totalDays = plan ? num(plan.total_days) : null;
  const remainingDays = plan ? num(plan.remaining_days) : null;
  const out: CodingPlanSummary = {
    // The panel already labels the card 「CodingPlan 额度」, so the prefix is
    // dropped here exactly like the text parser drops it from `CodingPlan：…`.
    planName: name ? name.replace(/^coding\s*plan\s*/i, '').trim() || name : null,
    expires: plan ? str(plan.expires_at) : null,
    planWindow:
      remainingDays !== null && totalDays !== null ? `${remainingDays}d / 共 ${totalDays}d` : null,
    window: parseWindow(root.primary_window),
  };
  // Nothing usable → let the caller fall back to the text path. Half a reading
  // (a plan name with no window) is still worth showing.
  return out.planName === null && out.window === null && out.expires === null ? null : out;
}

/**
 * Parse `GET /codingplan/usage/daily`.
 *
 * @param input - the raw payload.
 * @param keepDays - how many trailing days to keep. The endpoint returns 60; the
 *   panel shows a week, and the stats route is polled every 5s, so the whole
 *   history would be re-sent for nothing.
 * @returns the trimmed history, or `null` when there is none to show.
 */
export function parseUsageDaily(input: unknown, keepDays = 14): CodingPlanDaily | null {
  const root = rec(input);
  if (!root || root.available !== true || !Array.isArray(root.rows)) return null;
  const rows: CodingPlanDay[] = [];
  for (const entry of root.rows) {
    const row = rec(entry);
    if (!row) continue;
    const date = str(row.date);
    if (date === null) continue;
    // A day the daemon reports without totals is a ZERO day, not a broken row:
    // the endpoint lists every day in the range, including the idle ones (which
    // is exactly what makes the gaps in the trend readable).
    rows.push({ date, tokens: num(row.total_tokens) ?? 0, requests: num(row.total_requests) ?? 0 });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const models = Array.isArray(root.models)
    ? root.models.filter((m): m is string => typeof m === 'string' && m !== '')
    : [];
  return {
    schemaVersion: num(root.schema_version),
    days: num(root.days),
    startDate: str(root.start_date),
    endDate: str(root.end_date),
    models,
    rows: rows.slice(-Math.max(1, keepDays)),
  };
}

/**
 * Map a structured summary onto the stats body's `quota` branch, so the panel
 * keeps ONE reading shape and the existing card renders it unchanged.
 *
 * @param summary - a `parseUsageSummary` result.
 * @param fetchedAt - epoch ms of the fetch (the client counts down from it).
 */
export function summaryQuotaReport(summary: CodingPlanSummary, fetchedAt: number): QuotaAvailable {
  const w = summary.window;
  const usagePercent = w ? w.usagePercent : null;
  return {
    available: true,
    source: 'codingplan-json',
    // It IS the preferred source, so there is nothing to explain.
    sourceNote: '',
    plan: summary.planName,
    expires: summary.expires,
    planWindow: summary.planWindow,
    usagePercent,
    resetAt: w ? w.resetAt : null,
    // The countdown is computed by the client from `resetInSecs` + `fetchedAt`
    // (so it stays live between polls); the structured source has no pre-rendered
    // "4h 59m 后" string and inventing one here would be a second formatter.
    resetIn: null,
    resetInSecs: w ? w.resetInSecs : null,
    // `quota_exhausted` is the daemon's own verdict; the 100% fallback covers a
    // payload that omits the flag but still reports a full window.
    limited: w !== null && (w.exhausted || (usagePercent !== null && usagePercent >= 100)),
    parseIssue: null,
    upstreamFailure: null,
    windowLimit: w ? w.limit : null,
    windowUsed: w ? w.used : null,
    windowHours: w ? w.hours : null,
    windowMetric: w ? w.metric : null,
    raw: { planLine: null, usageLine: null },
    reason: '',
    drift: false,
    fetchedAt,
  };
}
