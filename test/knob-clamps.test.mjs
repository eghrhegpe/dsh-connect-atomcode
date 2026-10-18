/**
 * knob-clamps.test.mjs — a knob whose limit lives in a description has no
 * limit.
 *
 * Three wall-clock/round knobs once promised caps in prose while the code passed
 * any magnitude through:
 *
 *   - `timeout_secs: 1e9` became a 1e12 ms wire budget, cut only by the host's
 *     own guard — the caller got "已取消" where the description promised a
 *     timeout;
 *   - `max_rounds: 1e9` disarmed the round fuse entirely, leaving the 30min
 *     wall clock as the only thing between an unattended turn and the user's
 *     quota;
 *   - `max_duration_secs` above ~1740 pushed the process backstop past the
 *     host guard, so the fuse failed INVISIBLE instead of long.
 *
 * Two remain. The third went away with the knob that carried it: a review is an
 * ask turn now, `review_max_duration_secs` was parsed but read by nothing, and
 * it was removed rather than kept as a knob that looks live and changes nothing
 * (docs/DECISIONS.md).
 *
 * The clamps now live in code, next to the defaults they bound, so these tests
 * pin the policy itself: `0` stays the deliberate "no fuse" WORD and is never
 * clamped into a number, and no legitimate budget is rewritten downward.
 *
 * The second half pins `readDaemonIdentity` — the fingerprint the session map
 * judges restarts by. It must be stable for one daemon, move when the daemon
 * changes, and answer "cannot judge" (null) rather than guessing when the file
 * is absent — a wrong fingerprint kills live side conversations.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_TOOL_TIMEOUT_MS,
  HOST_TOOL_TIMEOUT_SECS,
  MAX_ROUNDS_CEILING,
  clampMaxRounds,
  resolveMaxRounds,
} from '../lib/config.js';
import { readDaemonIdentity } from '../lib/daemon.js';

describe('the round-count clamp — a fuse cannot be switched off by inflating the number', () => {
  it('0 is the deliberate word and passes through untouched', () => {
    // The one legitimate way to hand governance back to the daemon/CLI.
    // Clamping it into a number would turn a word into a lie.
    assert.equal(resolveMaxRounds(0, 25), 0);
    assert.equal(clampMaxRounds(0), 0);
  });

  it('a real budget is never rewritten downward', () => {
    assert.equal(resolveMaxRounds(25, 35), 25);
    assert.equal(resolveMaxRounds(999, 35), 999);
    assert.equal(resolveMaxRounds(1000, 35), 1000, 'the ceiling itself is a legal budget');
  });

  it('an inflated magnitude is clamped, not honoured', () => {
    assert.equal(resolveMaxRounds(1e9, 25), MAX_ROUNDS_CEILING);
    assert.equal(resolveMaxRounds(1001, 25), MAX_ROUNDS_CEILING);
    assert.equal(resolveMaxRounds(Number.MAX_SAFE_INTEGER, 25), MAX_ROUNDS_CEILING);
    assert.equal(clampMaxRounds(5000), MAX_ROUNDS_CEILING);
  });

  it('the configured default is clamped too — the panel must not display a budget the code will not honour', () => {
    // When the clamp lived only on the argument path, an inflated
    // `ask_max_rounds` reached the panel unclamped.
    assert.equal(resolveMaxRounds(undefined, 1e9), MAX_ROUNDS_CEILING);
    assert.equal(resolveMaxRounds('nonsense', 1e9), MAX_ROUNDS_CEILING);
  });

  it('values that cannot be a round count fall back, as they always did', () => {
    assert.equal(resolveMaxRounds(undefined, 25), 25);
    assert.equal(resolveMaxRounds(-5, 25), 25);
    assert.equal(resolveMaxRounds('12', 25), 25, 'a string is not a number');
    assert.equal(resolveMaxRounds(12.7, 25), 12, 'a fractional budget floors, it does not fall back');
  });

  it('the ceiling is far past any legitimate turn, and named', () => {
    assert.equal(MAX_ROUNDS_CEILING, 1000);
    assert.ok(MAX_ROUNDS_CEILING > 25, 'the ask default must sit well under the ceiling');
  });
});

describe('the host timeout — the one wall-clock number left', () => {
  it('is one number, in both units', () => {
    assert.equal(HOST_TOOL_TIMEOUT_MS, 30 * 60 * 1000);
    assert.equal(HOST_TOOL_TIMEOUT_SECS, 1800);
  });
});

describe('readDaemonIdentity — the restart signal the session map judges by', () => {
  /** A fake `~` holding one `.atomcode/daemon-<port>.json`. */
  function fakeHome(daemon) {
    const home = mkdtempSync(join(tmpdir(), 'atomcode-identity-'));
    mkdirSync(join(home, '.atomcode'), { recursive: true });
    if (daemon) {
      writeFileSync(join(home, '.atomcode', `daemon-${daemon.port}.json`), JSON.stringify(daemon), 'utf8');
    }
    return home;
  }

  it('is stable for one daemon and moves when the daemon changes', () => {
    const home = fakeHome({ pid: 4242, port: 13459, token: 't1' });
    try {
      const first = readDaemonIdentity(13459, home);
      assert.equal(first, readDaemonIdentity(13459, home), 'one daemon, one fingerprint');
      writeFileSync(
        join(home, '.atomcode', 'daemon-13459.json'),
        JSON.stringify({ pid: 4243, port: 13459, token: 't2' }),
        'utf8',
      );
      assert.notEqual(readDaemonIdentity(13459, home), first, 'a restarted daemon must look different');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('moves on a token change even when the pid is recycled', () => {
    // The reason the token is hashed in: a just-freed pid is the one most
    // likely to be reused, and pid alone would call the new daemon the old one.
    const home = fakeHome({ pid: 4242, port: 13459, token: 't1' });
    try {
      const before = readDaemonIdentity(13459, home);
      writeFileSync(
        join(home, '.atomcode', 'daemon-13459.json'),
        JSON.stringify({ pid: 4242, port: 13459, token: 't2' }),
        'utf8',
      );
      assert.notEqual(readDaemonIdentity(13459, home), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('separates two daemons on two ports', () => {
    const home = fakeHome({ pid: 100, port: 1111, token: 't' });
    try {
      writeFileSync(join(home, '.atomcode', 'daemon-2222.json'), JSON.stringify({ pid: 100, port: 2222, token: 't' }), 'utf8');
      assert.notEqual(readDaemonIdentity(1111, home), readDaemonIdentity(2222, home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('answers null — never a guess — when the identity cannot be read', () => {
    // A `--no-auth` daemon writes no file; a missing/corrupt file must read as
    // "cannot judge", because callers treat null as unknown and any other
    // answer as evidence.
    const home = fakeHome(null);
    try {
      assert.equal(readDaemonIdentity(13459, home), null, 'no file at all');
      writeFileSync(join(home, '.atomcode', 'daemon-13459.json'), 'not json', 'utf8');
      assert.equal(readDaemonIdentity(13459, home), null, 'a corrupt file');
      writeFileSync(join(home, '.atomcode', 'daemon-13459.json'), JSON.stringify({ port: 13459 }), 'utf8');
      assert.equal(readDaemonIdentity(13459, home), null, 'no pid means no identity');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('stores no secret — the fingerprint is a hash, and a short one', () => {
    const home = fakeHome({ pid: 4242, port: 13459, token: '9eaae6f32c60450696cd782c78108a5a' });
    try {
      const identity = readDaemonIdentity(13459, home);
      assert.ok(!identity.includes('9eaae6f32c60450696cdcd782c78108a5a'.slice(0, 8)), 'no token material in the fingerprint');
      assert.ok(identity.length <= 32, `a fingerprint, not a payload (got ${identity.length} chars)`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
