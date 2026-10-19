/**
 * codingplan.test.mjs — the daemon's STRUCTURED CodingPlan quota/usage.
 *
 * This is the PREFERRED quota source: `GET /codingplan/usage/summary` carries the
 * window in real numbers (a limit, a used count, a window length) instead of a
 * localized sentence, so nothing here can "drift" the way `quota.ts`'s text
 * parser can. The other half of the contract matters just as much: the payloads
 * are still private and unversioned, so every field is read defensively and a
 * payload with nothing usable must come back `null` — which is what makes the
 * caller fall back to the text (`红线 2`: never invent a number).
 *
 * The fixtures below are captured VERBATIM from the daemon on 2026-10-19
 * (`seconds_until_reset` is the only value that moves), exactly as `quota.test.mjs`
 * pins its captured `status` text.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseUsageDaily, parseUsageSummary, summaryQuotaReport } from '../lib/codingplan.js';

/** Captured verbatim from `GET /codingplan/usage/summary`, plan healthy. */
const REAL_SUMMARY = JSON.parse(`{
  "schema_version": 1,
  "available": true,
  "plan": {
    "name": "CodingPlan Lite-体验版",
    "status": 1,
    "claimed_at": "2026-10-19",
    "expires_at": "2026-10-26",
    "total_days": 7,
    "remaining_days": 7
  },
  "primary_window": {
    "metric": "calls",
    "window_hours": 5,
    "window_size_seconds": 18000,
    "limit": 200,
    "used": 0,
    "remaining": 200,
    "usage_percent": 0,
    "remaining_percent": 100,
    "quota_exhausted": false,
    "next_reset_at": "2026-10-19T17:02:20",
    "next_reset_display": "17:02",
    "seconds_until_reset": 17001,
    "reset_label": "当前窗口结束即重置额度（每 5 小时一个窗口）",
    "usage_description": "当前时间窗口用量约 0%"
  },
  "windows": [ { "metric": "calls", "limit": 200, "used": 0 } ],
  "quota_hint": null
}`);

/**
 * The tail of `GET /codingplan/usage/daily`, verbatim except for the rows kept
 * and ONE model name: the live list also carries `mimo-<digit>.<digit>-pro`,
 * which `wiring.test.mjs`'s release-label scanner reads as a version tag in
 * prose (it scans every line of this directory). Four names prove the same
 * thing — the list is carried through untouched.
 *
 * `model_tokens` / `model_requests` are present in the real payload and
 * deliberately ignored: the card shows one line per day, and the per-model split
 * would need a second renderer to mean anything.
 */
const REAL_DAILY = JSON.parse(`{
  "schema_version": 1,
  "available": true,
  "days": 60,
  "start_date": "2026-08-21",
  "end_date": "2026-10-19",
  "models": ["deepseek-v4-flash", "GLM-5.2", "glm5.3-flash", "qwen3.8-27b"],
  "rows": [
    { "date": "2026-10-17", "model_tokens": {"glm5.3-flash": 2557515}, "total_tokens": 2557515, "total_requests": 75 },
    { "date": "2026-10-18", "model_tokens": {"glm5.3-flash": 23851383}, "total_tokens": 23851383, "total_requests": 569 },
    { "date": "2026-10-19", "model_tokens": {"qwen3.8-27b": 837786, "glm5.3-flash": 113041}, "total_tokens": 950827, "total_requests": 18 }
  ],
  "model_tokens": { "glm5.3-flash": 27314725 },
  "total_tokens": 27314725,
  "total_requests": 662
}`);

/** What `summary` answers while the CodingPlan has lapsed (observed 2026-10-19). */
const EXPIRED_BODY = JSON.parse('{"success":false,"error":"Unable to load CodingPlan usage"}');

describe('parseUsageSummary — real captured payload', () => {
  const s = parseUsageSummary(REAL_SUMMARY);

  it('strips the CodingPlan prefix the panel itself already prints', () => {
    assert.equal(s.planName, 'Lite-体验版');
  });

  it('reads the expiry and the remaining/total window', () => {
    assert.equal(s.expires, '2026-10-26');
    assert.equal(s.planWindow, '7d / 共 7d');
  });

  it('reads the window in real numbers, not a percentage alone', () => {
    assert.deepEqual(s.window, {
      metric: 'calls',
      hours: 5,
      limit: 200,
      used: 0,
      usagePercent: 0,
      exhausted: false,
      resetAt: '17:02',
      resetInSecs: 17001,
    });
  });

  it('does not require a `plan` when the window is present', () => {
    // The window IS the reading — a percentage and a reset time; the plan name is
    // what the card labels them with, and an empty label is a blank row.
    assert.equal(
      parseUsageSummary({
        available: true,
        primary_window: { usage_percent: 12, limit: 5, used: 1 },
      }).window.limit,
      5,
    );
  });
});

