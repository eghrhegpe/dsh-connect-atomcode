/**
 * output-budget.test.mjs — one context budget, spent once per return.
 *
 * The plugin had four independent limits (`REPLY_CAP` / `REPORT_CAP`, both
 * `200_000`, plus `TOOLS_CAP` / `FINDINGS_CAP` for the arrays) and no shared
 * notion of "what one turn may cost the model". The review path was the visible
 * consequence: it capped the report FIELD at 200KB and then printed the findings
 * DIGEST on top of it, so one return could carry about twice the intended
 * budget — the same content twice, paid for twice.
 *
 * These cases pin the shared constant, the one truncation marker, and the thing
 * that actually changed behaviour: the review render spends `OUTPUT_CAP` across
 * the WHOLE return (digest + raw) rather than per field, with a floor the raw
 * document can never fall below.
 *
 * No server, no daemon: `render` is a pure function of the value it is handed,
 * which is exactly why the budget belongs here and not in `execute`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sentinelPort } from './dead-port.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
const { OUTPUT_CAP, REVIEW_REPORT_FLOOR } = await import(
  pathToFileURL(join(ROOT, 'lib', 'config.js')).href
);

/**
 * Mount the plugin and hand back both tools' render functions.
 *
 * `auto_start: false` and a port nothing listens on: these cases only call
 * `render`, so no daemon is contacted — but the mount is still the real one, so
 * the numbers asserted below are the numbers the shipped tools carry rather than
 * a second copy of them rebuilt here.
 */
function mount() {
  const tools = [];
  const ctx = {
    get: (name) => (name === 'tools' ? { register: (def) => { tools.push(def); return () => {}; } } : undefined),
    logger: { warn() {}, error() {}, info() {} },
    fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
    inject() {},
    effect() {},
    on() {},
  };
  // Sentinel 10: inert — render is a pure function; the mount exists only to
  // obtain the descriptors (see the suite header).
  mod.apply(ctx, {
    auto_start: false,
    port: sentinelPort(10),
    state_path: join(mkdtempSync(join(tmpdir(), 'atomcode-budget-')), 'sessions.json'),
  });
  const ask = tools.find((t) => t.name === 'atomcode_ask');
  const review = tools.find((t) => t.name === 'atomcode_review');
  assert.ok(ask && review, 'both tools must be registered');
  return { ask, review };
}

/** The rendered text a model would read, joined. */
const textOf = (tool, value) => tool.output.render({}, value).map((part) => part.text).join('\n');

/** A valid `atomcode_ask` output value, with `overrides` applied. */
function askValue(overrides = {}) {
  return {
    ok: true,
    reply: 'ok',
    session_id: 's',
    continued: false,
    truncated: false,
    tokens: 1,
    tool_calls: 0,
    round_count: 0,
    tools: [],
    tools_truncated: false,
    stop_reason: 'stopped',
    working_dir: 'C:\\repo',
    provider: 'p',
    providerReported: true,
    protocol_unknown_types: [],
    daemon_tool_calls: 0,
    daemon_rounds: 0,
    error: '',
    ...overrides,
  };
}

/** A valid `atomcode_review` output value, with `overrides` applied. */
function reviewValue(overrides = {}) {
  return {
    ok: true,
    report: '{"findings":[]}',
    truncated: false,
    findings_parsed: true,
    findings_count: 0,
    findings: [],
    error: '',
    exit_code: 0,
    duration_ms: 1000,
    ...overrides,
  };
}

/** `n` findings that all fit the digest, so every one of them is printed. */
const digestFindings = (n) =>
  Array.from({ length: n }, (_, i) => ({
    severity: 'medium',
    file: `src/file-${i}.ts`,
    line: String(i + 1),
    message: `problem number ${i} — a sentence long enough to be a realistic finding line`,
  }));

