// @ts-check
/**
 * The `any` BUDGET gate — a fence around the debt `noImplicitAny: false` allows.
 *
 * WHAT IT PINS. A per-file ceiling on explicit `any` in the shipped source
 * (`src/**\/*.ts`), frozen in `test/baselines/any-budget.json`. A file may not go
 * above the count recorded for it; a file absent from the baseline starts at zero.
 *
 * WHY IT EXISTS. `tsconfig.json`'s `$comment` records `noImplicitAny: false` as a
 * deliberate trade-off — untyped signatures in the Host glue stay greppable and
 * never block the build, with "tsc plus the test/build gates" named as the
 * substitute. That substitution is true for the type layer, the build freshness
 * gate and the peer contract, and it was simply absent for the debt the
 * trade-off actually creates: nothing in the suite ever counted `any`, so the
 * number only ever went up, and a new `any` was indistinguishable from an old
 * one. This gate is the missing half — not a reversal of the trade-off, a ledger
 * for it.
 *
 * WHY A BUDGET AND NOT A BAN. The same tsconfig note is explicit that the glue
 * is *meant* to stay untyped where typing it would cost more than it buys
 * (inline wiring shapes, peer surfaces we do not own). Banning `any` would
 * fight the decision that was made on purpose and lose. Capping it does not:
 * the debt stays visible, and it can no longer grow by accident.
 *
 * WHY THE BLUNTEST POSSIBLE RULE. The count is `/\bany\b/` — not a
 * "type-position" pattern — over comment- and string-blanked lines. A clever
 * pattern was measured against this one and lost twice: it missed every `any` in
 * a RETURN position (`(service: string) => any`) and it counted only the first
 * `any` on a line, so `(...args: any[]) => any` scored 1 instead of 2. A rule
 * that a new file, a new module or an AI session can dodge by writing a slightly
 * different shape is not a budget. The one exclusion is a member call
 * (`AbortSignal.any([…])`), made by lookbehind on the dot rather than by an
 * allow-list.
 *
 * WHY THERE IS NO SKIP BRANCH. This gate reads only files inside this repo and
 * needs no tool, runtime or key. There is no environment that cannot run it, so
 * a SKIP here would only ever be a way to be quiet. Finding nothing to count is
 * a failure (see the floor checks below), not a skip.
 *
 * WHY `test/` IS NOT IN SCOPE. This file is itself dense with the token it
 * counts — the rule, the probe, the prose. Scanning the test tree would make
 * the gate a reader of its own evidence. The debt that matters is the one that
 * ships.
 *
 * WHY IT SCANS `src/` AND NOT THE ARTIFACTS. The rest of this repo's suites
 * test the built `lib/*.js` / `client.js`, because the artifacts are what runs.
 * This gate is the one exception, on purpose: `any` is a SOURCE property. A
 * bundler may erase or rewrite it, so counting the artifact would count
 * something other than the debt being governed. `test/build-gate.test.mjs`
 * already guarantees the artifacts are a faithful build of `src/`.
 *
 * REGENERATING. Budget is spent deliberately, not silently. Two spellings, both
 * supported because Windows cannot do `VAR=1 cmd`:
 *   npm run any:baseline                          (the npm script)
 *   node test/any-budget.test.mjs --update-baseline
 *   UPDATE_BASELINE=1 node test/any-budget.test.mjs (POSIX shells)
 * Each writes the current counts and leaves the suite green. The change then
 * lands as a visible diff in the baseline file, which is what review is for — a
 * file whose number went UP is a decision, and it should be argued in that
 * commit, not here.
 *
 * @module test/any-budget
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(root, 'test', 'baselines', 'any-budget.json');

/**
 * The whole rule: the word `any` in code, minus `something.any(…)`.
 * See the module docblock for why it is not a type-position pattern.
 */
const ANY_RE = /(?<!\.)\bany\b/g;

/**
 * Floor on the number of files the walk must see. A walk that quietly returns
 * nothing would make every "within budget" comparison pass for the wrong
 * reason, which is how a fence goes blind.
 *
 * 25, not agnes' 80: this repo's `src/` holds 30 `.ts` files (host 16 / client
 * 11 / shared 3). The floor exists to catch a BROKEN walk, not to assert a
 * file count — so it sits below the real number with room to grow, and the
 * half-split check below does the finer work.
 */