describe('parseUsageSummary — payloads it must refuse', () => {
  it('returns null for a missing payload, never a zero-filled reading', () => {
    for (const bad of [null, undefined, 0, '', 'nope', [], {}]) {
      assert.equal(parseUsageSummary(bad), null);
    }
  });

  it('returns null when the endpoint says it is unavailable', () => {
    assert.equal(parseUsageSummary({ available: false, plan: { name: 'x' } }), null);
    // The lapsed-plan answer is an HTTP 502 with this body — not a reading.
    assert.equal(parseUsageSummary(EXPIRED_BODY), null);
  });

  it('returns null when there is nothing showable in it', () => {
    assert.equal(parseUsageSummary({ available: true }), null);
    assert.equal(parseUsageSummary({ available: true, plan: { name: '  ' } }), null);
  });

  it('never coerces a mistyped field into a number', () => {
    // A string limit is NOT 200 here; the window survives on its other fields.
    const s = parseUsageSummary({
      available: true,
      primary_window: { usage_percent: 3, limit: '200', used: 3, quota_exhausted: 'yes' },
    });
    assert.equal(s.window.limit, null);
    assert.equal(s.window.used, 3);
    // Only an explicit `true` raises the alarm.
    assert.equal(s.window.exhausted, false);
  });

  it('drops a window that carries no numbers at all', () => {
    // An empty window is not a window, and with no window there is no reading —
    // a plan name cannot carry it (see the test below), so the whole payload goes.
    for (const payload of [
      { available: true, primary_window: { limit: null } },
      { available: true, plan: { name: 'CodingPlan Pro' }, primary_window: { limit: null } },
    ]) {
      assert.equal(parseUsageSummary(payload), null);
    }
  });

  it('refuses a plan with no window — the shape the text path refuses too', () => {
    // The only thing such a payload would print is a plan row and an expiry next
    // to a missing percentage: `reason` stays empty, `drift` stays false, and the
    // panel falls back to its own `|| '额度读数不可用'` instead of a host-worded
    // reason. `buildQuotaReport` refuses that exact shape for the TEXT source
    // (`found` requires the usage line, not the plan line), so the JSON source
    // must not be the one that still accepts it — refusing it sends the caller to
    // the text path, where the same fact gets a named reason and lights drift.
    assert.equal(parseUsageSummary({ available: true, plan: { name: 'CodingPlan Pro' } }), null);
    assert.equal(
      parseUsageSummary({
        available: true,
        plan: { name: 'CodingPlan Pro', expires_at: '2026-10-26', remaining_days: 7, total_days: 7 },
      }),
      null,
    );
  });

  it('refuses a window that lost its percentage', () => {
    // The percentage is the number the card leads with; `limit` and `used` only
    // label it (`本窗口 3 / 200 次`). Accepting the window anyway would print
    // those numbers next to the panel's own generic fallback and a dark drift
    // lamp — the same half-reading the text path refuses in `buildQuotaReport`,
    // where `found` requires the usage line.
    for (const payload of [
      { available: true, primary_window: { limit: 200, used: 3 } },
      { available: true, plan: { name: 'CodingPlan Pro' }, primary_window: { usage_percent: null } },
    ]) {
      assert.equal(parseUsageSummary(payload), null);
    }
  });
});

