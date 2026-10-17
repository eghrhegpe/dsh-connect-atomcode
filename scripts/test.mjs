#!/usr/bin/env node
/**
 * Offline test runner — auto-discovers every `test/*.test.mjs` and runs each one
 * as its OWN `node --test` process, then prints a per-suite table.
 *
 * Why a runner instead of just `node --test test/`:
 *
 *  1. The two LIVE suites (`*-live.test.mjs`) live in the same directory and must
 *     NOT join the offline gate — they touch the local daemon, and one of them is
 *     opt-in behind `ATOMCODE_LIVE_TURNS=1`. A directory glob would sweep them in.
 *  2. Serial execution is retained, and the reason is TIMING — not the build.
 *     Several suites mount against hardcoded "nothing is listening here" ports
 *     (`test/protocol.test.mjs` and `test/review.test.mjs` both use 45995), and
 *     one assertion sits inside an absolute deadline (`test/stats-route.test.mjs`
 *     waits 1600ms for a 1s start budget). Running files in parallel would trade
 *     that known serial cost for load-dependent flakes. An earlier version of
 *     this note claimed `build-gate.test.mjs` rewrites `lib/` in place — it does
 *     not: `test/build-gate.test.mjs` overrides `outDir` and builds into
 *     `mkdtemp`, only READING the committed artifacts. Serialization outlived the
 *     reason that was written under it.
 *  3. GROUPING. Node's runner emits ONE aggregate summary for the whole directory,
 *     and its default reporter is TAP whenever stdout is not a TTY — which is
 *     exactly the CI case. A red CI run was therefore an ungrouped wall of
 *     `ok`/`not ok` lines with nothing saying which suite owned a failure. One
 *     process per file lets this runner: print a `── test/x.test.mjs` header,
 *     wrap each suite in a GitHub Actions `::group::` block (collapsible in the
 *     run log), report pass/fail/seconds PER SUITE, and keep going after a suite
 *     that wedges or kills its process instead of losing the rest of the run.
 *     It also matches how AGENTS.md wants counts read: "只看自己域的增减" — each
 *     suite now has its own `ℹ tests` line under its own header.
 *  4. `--coverage` runs the whole set in ONE process with Node's built-in
 *     `--experimental-test-coverage` (no dependency) so the report is a single
 *     aggregate table: `npm run coverage`.
 *  5. Every suite has a WALL-CLOCK ceiling (`ATOMCODE_SUITE_TIMEOUT_MS`, default
 *     300s). At the ceiling the child is SIGKILLed and the suite is reported as
 *     `TIMEOUT` in the same table as every other failure — see SUITE_TIMEOUT_MS
 *     below for why a hang detector is not just tidiness.
 *
 * The child's stdio is INHERITED, never piped: output streams live (a suite can
 * hold a port for seconds), and piped child stdio is what a confined sandbox
 * denies. Nothing here needs to read the child's output — per-suite attribution
 * comes from its exit status.
 */
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');
const withCoverage = process.argv.includes('--coverage');
/** GitHub Actions turns `::group::` lines into collapsible log blocks. */
const inCI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
/**
 * Wall-clock ceiling for ONE suite. Nothing is more expensive to diagnose than a
 * suite that never returns: before this existed, a wedged suite (a port, a
 * promise, a stream nobody ends) hung `npm test` until GitHub killed the job at
 * its 6-hour cap — no failing suite name, no log tail. At the ceiling the child
 * is SIGKILLed and reported as `TIMEOUT`, which is a NAMED failure in the same
 * table as everything else. Generous on purpose (the slowest suite is ~25s here,
 * ~1min in CI): this is a hang detector, not a performance gate.
 */
const SUITE_TIMEOUT_MS = Number(process.env.ATOMCODE_SUITE_TIMEOUT_MS || 300_000);

/**
 * A ceiling in seconds, without pretending 1500ms is "2s": the per-suite table
 * prints the elapsed time next to this reason, and `TIMEOUT after 2s` beside a
 * `1.5s` column reads as if the runner waited longer than it did.
 */
const asSecs = (ms) => `${ms % 1000 === 0 ? ms / 1000 : (ms / 1000).toFixed(1)}s`;

const all = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();
const files = all.filter((f) => !f.includes('-live')).map((f) => join(testDir, f));
const liveSkipped = all.filter((f) => f.includes('-live'));

if (files.length === 0) {
  console.error('test: no offline suites found in test/');
  process.exit(1);
}

const rel = (file) => relative(root, file).split('\\').join('/');

// Say out loud what did NOT run. A silent filter cannot be told apart from
// "everything ran" in a log, and this repo has already lost a suite that existed
// but ran nowhere — the same failure in the other direction.
for (const suite of liveSkipped) {
  console.log(`[skip] test/${suite} — live suite, excluded from the offline gate (run: npm run test:live)`);
}

if (withCoverage) {
  // One process for the whole set: coverage is only meaningful aggregated, and a
  // per-file report would print 20+ partial tables whose totals look like truth.
  //
  // This is NOT the gate, and it is a WEAKER execution model than the loop below:
  // one process means node's default per-file concurrency, so the `lib/review.js`
  // spawner singleton, the hardcoded dead ports and the "this port must be free"
  // assertions can cross suites. The numbers stay usable; a failure HERE is not
  // evidence the gate would fail, and a green gate says nothing about coverage.
  console.log(`▶ ${files.length} suites, one process (coverage must aggregate)\n`);
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=spec', '--experimental-test-coverage', ...files],
    // One process means one budget for all of them: a per-suite ceiling is
    // meaningless here, so the aggregate ceiling is the same number scaled by the
    // suite count. Still bounded, which is the point.
    { stdio: 'inherit', timeout: SUITE_TIMEOUT_MS * files.length, killSignal: 'SIGKILL' },
  );
  if (result.error?.code === 'ETIMEDOUT') {
    console.error(`\ncoverage run TIMEOUT after ${SUITE_TIMEOUT_MS * files.length}ms (killed)`);
  }
  process.exit(result.status ?? 1);
}

const rows = [];
for (const file of files) {
  const name = rel(file);
  console.log(inCI ? `::group::${name}` : `\n── ${name}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], {
    stdio: 'inherit',
    timeout: SUITE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const ms = Date.now() - started;
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (inCI) console.log('::endgroup::');
  rows.push({
    name,
    ms,
    status: result.status,
    ok: result.status === 0 && !timedOut,
    how: timedOut
      ? `TIMEOUT after ${asSecs(SUITE_TIMEOUT_MS)} (SIGKILLed)`
      : result.signal
        ? `signal ${result.signal}`
        : `exit ${result.status}`,
  });
}

const width = Math.max(...rows.map((r) => r.name.length));
const failed = rows.filter((r) => !r.ok);
console.log('\n── per-suite ─────────────────────────────────────────────');
for (const r of rows) {
  console.log(
    `${r.ok ? '✔' : '✖'} ${r.name.padEnd(width)}  ${(r.ms / 1000).toFixed(1).padStart(6)}s` +
      (r.ok ? '' : `  ${r.how}`),
  );
}
console.log(
  `\n${rows.length - failed.length}/${rows.length} suites passed` +
    (liveSkipped.length ? `, ${liveSkipped.length} live suite(s) skipped` : '') +
    (failed.length ? ` — FAILED: ${failed.map((r) => r.name).join(', ')}` : ''),
);

// Keep the old runner's guarantee: no failure (and no missing suite) exits 0.
process.exit(failed.length ? 1 : 0);