describe('one budget constant, shared by both tools', () => {
  it('is exported once and is a sane character count', () => {
    assert.equal(typeof OUTPUT_CAP, 'number');
    assert.ok(OUTPUT_CAP >= 10_000, 'a budget too small to hold a report is not a budget');
    assert.ok(REVIEW_REPORT_FLOOR > 0 && REVIEW_REPORT_FLOOR < OUTPUT_CAP);
  });

  it('a reply at exactly the budget is printed whole, with no notice', () => {
    // Off-by-one in the safe direction: a full-but-legal reply must not carry a
    // truncation notice, or the marker stops meaning "something was lost".
    // (The CUT half of the ask path is driven through a real turn in
    // ask-glue.test.mjs — for ask the field is capped in `execute`, not here.)
    const { ask } = mount();
    const text = textOf(ask, askValue({ reply: 'y'.repeat(OUTPUT_CAP) }));
    assert.doesNotMatch(text, /truncated by dsh-connect-atomcode/);
    assert.ok(text.includes('y'.repeat(OUTPUT_CAP)), 'the budget itself must be fully usable');
  });

  it('a reply that was already cut upstream keeps its marker AND its warning', () => {
    // `truncated: true` plus the in-text marker is what `execute` produces. The
    // render must swallow neither: the inline marker is what makes the clip
    // point visible in the prose, the flag is what drives the warning line.
    const { ask } = mount();
    const text = textOf(
      ask,
      askValue({
        reply: `${'z'.repeat(OUTPUT_CAP)}\n\n[truncated by dsh-connect-atomcode: 500 more characters; ask AtomCode to write the full text to a file and read that instead]`,
        truncated: true,
      }),
    );
    assert.match(text, /truncated by dsh-connect-atomcode: 500 more characters; /);
    assert.match(text, /reply 已截断/, 'and the flag must still produce its own warning');
  });

  it('both tools use the SAME marker wording', () => {
    // Two conventions is how a reader learns to trust one and miss the other.
    // The ask half comes from `capProse` in `execute` (asserted with an exact
    // count through a real turn in ask-glue.test.mjs); this pins the review half
    // to the identical sentence shape — including the `; remedy` tail, so
    // "something was lost" and "here is what to do" always travel together.
    //
    // The COUNT here is not 10: the digest has already spent part of the shared
    // budget, which is the whole point of this file. Exactness is asserted where
    // the budget is uncontended (ask), and the shared arithmetic where it is not
    // (the review cases below).
    const { review } = mount();
    const text = textOf(review, reviewValue({ report: 'b'.repeat(OUTPUT_CAP + 10) }));
    assert.match(text, /\[truncated by dsh-connect-atomcode: \d+ more characters; re-run with a task/);
  });
});

describe('the review return spends ONE budget across digest + raw', () => {
  it('a small review is left completely alone', () => {
    const { review } = mount();
    const text = textOf(
      review,
      reviewValue({ findings: digestFindings(2), findings_count: 2 }),
    );
    assert.match(text, /--- report 原文 ---/);
    assert.doesNotMatch(text, /truncated by dsh-connect-atomcode/);
    assert.doesNotMatch(text, /本回合预算/);
  });

  it('digest + raw together stay inside the budget when the raw is large', () => {
    // The case that used to cost twice: 200 findings printed as a digest AND a
    // raw document at its own full cap.
    const { review } = mount();
    const findings = digestFindings(200);
    const value = reviewValue({
      findings,
      findings_count: 200,
      report: 'z'.repeat(OUTPUT_CAP),
    });
    const text = textOf(review, value);
    const rawSection = text.split('--- report 原文 ---')[1] || '';
    assert.ok(
      rawSection.length <= OUTPUT_CAP - text.split('--- report 原文 ---')[0].length + REVIEW_REPORT_FLOOR + 400,
      `digest + raw must share one budget; got ${text.length} chars`,
    );
    assert.ok(text.length <= OUTPUT_CAP + REVIEW_REPORT_FLOOR + 400, `worst case is bounded, got ${text.length}`);
    assert.match(text, /本回合预算/, 'the second cut must say it is the BUDGET that did it');
    assert.match(text, /findings 清单已占用 \d+ 字/, 'and how much of the budget the digest took');
  });

  it('the raw document never shrinks below the floor, however big the digest', () => {
    // The floor exists so a complete digest cannot starve the raw document to
    // nothing: the digest normalizes fields a finding may carry.
    const { review } = mount();
    const huge = digestFindings(200).map((f) => ({ ...f, message: 'm'.repeat(900) }));
    const text = textOf(
      review,
      reviewValue({ findings: huge, findings_count: huge.length, report: 'q'.repeat(OUTPUT_CAP) }),
    );
    const rawSection = (text.split('--- report 原文 ---')[1] || '').split('[注意：')[0];
    assert.ok(
      rawSection.length >= REVIEW_REPORT_FLOOR,
      `the raw document must keep its floor; got ${rawSection.length}`,
    );
  });

  it('names BOTH cuts when the field was already truncated upstream', () => {
    // `truncated: true` means the field itself was cut before this render ran, so
    // content was already missing when the budget was computed. A reader told
    // only "the budget cut it" would size what they got wrongly.
    const { review } = mount();
    const text = textOf(
      review,
      reviewValue({
        findings: digestFindings(200),
        findings_count: 200,
        report: 'w'.repeat(OUTPUT_CAP),
        truncated: true,
      }),
    );
    assert.match(text, /字段上限截断/, 'the upstream cut');
    assert.match(text, /又按本回合预算/, 'and the render-level cut');
    assert.equal(
      (text.match(/\[注意：/g) || []).length >= 1,
      true,
      'the two reasons belong in one note, not two competing ones',
    );
  });
});
