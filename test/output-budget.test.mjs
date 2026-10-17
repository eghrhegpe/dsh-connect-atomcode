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
});

describe('the review return spends the SAME budget, because it IS an ask turn', () => {
  // This suite used to police the CLI shape too — a digest of structured
  // `findings[]` sharing one budget with a raw document, a floor so the raw half
  // could not be starved, and a note that named BOTH cuts. All of that was
  // deleted with the review CLI: an ask turn has no digest to share with, and
  // the cap is applied in `execute` by the SAME `capProse` call ask uses (see
  // the marker case above). What remains worth pinning is that the review
  // render adds no second convention of its own.

  it('adds no marker of its own — the report is printed as the ask render would print it', () => {
    // The marker is written by `capProse` in `execute`, not by `render`; the
    // render's only job on a cut field is the one note below. Passing an
    // oversized report straight to `render` therefore prints it whole — which is
    // exactly the property worth pinning: render does not silently re-cut, and
    // does not invent a second marker.
    const { review } = mount();
    const text = textOf(review, reviewValue({ report: 'b'.repeat(OUTPUT_CAP + 10) }));
    assert.ok(text.includes('b'.repeat(OUTPUT_CAP + 10)), 'render must not re-cut the field');
    assert.doesNotMatch(text, /truncated by dsh-connect-atomcode/, 'and must not invent a marker either');
    assert.doesNotMatch(text, /本回合预算/, 'there is no digest to spend budget against any more');
    assert.doesNotMatch(text, /findings 清单已占用/, 'nor a findings list');
    assert.doesNotMatch(text, /--- report 原文 ---/, 'and no second copy of the report');
  });

  it('says one thing about an upstream cut, in the review\'s own words', () => {
    const { review } = mount();
    const text = textOf(review, reviewValue({ report: 'c', truncated: true }));
    assert.match(text, /\[注意：report 已截断，让它把完整报告写到文件里再读\]/);
    assert.equal((text.match(/\[注意：/g) || []).length, 1, 'one note, not two competing ones');
  });

  it('prints a small report whole, with no notice at all', () => {
    const { review } = mount();
    const text = textOf(review, reviewValue({ report: 'a short review of the diff' }));
    assert.match(text, /a short review of the diff/);
    assert.doesNotMatch(text, /truncated by dsh-connect-atomcode/);
    assert.doesNotMatch(text, /\[注意：/);
  });

  it('never mentions findings, exit_code or duration — the CLI is gone', () => {
    const { review } = mount();
    const text = textOf(review, reviewValue({ report: 'x' }));
    assert.doesNotMatch(text, /findings/i);
    assert.doesNotMatch(text, /exit_code|exit code/i);
    assert.doesNotMatch(text, /duration_ms/);
  });
});

describe('elapsed_ms reaches the model on BOTH tools (the wall-time contract)', () => {
  // The model reads `render`, not the raw JSON object, so a field that lives only
  // in the return value is invisible to it — this is the whole point of pinning
  // the meta line, not just the field. Both guards are `typeof … === 'number'`:
  // a value present prints it, a value absent must NOT print `undefined`.
  it('ask: prints elapsed_ms when present, omits it cleanly when absent', () => {
    const { ask } = mount();
    const shown = textOf(ask, askValue({ elapsed_ms: 4200 }));
    assert.match(shown, /elapsed_ms=4200/, 'the wall time must reach the model');
    const absent = textOf(ask, askValue());
    assert.doesNotMatch(absent, /elapsed_ms=/, 'an omitted elapsed_ms must not print undefined');
  });

  it('review: prints elapsed_ms when present, omits it cleanly when absent', () => {
    const { review } = mount();
    const shown = textOf(review, reviewValue({ elapsed_ms: 9800 }));
    assert.match(shown, /elapsed_ms=9800/, 'the same line on the review tool');
    const absent = textOf(review, reviewValue());
    assert.doesNotMatch(absent, /elapsed_ms=/, 'and the same omission rule');
  });

  it('both schemas carry elapsed_ms as a required single-type number', () => {
    // required, or the host's call-time validation would let a missing field
    // through and the model would silently lose it on some paths; single-type
    // (no `type` array) because it is never null — a turn that failed still
    // spent time, so `empty()` reports a number too (红线 9: an array-type union
    // reaching `tools.register` rejects the WHOLE plugin, not just this field).
    const { ask, review } = mount();
    for (const tool of [ask, review]) {
      const node = tool.output.schema.properties.elapsed_ms;
      assert.ok(node, `${tool.name} schema must carry elapsed_ms`);
      assert.equal(node.type, 'number', 'a plain number, not a type union');
      assert.ok(tool.output.schema.required.includes('elapsed_ms'), `${tool.name}: elapsed_ms is required`);
    }
  });
});