const FILE_FLOOR = 25;

/**
 * Regeneration is asked for two ways, because the two shells disagree:
 * an environment variable (POSIX) and a command-line flag (Windows-safe, and
 * the spelling the npm script uses).
 */
const REGENERATE =
  process.env.UPDATE_BASELINE === '1' || process.argv.includes('--update-baseline');

/** @param {string} width @returns {string} */
const pad = (width) => ' '.repeat(Math.max(0, width));

/** @param {string} file @returns {string} repo-relative, POSIX-separated */
const key = (file) => relative(root, file).split(sep).join('/');

/**
 * Replace comments and string/template bodies with spaces, keeping every line
 * and every column exactly where it was.
 *
 * Column preservation is the point: the count is taken per line, so a
 * "strip the comments" pass that collapses lines would let a comment on line
 * 40 absorb half of line 41 and invent a match that is not in the source.
 * State (`block` / template) survives line ends, so a multi-line comment or
 * template literal stays blanked across the whole span.
 * @param {string} source
 * @returns {string[]} one blanked line per input line.
 */
function blankLines(source) {
  /** @type {string[]} */
  const out = [];
  let mode = 'code';
  for (const line of source.split(/\r?\n/)) {
    let buf = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (mode === 'block') {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          buf += pad(n - i);
          i = n;
        } else {
          buf += pad(end + 2 - i);
          i = end + 2;
          mode = 'code';
        }
        continue;
      }
      if (mode === 'tpl') {
        let j = i;
        while (j < n) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === '`') {
            buf += pad(j - i) + '`';
            j += 1;
            mode = 'code';
            break;
          }
          j += 1;
        }
        if (j >= n && mode === 'tpl') {
          buf += pad(n - i);
          i = n;
        } else {
          i = j;
        }
        continue;
      }
      const c = line[i];
      const d = line[i + 1];
      if (c === '/' && d === '/') {
        buf += pad(n - i);
        i = n;
        continue;
      }
      if (c === '/' && d === '*') {
        mode = 'block';
        const end = line.indexOf('*/', i + 2);
        if (end === -1) {
          buf += pad(n - i);
          i = n;
        } else {
          buf += pad(end + 2 - i);
          i = end + 2;
          mode = 'code';
        }
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === c) {
            j += 1;
            break;
          }
          j += 1;
        }
        buf += c + pad(Math.max(0, j - i - 2)) + (j <= n ? c : '');
        i = j;
        continue;
      }
      if (c === '`') {
        mode = 'tpl';
        buf += '`';
        i += 1;
        let j = i;
        while (j < n) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === '`') {
            buf += pad(j - i) + '`';
            j += 1;
            mode = 'code';
            break;
          }
          j += 1;
        }
        if (j >= n && mode === 'tpl') {
          buf += pad(n - i);
          i = n;
        } else {
          i = j;
        }
        continue;
      }
      buf += c;
      i += 1;
    }
    out.push(buf);
  }
  return out;
}

/**
 * Every `.ts` file under `dir`.
 *
 * `node_modules` / `lib` / `upstream` are skipped: the first two are not
 * sources, and `upstream/` is a third-party checkout that is deliberately not
 * in this repository's history (see `THIRD_PARTY_NOTICES.md`) — counting its
 * `any` would make the budget depend on a clone this repo does not own.
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function tsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'upstream') continue;
      tsFiles(path, out);
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * @param {string} file
 * @returns {{ count: number, sample: string[] }} the count and up to three sample lines.
 */
function countAny(file) {
  const lines = blankLines(readFileSync(file, 'utf8'));
  let count = 0;
  /** @type {string[]} */
  const sample = [];
  lines.forEach((line, index) => {
    const hits = line.match(ANY_RE);
    if (hits === null || hits.length === 0) return;
    count += hits.length;
    if (sample.length < 3) sample.push(`${index + 1}: ${line.trim()}`);
  });
  return { count, sample };
}

