/**
 * daemon-parse.test.mjs — Pure-function tests for daemon.js helpers.
 * No daemon or network required.
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_PORT,
  baseUrl,
  parseSseLine,
  defaultBinary,
  fallbackCandidates,
  pickFallback,
  spawnDaemon,
} from '../lib/daemon.js';

/**
 * Poll until `cond()` holds, or fail with a NAMED timeout. A fixed sleep is a
 * guess about how fast the machine is (these were 400/600ms) and turns a slow CI
 * runner into a red suite that says nothing; polling a condition the code really
 * produces is the same test with a margin it can state out loud.
 */
async function waitFor(cond, what, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

describe('daemon.js — pure helpers', () => {
  it('DEFAULT_PORT is 13459', () => {
    assert.equal(DEFAULT_PORT, 13459);
  });

  it('baseUrl forms correct localhost URL', () => {
    assert.equal(baseUrl(13459), 'http://127.0.0.1:13459');
    assert.equal(baseUrl(8080), 'http://127.0.0.1:8080');
  });

  it('parseSseLine parses data: JSON lines', () => {
    const ev = parseSseLine('data: {"type":"text","content":"hello"}');
    assert.notEqual(ev, undefined);
    assert.equal(ev.type, 'text');
    assert.equal(ev.content, 'hello');
  });

  it('parseSseLine returns undefined for non-data lines', () => {
    assert.equal(parseSseLine(': keepalive'), undefined);
    assert.equal(parseSseLine('event: message'), undefined);
    assert.equal(parseSseLine(''), undefined);
    assert.equal(parseSseLine('  '), undefined);
  });

  it('parseSseLine returns undefined for [DONE]', () => {
    assert.equal(parseSseLine('data: [DONE]'), undefined);
  });

  it('parseSseLine returns undefined for malformed JSON', () => {
    assert.equal(parseSseLine('data: {bad json}'), undefined);
  });

  it('defaultBinary returns atomcode.exe on win32', () => {
    assert.equal(defaultBinary('win32'), 'atomcode.exe');
  });

  it('defaultBinary returns atomcode on non-win32', () => {
    assert.equal(defaultBinary('linux'), 'atomcode');
    assert.equal(defaultBinary('darwin'), 'atomcode');
  });

  it('fallbackCandidates names the two macOS install roots, and only there', () => {
    // The table IS the contract, and it is a PURE platform table: the existence
    // check lives in `pickFallback`, not here. If it lived here, this assertion
    // would be machine-dependent — it would pass or fail on whether the
    // developer happens to have AtomCode at /opt/homebrew/bin.
    assert.deepEqual(fallbackCandidates('darwin'), ['/opt/homebrew/bin/atomcode', '/usr/local/bin/atomcode']);
    // Windows already gets a persistent PATH entry from the installer, so a
    // fallback list there would be guessing at a case that does not arise.
    assert.deepEqual(fallbackCandidates('win32'), []);
    assert.deepEqual(fallbackCandidates('linux'), []);
    // Both npm global-bin roots on macOS ARE these two directories (Homebrew's
    // node puts the prefix at /opt/homebrew or /usr/local), which is why
    // `npm prefix -g` needs no third entry here.
  });

  it('pickFallback takes the first candidate that exists, and gives up cleanly', () => {
    const table = fallbackCandidates('darwin');
    assert.equal(pickFallback(table, (p) => p === '/usr/local/bin/atomcode'), '/usr/local/bin/atomcode');
    assert.equal(pickFallback(table, (p) => p === '/opt/homebrew/bin/atomcode'), '/opt/homebrew/bin/atomcode');
    assert.equal(
      pickFallback(table, (p) => p === '/opt/homebrew/bin/atomcode' || p === '/usr/local/bin/atomcode'),
      '/opt/homebrew/bin/atomcode',
      'the list order is the preference order',
    );
    // Nothing installed is the ordinary case on a machine without AtomCode, and
    // it must be `''` — not `undefined`, which would reach `spawn()` as a target.
    assert.equal(pickFallback(table, () => false), '');
    assert.equal(pickFallback(fallbackCandidates('win32'), () => true), '');
  });

  it('parseSseLine handles empty data payload', () => {
    assert.equal(parseSseLine('data: '), undefined);
    assert.equal(parseSseLine('data:'), undefined);
  });

  it('parseSseLine handles tokens event', () => {
    const ev = parseSseLine('data: {"type":"tokens","prompt":100,"completion":50,"total":150}');
    assert.equal(ev.type, 'tokens');
    assert.equal(ev.total, 150);
  });

  it('parseSseLine handles done event', () => {
    const ev = parseSseLine('data: {"type":"done","tokens":123,"tool_calls":2,"session_id":"abc","stop_reason":"stopped"}');
    assert.equal(ev.type, 'done');
    assert.equal(ev.tokens, 123);
    assert.equal(ev.stop_reason, 'stopped');
  });
});

describe('daemon.js — spawnDaemon', () => {
  it('a missing binary is logged, never an unhandled error that kills the host', async () => {
    // Regression: Node reports ENOENT ASYNCHRONOUSLY on the child's 'error'
    // event, not as a throw from spawn(). With no listener, the EventEmitter
    // re-throws it as an uncaught exception — which took down the whole process
    // (verified) and would take down the DSH host, since auto_start defaults on.
    // If the guard regresses, THIS TEST PROCESS DIES rather than failing softly.
    const logs = [];
    const attempted = await spawnDaemon({
      binary: 'definitely-not-a-real-binary-xyz-123',
      log: (message) => logs.push(message),
    });
    assert.equal(attempted, true, 'the boolean means "a spawn was attempted", not "it succeeded"');
    // The 'error' event is async; poll for the log line instead of guessing how
    // long a loaded CI runner needs.
    await waitFor(
      () => logs.some((line) => /spawn failed/i.test(line)),
      'the async spawn failure to be reported through log()',
    );
    assert.ok(
      logs.some((line) => /spawn failed/i.test(line)),
      `the async spawn failure must be reported through log(); got ${JSON.stringify(logs)}`,
    );
  });

  it('survives a nonexistent working directory and reports it', async () => {
    // A bad cwd fails inside uv_spawn, so it arrives the same async way as a
    // missing binary. This asserts the REPORT, not just survival: the earlier
    // version's `assert.ok(Array.isArray(logs))` was a tautology that could only
    // fail by killing the process.
    //
    // The path is built from `os.tmpdir()` + a name that cannot exist, NOT a
    // Windows literal like `Z:\...`: on a machine that really has a Z: drive the
    // old fixture would name an EXISTING directory and the test would fail for
    // the wrong reason. Unique per run so a leftover directory cannot make it pass.
    const logs = [];
    await spawnDaemon({
      binary: process.execPath,
      workingDir: join(tmpdir(), `atomcode-no-such-cwd-${process.pid}-${Date.now()}`),
      log: (message) => logs.push(message),
    });
    await waitFor(
      () => logs.some((line) => /spawn failed/i.test(line)),
      'a bad cwd to be reported through log()',
    );
    assert.ok(
      logs.some((line) => /spawn failed/i.test(line)),
      `a bad cwd must be reported through log(); got ${JSON.stringify(logs)}`,
    );
  });

  it('a throwing log callback cannot re-arm the crash', async () => {
    // The guard uses typeof, not truthiness: a truthy non-function (or a logger
    // that throws) would otherwise throw inside the 'error' callback — itself an
    // uncaught exception, i.e. the original crash reintroduced.
    const attempted = await spawnDaemon({
      binary: 'definitely-not-a-real-binary-xyz-123',
      log: 'not-a-function',
    });
    assert.equal(attempted, true);
    // The only fixed sleep left in this file, and it stays one: this test passes
    // by NOT dying, so there is no condition to poll. The wait is the test —
    // long enough for an uncaught exception to take the process down.
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it('reports what it ran and the OS code, so the panel is not left guessing', async () => {
    // The diagnosis contract: the panel must be able to say WHICH executable
    // failed and WHY. A bare "spawn failed" log line cannot — the process log is
    // not on the panel, and "自动拉起失败" alone cannot tell "not installed" from
    // "installed but not executable".
    const attempts = [];
    await spawnDaemon({
      binary: 'definitely-not-a-real-binary-xyz-123',
      onAttempt: (attempt) => attempts.push(attempt),
    });
    await waitFor(() => attempts.length > 0, 'the spawn outcome to be reported');
    // One attempt, and a configured binary is never second-guessed: `config.binary`
    // / `ATOMCODE_BIN` is the user NAMING an executable, so quietly running a
    // different one would hide their typo behind a working daemon. The two
    // assertions are the same fact from both ends — "no second attempt" is what
    // makes the reported one the whole story.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(attempts.length, 1, `no fallback may be tried for a configured binary: ${JSON.stringify(attempts)}`);
    assert.equal(attempts[0].binary, 'definitely-not-a-real-binary-xyz-123');
    assert.equal(attempts[0].error, 'ENOENT', 'the OS code, not a sentence — the renderer words it');
    assert.notEqual(attempts[0].fallback, true, 'a configured binary is never a fallback');
  });

  it('a throwing onAttempt callback cannot re-arm the crash either', async () => {
    // Same shape as the throwing-`log` guard above and for the same reason: this
    // runs inside the 'error' callback, where a throw IS the uncaught exception
    // the whole function exists to prevent. A reporter is the host's own stats
    // writer, so "it threw" is the case that actually happens; the typeof guard
    // covers the truthy-non-function one on the way past.
    const seen = [];
    const attempted = await spawnDaemon({
      binary: 'definitely-not-a-real-binary-xyz-123',
      onAttempt: (attempt) => {
        seen.push(attempt);
        throw new Error('a reporter must not be able to kill its subject');
      },
    });
    assert.equal(attempted, true);
    // The reporter DID run (so this is the throwing case, not a skipped one) and
    // the process is still alive to say so. The sleep is the assertion for the
    // uncaught-exception half: there is no condition to poll.
    assert.equal(seen.length, 1, 'the callback ran once');
    assert.equal(seen[0].error, 'ENOENT');
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
});

