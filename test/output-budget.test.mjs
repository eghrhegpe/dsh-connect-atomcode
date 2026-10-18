/**
 * output-budget.test.mjs — one context budget, spent once per return.
 *
 * The plugin once had four independent limits (`REPLY_CAP` / `REPORT_CAP`, both
 * `200_000`, plus `TOOLS_CAP` / `FINDINGS_CAP` for the arrays) and no shared
 * notion of "what one turn may cost the model". They collapsed into the single
 * `OUTPUT_CAP`, applied once in `execute` by `capProse` — the render prints what
 * it is handed and never re-cuts.
 *
 * These cases pin the shared constant and the one truncation marker, on the one
 * tool that is left.
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
const { OUTPUT_CAP } = await import(pathToFileURL(join(ROOT, 'lib', 'config.js')).href);

/**
 * Mount the plugin and hand back the tool's render function.
 *
 * `auto_start: false` and a port nothing listens on: these cases only call
 * `render`, so no daemon is contacted — but the mount is still the real one, so
 * the numbers asserted below are the numbers the shipped tool carries rather than
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
  assert.ok(ask, 'atomcode_ask must be registered');
  return { ask };
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

describe('one budget constant for the one tool', () => {
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

  it('the render never re-cuts the field it is handed', () => {
    // The marker is written by `capProse` in `execute`, not by `render`; an
    // oversized value passed straight to `render` therefore prints whole. That is
    // the property worth pinning: render does not silently re-cut, and does not
    // invent a second marker. (The digest/findings/report-copy machinery that
    // used to share this budget went away with the retired review CLI.)
    const { ask } = mount();
    const text = textOf(ask, askValue({ reply: 'b'.repeat(OUTPUT_CAP + 10) }));
    assert.ok(text.includes('b'.repeat(OUTPUT_CAP + 10)), 'render must not re-cut the field');
    assert.doesNotMatch(text, /本回合预算/, 'there is no digest to spend budget against');
    assert.doesNotMatch(text, /findings 清单已占用/, 'nor a findings list');
  });
});

describe('elapsed_ms reaches the model (the wall-time contract)', () => {
  // The model reads `render`, not the raw JSON object, so a field that lives only
  // in the return value is invisible to it — this is the whole point of pinning
  // the meta line, not just the field. The guard is `typeof … === 'number'`:
  // a value present prints it, a value absent must NOT print `undefined`.
  it('prints elapsed_ms when present, omits it cleanly when absent', () => {
    const { ask } = mount();
    const shown = textOf(ask, askValue({ elapsed_ms: 4200 }));
    assert.match(shown, /elapsed_ms=4200/, 'the wall time must reach the model');
    const absent = textOf(ask, askValue());
    assert.doesNotMatch(absent, /elapsed_ms=/, 'an omitted elapsed_ms must not print undefined');
  });

  it('the schema carries elapsed_ms as a required single-type number', () => {
    // required, or the host's call-time validation would let a missing field
    // through and the model would silently lose it on some paths; single-type
    // (no `type` array) because it is never null — a turn that failed still
    // spent time, so `empty()` reports a number too (红线 9: an array-type union
    // reaching `tools.register` rejects the WHOLE plugin, not just this field).
    const { ask } = mount();
    const node = ask.output.schema.properties.elapsed_ms;
    assert.ok(node, 'the ask schema must carry elapsed_ms');
    assert.equal(node.type, 'number', 'a plain number, not a type union');
    assert.ok(ask.output.schema.required.includes('elapsed_ms'), 'elapsed_ms is required');
  });
});