describe('summaryQuotaReport — one reading shape for the panel', () => {
  const r = summaryQuotaReport(parseUsageSummary(REAL_SUMMARY), 1_700_000_000_000);

  it('names the source so a text reading cannot masquerade as this one', () => {
    assert.equal(r.source, 'codingplan-json');
    assert.equal(r.sourceNote, '');
    assert.equal(r.drift, false);
    assert.equal(r.reason, '');
  });

  it('fills the shared quota branch fields the card already renders', () => {
    assert.equal(r.available, true);
    assert.equal(r.plan, 'Lite-体验版');
    assert.equal(r.expires, '2026-10-26');
    assert.equal(r.planWindow, '7d / 共 7d');
    assert.equal(r.usagePercent, 0);
    assert.equal(r.resetAt, '17:02');
    assert.equal(r.resetInSecs, 17001);
    assert.equal(r.limited, false);
    assert.equal(r.parseIssue, null);
    assert.equal(r.upstreamFailure, null);
    assert.deepEqual(r.raw, { planLine: null, usageLine: null });
    assert.equal(r.fetchedAt, 1_700_000_000_000);
  });

  it('leaves `resetIn` to the client, which renders it locally', () => {
    // The text source's "4h 58m 后" is a pre-rendered string; this source has the
    // seconds, and inventing a second formatter here would be a second truth.
    assert.equal(r.resetIn, null);
  });

  it('passes the window through in real numbers', () => {
    assert.equal(r.windowLimit, 200);
    assert.equal(r.windowUsed, 0);
    assert.equal(r.windowHours, 5);
    assert.equal(r.windowMetric, 'calls');
  });

  it('treats an exhausted window as limited, with or without the flag', () => {
    const flagged = summaryQuotaReport(
      parseUsageSummary({ available: true, primary_window: { limit: 200, used: 200, usage_percent: 100, quota_exhausted: true } }),
      0,
    );
    assert.equal(flagged.limited, true);
    // A payload that omits the flag but reports a full window still warns.
    const implied = summaryQuotaReport(
      parseUsageSummary({ available: true, primary_window: { limit: 200, used: 200, usage_percent: 100 } }),
      0,
    );
    assert.equal(implied.limited, true);
  });
});

describe('parseUsageDaily — per-day history', () => {
  const d = parseUsageDaily(REAL_DAILY);

  it('keeps the totals, the range and the model list', () => {
    assert.equal(d.schemaVersion, 1);
    assert.equal(d.days, 60);
    assert.equal(d.startDate, '2026-08-21');
    assert.equal(d.endDate, '2026-10-19');
    assert.deepEqual(d.models, ['deepseek-v4-flash', 'GLM-5.2', 'glm5.3-flash', 'qwen3.8-27b']);
  });

  it('reduces each row to the three fields the card draws', () => {
    assert.deepEqual(d.rows, [
      { date: '2026-10-17', tokens: 2557515, requests: 75 },
      { date: '2026-10-18', tokens: 23851383, requests: 569 },
      { date: '2026-10-19', tokens: 950827, requests: 18 },
    ]);
  });

  it('orders oldest → newest, whatever order the daemon sent', () => {
    const shuffled = {
      available: true,
      rows: [
        { date: '2026-10-19', total_tokens: 3 },
        { date: '2026-10-17', total_tokens: 1 },
        { date: '2026-10-18', total_tokens: 2 },
      ],
    };
    assert.deepEqual(
      parseUsageDaily(shuffled).rows.map((r) => r.date),
      ['2026-10-17', '2026-10-18', '2026-10-19'],
    );
  });

  it('keeps only the newest `keepDays` rows', () => {
    const many = {
      available: true,
      rows: Array.from({ length: 10 }, (_, i) => ({
        date: `2026-10-${String(i + 1).padStart(2, '0')}`,
        total_tokens: i,
        total_requests: 1,
      })),
    };
    const trimmed = parseUsageDaily(many, 3);
    assert.deepEqual(trimmed.rows.map((r) => r.date), ['2026-10-08', '2026-10-09', '2026-10-10']);
  });

  it('shows an idle day as a zero row, not as a missing one', () => {
    // The endpoint lists every day in its range; the gaps in the trend are what
    // makes an idle stretch readable, so a day without totals must survive.
    const d2 = parseUsageDaily({
      available: true,
      rows: [{ date: '2026-10-13', model_tokens: {}, total_tokens: 0, total_requests: 0 }],
    });
    assert.deepEqual(d2.rows, [{ date: '2026-10-13', tokens: 0, requests: 0 }]);
  });

  it('refuses the shapes that are not a history', () => {
    for (const bad of [null, undefined, 0, 'x', [], {}, { available: false, rows: [] }]) {
      assert.equal(parseUsageDaily(bad), null);
    }
    // `available: true` with nothing usable under it is still not a reading.
    assert.equal(parseUsageDaily({ available: true, rows: [] }), null);
    assert.equal(parseUsageDaily({ available: true, rows: 'nope' }), null);
  });

  it('skips rows without a date instead of inventing one', () => {
    const d2 = parseUsageDaily({
      available: true,
      rows: [{ total_tokens: 5 }, { date: '2026-10-19', total_tokens: 7 }],
    });
    assert.deepEqual(d2.rows, [{ date: '2026-10-19', tokens: 7, requests: 0 }]);
  });
});
