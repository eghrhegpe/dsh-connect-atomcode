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
});

