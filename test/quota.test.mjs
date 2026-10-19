/**
 * quota.test.mjs — CodingPlan quota extraction.
 *
 * The quota is only available as localized prose inside the daemon's `status`
 * command text, so the parser is the load-bearing part and gets pinned against
 * a REAL captured payload, a synthetic English one, and hostile inputs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStatusQuota, parseDurationSecs, buildQuotaReport } from '../lib/quota.js';

/** Captured verbatim from `POST /command {"command":"status"}` on 5.2.3. */
const REAL_ZH = [
  '  登录：  gcw_8biBqEYF',
  '  模型：    qwen3.8-27b',
  '  目录：    C:\\Users\\zhujieling11\\.dsh\\plugins\\dsh-atomcode-bridge',
  '  配置文件：C:\\Users\\zhujieling11\\.atomcode\\config.toml',
  '  CodingPlan：CodingPlan Lite-体验版  ·  到期 2026-10-19（5d / 共 7d）',
  '  用量：当前时间窗口用量约 77%  ·  重置于 20:32（29m 13s 后）',
  '  Proxy:  follow_system',
  '',
  '  指令文件：',
  '    × 用户全局（GLOBAL）：C:\\Users\\zhujieling11\\.atomcode\\ATOMCODE.md — 未找到',
].join('\n');

const SYNTH_EN = [
  '  CodingPlan: CodingPlan Pro  ·  expires 2026-11-01 (12d / 30d)',
  '  Usage: current window ~45%  ·  resets at 09:15 (1h 2m 3s)',
].join('\n');

describe('parseStatusQuota — real captured payload', () => {
  const q = parseStatusQuota(REAL_ZH);

  it('extracts the plan name without duplicating the label', () => {
    assert.equal(q.plan, 'Lite-体验版');
  });

  it('extracts the expiry date', () => {
    assert.equal(q.expires, '2026-10-19');
  });

  it('extracts the plan window', () => {
    assert.equal(q.planWindow, '5d / 共 7d');
  });

  it('extracts the rolling-window percentage', () => {
    assert.equal(q.usagePercent, 77);
  });

  it('extracts the reset wall-clock time', () => {
    assert.equal(q.resetAt, '20:32');
  });

  it('extracts the reset countdown in seconds', () => {
    assert.equal(q.resetInSecs, 29 * 60 + 13);
    assert.equal(q.resetIn, '29m 13s 后');
  });

  it('keeps the source lines for honest fallback display', () => {
    assert.match(q.raw.planLine, /CodingPlan/);
    assert.match(q.raw.usageLine, /77%/);
  });

  it('is not marked limited below 100%', () => {
    assert.equal(q.limited, false);
  });
});

describe('parseStatusQuota — English and edge inputs', () => {
  it('handles an English status text', () => {
    const q = parseStatusQuota(SYNTH_EN);
    assert.equal(q.plan, 'Pro');
    assert.equal(q.expires, '2026-11-01');
    assert.equal(q.planWindow, '12d / 30d');
    assert.equal(q.usagePercent, 45);
    assert.equal(q.resetAt, '09:15');
    assert.equal(q.resetInSecs, 3600 + 2 * 60 + 3);
  });

  it('flags a fully-exhausted window as limited', () => {
    const q = parseStatusQuota('  CodingPlan：CodingPlan Lite  ·  到期 2026-10-19（7d / 共 7d）\n  用量：当前时间窗口已用尽 100%  ·  重置于 20:32（1m 后）');
    assert.equal(q.usagePercent, 100);
    assert.equal(q.limited, true);
  });

  it('accepts a payload object as well as the bare text', () => {
    const q = parseStatusQuota({ kind: 'status', text: REAL_ZH });
    assert.equal(q.usagePercent, 77);
  });

  it('returns nulls (never guesses) when there is no quota line', () => {
    const q = parseStatusQuota('  登录：  someone\n  Proxy:  follow_system\n');
    assert.equal(q.plan, null);
    assert.equal(q.usagePercent, null);
    assert.equal(q.resetAt, null);
    assert.equal(q.limited, false);
  });

  it('survives empty, null and non-string input', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, { text: 7 }]) {
      const q = parseStatusQuota(bad);
      assert.equal(q.usagePercent, null, `input ${JSON.stringify(bad)} must not throw or invent a value`);
      assert.equal(q.plan, null);
    }
  });

  it('does not mistake a percentage-free line for the usage line', () => {
    const q = parseStatusQuota('  CodingPlan：CodingPlan Lite  ·  到期 2026-10-19（5d / 共 7d）');
    assert.equal(q.expires, '2026-10-19');
    assert.equal(q.usagePercent, null);
    assert.equal(q.raw.usageLine, null);
  });

  it('tolerates a decimal percentage with a comma separator', () => {
    assert.equal(parseStatusQuota('CodingPlan：X\n用量：window 88,5%  ·  resets 10:00（5m 后）').usagePercent, 88.5);
  });
});

describe('parseDurationSecs', () => {
  it('parses the shapes the daemon emits', () => {
    assert.equal(parseDurationSecs('29m 13s'), 1753);
    assert.equal(parseDurationSecs('29m 13s 后'), 1753);
    assert.equal(parseDurationSecs('1h29m'), 5340);
    assert.equal(parseDurationSecs('45s'), 45);
    assert.equal(parseDurationSecs('1h 2m 3s'), 3723);
    assert.equal(parseDurationSecs('2h'), 7200);
  });

  it('returns null rather than 0 for anything unparseable', () => {
    // 0 would render as "resets now", which is a lie.
    for (const bad of ['', '   ', '5d / 共 7d', 'soon', null, undefined, 7]) {
      assert.equal(parseDurationSecs(bad), null, `input ${JSON.stringify(bad)}`);
    }
  });
});

