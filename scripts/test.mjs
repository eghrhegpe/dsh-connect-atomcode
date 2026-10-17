#!/usr/bin/env node
/**
 * Offline test runner — auto-discovers every `test/*.test.mjs` and runs each one
 * as its OWN `node --test` process, in PARALLEL by default, then prints a
 * per-suite table.
 *
 * Why a runner instead of just `node --test test/`:
 *
 *  1. The two LIVE suites (`*-live.test.mjs`) live in the same directory and must
 *     NOT join the offline gate — they touch the local daemon, and one of them is
 *     opt-in behind `ATOMCODE_LIVE_TURNS=1`. A directory glob would sweep them in.
 *  2. PARALLEL by default — and the history of this line explains why it used to
 *     be serial: two suites independently picked THE SAME hardcoded "nothing is
 *     listening here" port, so any interleaving risked one suite's fake daemon
 *     answering another suite's request — a cross-suite coupling, not a
 *     load-dependent flake. That was fixed at the ROOT by `test/dead-port.mjs`:
 *     every sentinel is one unique offset from one base, the whole band parked
 *     BELOW the OS dynamic port ranges so a concurrent `listen(0)` can never be
 *     handed a sentinel, and uniqueness/no-literals is pinned by
 *     `test/dead-port.test.mjs`. Serial survives only as an escape hatch:
 *     `ATOMCODE_TEST_SERIAL=1` restores the old streaming one-at-a-time loop,
 *     and `ATOMCODE_TEST_CONCURRENCY=<n>` sizes the pool (default: cores − 1,
 *     capped at 6 — past that the table measures scheduler noise, not CPU).
 *     (An earlier version of this note cited two MORE serial reasons that were
 *     already disproven: a fixed 1600ms sleep in `test/stats-route.test.mjs` —
 *     now a `waitFor` poll — and "build-gate rebuilds `lib/` in place" — it
 *     overrides `outDir` into `mkdtemp` and only READS the committed artifacts.)
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
 *     In PARALLEL mode each suite's output is captured to a TEMP FILE and
 *     printed as one whole block when that suite finishes: concurrent children
 *     streaming into one stdout would interleave mid-line and destroy the
 *     grouping. A file fd — not a pipe — is deliberate twice over: piped child
 *     stdio is what a confined sandbox denies, and the fd costs nothing extra.
 *     The trade is that parallel mode shows NOTHING until a suite completes;
 *     live streaming is what `ATOMCODE_TEST_SERIAL=1` is for.
 *  4. `--coverage` runs the whole set in ONE process with Node's built-in
 *     `--experimental-test-coverage` (no dependency) so the report is a single
 *     aggregate table: `npm run coverage`.
 *  5. Every suite has a WALL-CLOCK ceiling (`ATOMCODE_SUITE_TIMEOUT_MS`, default
 *     300s). At the ceiling the child is SIGKILLed and the suite is reported as
 *     `TIMEOUT` in the same table as every other failure — see SUITE_TIMEOUT_MS
 *     below for why a hang detector is not just tidiness. Serial mode gets it
 *     from `spawnSync({ timeout })`; parallel mode from a per-child timer,
 *     because `spawn` has no such option.
 *  6. Each suite child runs with `--test-force-exit`, because suites mount the
 *     plugin and never dispose it: without the flag a suite pays for its own
 *     intervals after the last assertion (measured 9.5s of 14.5s on
 *     `test/stats-route.test.mjs`). See the comment at SUITE_FLAGS.
 */
import { readdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { availableParallelism, cpus, tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');
const withCoverage = process.argv.includes('--coverage');
/** GitHub Actions turns `::group::` lines into collapsible log blocks. */
const inCI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
/**
 * Wall-clock ceiling for ONE suite. Nothing is more expensive to diagnose than a
 * suite that never returns: before this existed, a wedged suite (a port, a
 * promise, a stream nobody ended) hung `npm test` until GitHub killed the job at
 * its 6-hour cap — no failing suite name, no log tail. At the ceiling the child
 * is SIGKILLed and reported as `TIMEOUT`, which is a NAMED failure in the same
 * table as everything else. Generous on purpose (the slowest suite is ~25s here,
 * ~1min in CI): this is a hang detector, not a performance gate.
 */
const DEFAULT_SUITE_TIMEOUT_MS = 300_000;
const requestedSuiteTimeout = Number(process.env.ATOMCODE_SUITE_TIMEOUT_MS ?? DEFAULT_SUITE_TIMEOUT_MS);
// A bad value must not DISABLE the detector. `Number('300s')` is NaN and
// `Number('0')` is 0, and `spawnSync` reads both as "no timeout" — i.e. the one
// moment someone reaches for this knob (a suite they think needs longer) is the
// moment the hang detector silently stops existing. Say so, then use the default.
if (!Number.isFinite(requestedSuiteTimeout) || requestedSuiteTimeout <= 0) {
  console.warn(
    `⚠ ATOMCODE_SUITE_TIMEOUT_MS=${process.env.ATOMCODE_SUITE_TIMEOUT_MS} is not a positive number of milliseconds` +
      ` — using ${DEFAULT_SUITE_TIMEOUT_MS} (a value spawnSync cannot read would mean NO timeout at all)`,
  );
}
const SUITE_TIMEOUT_MS =
  Number.isFinite(requestedSuiteTimeout) && requestedSuiteTimeout > 0
    ? requestedSuiteTimeout
    : DEFAULT_SUITE_TIMEOUT_MS;

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
  // `--test-concurrency=1` is NOT optional here. One process is one address
  // space, so without it node runs the files concurrently and they stop being
  // independent: `lib/review.js` holds the spawner singleton, two `build-gate`
  // runs would drive tsdown at the same time, and every mount would share module
  // state that the suites assume is theirs alone. (The port collision that used
  // to headline this list is dead — sentinels are per-site since
  // `test/dead-port.mjs` — but the reasons that remain are MODULE-STATE reasons,
  // not port reasons, so coverage keeps its own serial shape.) Measured
  // 2026-10-17: without the flag the run exited 1 (build-gate red) and `client.js`
  // reported 12.82 % funcs on one run and 30.19 % on the next — the same tree,
  // i.e. the numbers were an artifact of the schedule, not of the tests.
  //
  // This is still NOT the gate, and still a different execution model than the
  // loop below (serial in one process, not one process per suite): a failure
  // HERE is not evidence the gate would fail, and a green gate says nothing
  // about coverage.
  //
  // The `client.js` row is not a number about this codebase at all. The client
  // suites load the bundle under a cache-busting URL per mount (that is how they get
  // a fresh module instance), so V8 sees many scripts sharing one path and node
  // collapses them by path: the row reflects ONE surviving instance, not the tests.
  // It is worse than "understated" — it can be actively false. Counter-example
  // measured 2026-10-17: the render suite's own chip cases render `QuotaChip`
  // (open / closed / Escape / degraded, with assertions on the portal's `role`,
  // bar width and fact count) and pass, yet the row lists `client.js:924-981` and
  // `992-1000` — the bodies of `QuotaChip` and `QuotaChipDegraded` — as UNCOVERED.
  // The surviving instance was a panel-only mount, which executes the factory but
  // never renders the dock component. So line %, branch % and funcs % are all the
  // survivor's numbers; 15.91 % vs 30.19 % on one tree was the same cause.
  // The host `lib/*.js` rows are stable (loaded once, by static import).
  // Do NOT triage render-side gaps with this row: read the assertions in
  // test/client-render.test.mjs instead. A truthful client number needs the
  // harness to import the bundle once per process, which the lifecycle cases
  // deliberately do not (they want a pristine module-level `statsCache`).
  console.log(`▶ ${files.length} suites, one process, serial (coverage must aggregate)\n`);
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=spec', '--test-concurrency=1', '--experimental-test-coverage', ...files],
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

/**
 * `--test-force-exit`: every suite MOUNTS the plugin and never disposes it, so
 * its quota-refresh interval (and the auto-start poll behind it) keeps the event
 * loop alive long after the last assertion. Measured 2026-10-17 on
 * `test/stats-route.test.mjs`: 14.5s of wall clock, 9.5s of it drain AFTER the
 * final test (5.0s with this flag, 4.1s of which is the auto-start budgets).
 * That drain is the harness's own shape rather than a leak for the gate to wait
 * on — a mounted plugin's timers are supposed to live for the mount's lifetime —
 * and the flag cannot hide a failure, since each suite is judged by the exit
 * status of a process whose tests have already run. Deliberately NOT used on the
 * coverage path above, where the reporter still has to write its table.
 */
const SUITE_FLAGS = ['--test', '--test-reporter=spec', '--test-force-exit'];

/** Serial mode: the original loop, stdio INHERITED so output streams live. */
function runSerial(file) {
  const name = rel(file);
  console.log(inCI ? `::group::${name}` : `\n── ${name}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [...SUITE_FLAGS, file], {
    stdio: 'inherit',
    timeout: SUITE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const ms = Date.now() - started;
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (inCI) console.log('::endgroup::');
  return {
    name,
    ms,
    ok: result.status === 0 && !timedOut,
    how: timedOut
      ? `TIMEOUT after ${asSecs(SUITE_TIMEOUT_MS)} (SIGKILLed)`
      : result.signal
        ? `signal ${result.signal}`
        : `exit ${result.status}`,
  };
}

/**
 * Parallel mode: child stdio goes to a per-suite temp FILE (an fd, never a
 * pipe), and the whole block prints — with its `::group::` wrapper intact —
 * when the child closes. `spawn` has no `timeout` option, so the wall-clock
 * ceiling is a manual timer that SIGKILLs; `timedOut` then outranks the exit
 * code because on Windows a killed child settles as code 1 without a signal.
 */
function runParallel(file, index, runDir) {
  const name = rel(file);
  return new Promise((resolve) => {
    const logPath = join(runDir, `${index}.log`);
    const fd = openSync(logPath, 'w');
    const started = Date.now();
    let timedOut = false;
    let done = false;
    const child = spawn(process.execPath, [...SUITE_FLAGS, file], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SUITE_TIMEOUT_MS);
    const finish = (row) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { closeSync(fd); } catch { /* already closed by the OS */ }
      let out = '';
      try { out = readFileSync(logPath, 'utf8'); } catch { /* nothing was written */ }
      rmSync(logPath, { force: true });
      const body = out.trim() || '(no output captured)';
      if (inCI) {
        console.log(`::group::${name}`);
        console.log(body);
        console.log('::endgroup::');
      } else {
        console.log(`\n── ${name}\n${body}`);
      }
      resolve(row);
    };
    child.once('error', (err) =>
      finish({ name, ms: Date.now() - started, ok: false, how: `spawn error: ${err.code || err.message}` }),
    );
    child.once('close', (code, signal) => {
      const ms = Date.now() - started;
      finish({
        name,
        ms,
        ok: code === 0 && !timedOut,
        how: timedOut
          ? `TIMEOUT after ${asSecs(SUITE_TIMEOUT_MS)} (SIGKILLed)`
          : signal
            ? `signal ${signal}`
            : `exit ${code}`,
      });
    });
  });
}

const serialMode = process.env.ATOMCODE_TEST_SERIAL === '1';
const cores = (availableParallelism ? availableParallelism() : cpus().length) || 2;
const DEFAULT_CAP = Math.max(1, Math.min(cores - 1, 6));
const requestedCap = Number(process.env.ATOMCODE_TEST_CONCURRENCY ?? DEFAULT_CAP);
// Same discipline as ATOMCODE_SUITE_TIMEOUT_MS above: a value Number() cannot
// read must not mean "no limit" or "no pool" — say so, then use the default.
if (!Number.isInteger(requestedCap) || requestedCap <= 0) {
  console.warn(
    `⚠ ATOMCODE_TEST_CONCURRENCY=${process.env.ATOMCODE_TEST_CONCURRENCY} is not a positive integer` +
      ` — using ${DEFAULT_CAP}`,
  );
}
const cap = Number.isInteger(requestedCap) && requestedCap > 0 ? requestedCap : DEFAULT_CAP;

const rows = [];
if (serialMode) {
  console.log(`▶ ${files.length} suites, serial (ATOMCODE_TEST_SERIAL=1: live output, nothing interleaved)`);
  for (const file of files) rows.push(runSerial(file));
} else {
  const runDir = mkdtempSync(join(tmpdir(), 'atomcode-suites-'));
  console.log(
    `▶ ${files.length} suites, parallel (cap ${cap}) — each suite's output prints whole when it finishes;` +
      ' for live streaming: ATOMCODE_TEST_SERIAL=1',
  );
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      rows[i] = await runParallel(files[i], i, runDir);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, files.length) }, worker));
  rmSync(runDir, { recursive: true, force: true });
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