// --- the scan ---------------------------------------------------------------
/** @type {Map<string, { count: number, sample: string[] }>} */
const actual = new Map();
for (const file of tsFiles(join(root, 'src')).sort()) {
  actual.set(key(file), countAny(file));
}
let total = 0;
for (const info of actual.values()) total += info.count;

/**
 * Per-half TALLIES, not per-half file counts.
 *
 * The half split exists so that a scanner which silently stopped reading one
 * half cannot pass unnoticed: "host has 16 files" stays true even when the
 * half's `any` count has gone to zero, whereas "host counts 72 `any`" goes red
 * the moment that half stops being scanned. So the number that is checked is
 * the `any` tally of the half, and the file count is carried along only to
 * make the failure message readable.
 */
const halves = {
  host: { files: 0, any: 0 },
  client: { files: 0, any: 0 },
  shared: { files: 0, any: 0 },
};
for (const [name, info] of actual) {
  for (const half of /** @type {const} */ (['host', 'client', 'shared'])) {
    if (!name.startsWith(`src/${half}/`)) continue;
    halves[half].files += 1;
    halves[half].any += info.count;
  }
}

// --- regeneration ------------------------------------------------------------
// Written BEFORE the assertions run, so a regeneration leaves the suite green
// and the checks below read the file that was just written.
if (REGENERATE) {
  /** @type {Record<string, number>} */
  const recorded = {};
  let recordedTotal = 0;
  for (const [name, info] of actual) {
    if (info.count === 0) continue; // a file with no debt needs no line: absent means zero.
    recorded[name] = info.count;
    recordedTotal += info.count;
  }
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        $comment:
          'Per-file ceiling on explicit `any` in the shipped source. Written by `npm run any:baseline` ' +
          '(or `node test/any-budget.test.mjs --update-baseline`); checked on every `npm test`. ' +
          'A file absent here has a budget of zero. Raising a number is a decision — argue it in the ' +
          'commit that changes this file.',
        rule: String(ANY_RE),
        scope: ['src/**/*.ts'],
        total: recordedTotal,
        files: recorded,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `[any-budget] wrote ${key(BASELINE)} — ${Object.keys(recorded).length} file(s) carrying debt, total ${recordedTotal}`,
  );
}

// --- the baseline ------------------------------------------------------------
/** @type {{ ok: true, value: any } | { ok: false, error: string }} */
let baselineRead;
try {
  baselineRead = { ok: true, value: JSON.parse(readFileSync(BASELINE, 'utf8')) };
} catch (error) {
  baselineRead = { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** @type {Record<string, number>} */
const budgets = {};
if (baselineRead.ok) {
  const raw = baselineRead.value && typeof baselineRead.value === 'object' ? baselineRead.value.files : null;
  if (raw !== null && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === 'number') budgets[name] = value;
    }
  }
}
const budgetTotal = baselineRead.ok && typeof baselineRead.value?.total === 'number' ? baselineRead.value.total : -1;

/** @type {string[]} */
const over = [];
for (const [name, info] of actual) {
  const budget = budgets[name] ?? 0;
  if (info.count <= budget) continue;
  over.push(`${name}: ${info.count} (budget ${budget})`);
}