describe('buildQuotaReport', () => {
  it('reports available with parsed fields on success', () => {
    const r = buildQuotaReport({ ok: true, kind: 'status', text: REAL_ZH }, 1234);
    assert.equal(r.available, true);
    assert.equal(r.usagePercent, 77);
    assert.equal(r.fetchedAt, 1234);
    assert.equal(r.reason, '');
  });

  it('drift lights when plan parses but usage line is unrecognised', () => {
    // The most realistic drift shape: plan line anchored on the proper noun
    // "CodingPlan" (stable), usage line anchored on translated prose (drifts).
    const r = buildQuotaReport(
      { ok: true, kind: 'status', text: 'CodingPlan：CodingPlan Lite-体验版 · 到期 2026-10-19（5d / 共 7d）\n已消耗：本窗口 77% · 将于 20:32 恢复' },
      1234,
    );
    assert.equal(r.available, true);
    assert.equal(r.plan, 'Lite-体验版');
    assert.equal(r.usagePercent, null);
    assert.equal(r.drift, true, 'usage line unrecognised → drift must be true');
    assert.ok(r.reason.length > 0, 'reason must be non-empty when drift is true');
  });

  it('reports unavailable (with the daemon message) when the command failed', () => {
    const r = buildQuotaReport({ ok: false, message: 'unknown command: status' }, 99);
    assert.equal(r.available, false);
    assert.match(r.reason, /unknown command/);
  });

  it('reports unavailable when the command succeeded but carried no quota', () => {
    const r = buildQuotaReport({ ok: true, text: '  登录：  someone\n' }, 1);
    assert.equal(r.available, true, 'the command worked even though the text had no quota');
    assert.equal(r.usagePercent, null);
    assert.match(r.reason, /no recognisable quota line/);
  });

it('handles a missing result object', () => {
    const r = buildQuotaReport(undefined, 5);
    assert.equal(r.available, false);
    assert.equal(typeof r.reason, 'string');
  });
});

/**
 * Refusals found by AtomCode reviewing an earlier minor (2026-10-14).
 *
 * Both cases share one shape: the line parses "successfully" and yields a
 * number that is NOT the window usage. Before these guards the parser took the
 * FIRST percentage on the line and reported `found: true`, so `drift` stayed
 * false and the panel showed a confident wrong number — precisely what red
 * line 2 ("解析不出来的额度不许编数字") exists to prevent. The fix refuses,
 * and refusing must LIGHT the drift lamp rather than hide behind a plan line
 * that happened to parse.
 */
describe('parseStatusQuota — lines it must refuse to interpret', () => {
  const planLine = '  CodingPlan：CodingPlan Lite-体验版  ·  到期 2026-10-19（5d / 共 7d）';
  const twoPcts = '  用量：折扣 20% 当前时间窗口用量约 77%  ·  重置于 20:32（29m 13s 后）';
  const reverse = '  Usage: 100% remaining  ·  resets at 09:15 (1h 2m 3s)';

  it('refuses a usage line carrying two percentages', () => {
    const r = parseStatusQuota([planLine, twoPcts].join('\n'));
    // Picking either is a guess: 20 is the wrong concept, 77 assumes which of
    // the two the label points at.
    assert.equal(r.usagePercent, null, 'must not pick a winner among two percentages');
    assert.equal(r.parseIssue, 'multiple-percentages');
    assert.equal(r.limited, false, 'a refused number must never raise the exhausted alarm');
    // The reset clock comes from its own labelled field, so it survives.
    assert.equal(r.resetAt, '20:32');
    assert.equal(r.resetInSecs, 1753);
  });

  it('refuses reverse semantics ("100% remaining") instead of converting it', () => {
    const r = parseStatusQuota([planLine, reverse].join('\n'));
    assert.equal(r.usagePercent, null);
    assert.equal(r.parseIssue, 'reverse-semantics');
    // The whole point: a FULL window must not be reported as exhausted.
    assert.equal(r.limited, false, '100% remaining must not read as 100% spent');
  });

  it('does NOT refuse a normal single-percentage line (no over-blocking)', () => {
    // A guard that fires on healthy input blackouts the quota — the same harm
    // in the other direction. This is why REMAINING_LABEL is narrow and does
    // not match a bare `余`.
    const r = parseStatusQuota(REAL_ZH);
    assert.equal(r.usagePercent, 77);
    assert.equal(r.parseIssue, null);
  });

  it('surfaces a refusal as drift, even though the plan line parsed fine', () => {
    // The blind spot this closes: `found` used to be true on plan-only
    // success, so the panel reported a healthy state beside a missing number.
    const r = buildQuotaReport({ ok: true, text: [planLine, twoPcts].join('\n') }, 1);
    assert.equal(r.available, true, 'the command itself worked');
    assert.equal(r.usagePercent, null);
    assert.equal(r.drift, true, 'a refused line IS drift');
    assert.notEqual(r.reason, '', 'the panel needs text to explain the missing number');
    assert.match(r.reason, /多个百分数|无法判定/);
  });

  it('names reverse semantics in the report reason', () => {
    const r = buildQuotaReport({ ok: true, text: [planLine, reverse].join('\n') }, 1);
    assert.equal(r.drift, true);
    assert.match(r.reason, /剩余|相反/);
  });
});