// --- the gate ----------------------------------------------------------------
describe('the any budget', () => {
  // The scanner guards itself before it is trusted with anything. Both
  // directions are pinned on purpose. Only "counts the obvious `: any`" is the
  // easy half; "does NOT count the word when it is prose" is the half that
  // decays, because a blanking bug that swallows code shows up as a lower
  // number and a lower number reads as an improvement.
  it('the scanner counts code and ignores prose', () => {
    const probe = [
      'const a: any = 1;', // 1 — the case everyone remembers
      '// any', // 0 — line comment
      '/* any */', // 0 — block comment
      'const s = "any";', // 0 — string body
      'const t = `any`;', // 0 — template body
      'x = AbortSignal.any([a]);', // 0 — member call, not a type
      '(cb: (service: string) => any) => 1', // 1 — return position, the case a clever rule missed
    ].join('\n');
    const counted = blankLines(probe).reduce((sum, line) => sum + (line.match(ANY_RE) ?? []).length, 0);
    assert.strictEqual(
      counted,
      2,
      `the probe counted ${counted}, expected 2 — one annotation "any", one return-position "any"`,
    );
  });

  it(`the walk saw at least ${FILE_FLOOR} source files`, () => {
    assert.ok(
      actual.size >= FILE_FLOOR,
      `scanned ${actual.size} file(s) under src/ — expected at least ${FILE_FLOOR}. ` +
        'A walk that returns nothing makes every budget comparison pass for the wrong reason.',
    );
  });

  it('the walk still sees both source halves', () => {
    assert.ok(
      halves.host.any > 0 && halves.client.any > 0,
      `src/host counted ${halves.host.any} "any" in ${halves.host.files} file(s); ` +
        `src/client counted ${halves.client.any} "any" in ${halves.client.files} file(s). ` +
        'Both halves must carry debt, or one half is not being scanned at all.',
    );
  });

  it('the baseline is readable', () => {
    assert.ok(
      baselineRead.ok,
      `no readable baseline at ${key(BASELINE)} (${baselineRead.ok ? '' : baselineRead.error}). ` +
        'Generate it once with: npm run any:baseline',
    );
  });

  it('the baseline declares a total', () => {
    assert.ok(baselineRead.ok, `no readable baseline at ${key(BASELINE)} — npm run any:baseline`);
    assert.ok(
      budgetTotal >= 0,
      `the baseline declares total=${String(baselineRead.value?.total ?? null)} — it must be a non-negative number`,
    );
  });

  it("the baseline's total equals the sum of its per-file budgets", () => {
    assert.ok(baselineRead.ok, `no readable baseline at ${key(BASELINE)} — npm run any:baseline`);
    let sum = 0;
    for (const value of Object.values(budgets)) sum += value;
    assert.strictEqual(
      sum,
      budgetTotal,
      `sum=${sum} total=${budgetTotal} — a hand-edited baseline must not be able to widen itself`,
    );
  });

  // A file that disappears from the tree must not take its debt with it:
  // renaming or splitting a module is exactly the moment the ceiling would
  // silently rise, and a budget entry nobody can match is a dead entry.
  it('every file in the baseline is still on disk', () => {
    assert.ok(baselineRead.ok, `no readable baseline at ${key(BASELINE)} — npm run any:baseline`);
    /** @type {string[]} */
    const gone = [];
    for (const name of Object.keys(budgets)) if (!actual.has(name)) gone.push(name);
    assert.deepStrictEqual(
      gone,
      [],
      `no longer scanned: ${gone.join(', ')} — regenerate the baseline (npm run any:baseline)`,
    );
  });

  it('every scanned file is within its budget', () => {
    assert.ok(baselineRead.ok, `no readable baseline at ${key(BASELINE)} — npm run any:baseline`);
    assert.deepStrictEqual(
      over,
      [],
      `${over.length} file(s) over budget: ${over.join('; ')}\n` +
        'Fix it by typing the new occurrence (the preferred answer), or spend budget on purpose\n' +
        'and let the diff say so: npm run any:baseline\n' +
        'Do NOT raise the ceiling to land an unrelated change: the number in that file is the only\n' +
        'thing standing between "the glue stays greppable" (the tsconfig trade-off) and "nobody knows\n' +
        'how much there is".',
    );
  });

  // One test per offending file, so CI points at the file that moved rather
  // than at a list the reader has to parse.
  for (const [name, info] of actual) {
    const budget = budgets[name] ?? 0;
    if (info.count <= budget) continue;
    it(`${name} is within its budget`, () => {
      assert.ok(
        info.count <= budget,
        `${info.count} > ${budget}${info.sample.length ? ` — e.g. ${info.sample.join(' | ')}` : ''}`,
      );
    });
  }

  it(`the total is within budget (${total} / ${budgetTotal === -1 ? '?' : budgetTotal})`, () => {
    assert.ok(baselineRead.ok, `no readable baseline at ${key(BASELINE)} — npm run any:baseline`);
    assert.ok(
      total <= budgetTotal,
      `total went up by ${total - budgetTotal} (${total} now, ${budgetTotal} allowed) — ` +
        'spend the budget on purpose with: npm run any:baseline',
    );
  });
});
