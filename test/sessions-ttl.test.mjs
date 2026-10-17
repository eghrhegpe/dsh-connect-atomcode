/**
 * sessions-ttl.test.mjs — a recorded side-conversation key must stop being
 * offered once it is too old to be alive.
 *
 * `updatedAt` was written on every `set()` and read NOWHERE, which left two
 * defects with one cause:
 *
 *   1. `sessions.json` only ever grew — a daemon restart or an idle exit left
 *      ids behind that no live session answers to, and nothing ever removed
 *      them (the only remover was a hand-edited file);
 *   2. `continue: true` kept replaying one of those ids and failing the same
 *      way. The recovery (`reset_session`) was named in the failure text only,
 *      i.e. AFTER the model had already spent a turn discovering it.
 *
 * These tests pin the three behaviours that close it:
 *   - an expired key is not returned, and is dropped on the way past;
 *   - `count()` counts what can actually be resumed, so the panel's 已跟踪会话
 *     cannot report dead ids as tracked lines;
 *   - an entry whose age is UNKNOWN is kept — expiry may cost convenience,
 *     never a conversation that is still alive.
 *
 * The second half pins the daemon-identity signal: the TTL is a backstop, and
 * the dominant way a side conversation dies — a daemon restart or an idle
 * exit — is invisible to a wall clock. An entry records WHICH daemon issued
 * it; an entry from a daemon that is no longer the one answering is dead
 * regardless of age. Unknown (no fingerprint, or no readable identity) never
 * means dead, exactly as with age.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore, DEFAULT_SESSION_TTL_MS } from '../lib/sessions.js';

const TTL = 60_000;
const STALE = Date.now() - TTL - 1_000;

/** A throwaway state file, and a store over it, per test. */
function freshStore(map = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atomcode-sessions-'));
  const path = join(dir, 'sessions.json');
  if (map !== null) writeFileSync(path, JSON.stringify(map), 'utf8');
  const store = createSessionStore(path, '', { ttlMs: TTL, ...options });
  return { store, path, dir };
}

const readMap = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('session entries expire — the map stops growing and stops lying', () => {
  it('an expired key is not resumed', () => {
    const { store, dir } = freshStore({ repo: { sessionId: 's1', updatedAt: STALE } });
    try {
      assert.equal(store.get('repo'), undefined, 'a key older than the TTL must not be offered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an expired key is dropped on the way past — the file stops accumulating dead ids', () => {
    // Empty at creation (so this exercises `get()`, not the creation-time
    // `prune()`): the entry is written afterwards, which is the shape a daemon
    // that exited between two calls actually produces.
    const { store, path, dir } = freshStore(null);
    try {
      writeFileSync(path, JSON.stringify({ repo: { sessionId: 's1', updatedAt: STALE } }), 'utf8');
      store.get('repo');
      assert.deepEqual(
        Object.keys(readMap(path)),
        [],
        'observing an expired key must remove it, or the file only ever grows',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fresh key is still resumed — expiry is not a blanket refusal', () => {
    const { store, dir } = freshStore();
    try {
      store.set('repo', 's1');
      assert.equal(store.get('repo'), 's1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('count() counts what can be resumed, not what is on disk', () => {
    const { store, path, dir } = freshStore(null);
    try {
      writeFileSync(
        path,
        JSON.stringify({
          live: { sessionId: 's1', updatedAt: Date.now() },
          dead: { sessionId: 's2', updatedAt: STALE },
        }),
        'utf8',
      );
      assert.equal(
        store.count(),
        1,
        'a dead id must not be reported as a tracked side conversation',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an entry with no updatedAt is KEPT — unknown age is not expired age', () => {
    // Data written before this field existed. Guessing "expired" would silently
    // end a conversation that may still be alive, which is the one failure mode
    // expiry is not allowed to introduce.
    const { store, dir } = freshStore({ legacy: { sessionId: 's1' } });
    try {
      assert.equal(store.get('legacy'), 's1');
      assert.equal(store.count(), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prune() at creation reaps what an earlier daemon left behind', () => {
    // The only reaping that happens without someone calling `continue` again —
    // a long-lived install must not have to wait for a click to shrink the file.
    const { store: first, path, dir } = freshStore();
    try {
      first.set('repo', 's1');
      const written = readMap(path);
      written.repo.updatedAt = STALE;
      writeFileSync(path, JSON.stringify(written), 'utf8');

      const second = createSessionStore(path, '', { ttlMs: TTL });
      assert.equal(second.count(), 0, 'the stale id must be gone after a restart');
      assert.deepEqual(Object.keys(readMap(path)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('oldestAgeMs reports the oldest LIVE key, and null when nothing is known', () => {
    const { store: empty, path, dir } = freshStore();
    try {
      assert.equal(empty.oldestAgeMs(), null, 'no keys: an unknown age must not print as 0');
      writeFileSync(
        path,
        JSON.stringify({
          fresh: { sessionId: 's1', updatedAt: Date.now() - 1_000 },
          older: { sessionId: 's2', updatedAt: Date.now() - 10_000 },
          dead: { sessionId: 's3', updatedAt: STALE },
        }),
        'utf8',
      );
      const age = empty.oldestAgeMs();
      assert.ok(age >= 10_000 && age < 60_000, `expected the oldest LIVE age, got ${age}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the default lifetime is a day — long enough to survive overnight, short enough to matter', () => {
    assert.equal(DEFAULT_SESSION_TTL_MS, 24 * 60 * 60 * 1000);
  });
});

describe('entries die with their daemon — a restart is not a wall-clock event', () => {
  const NOW_DAEMON = 'daemon-now';
  const OLD_DAEMON = 'daemon-gone';

  it('a key issued by a daemon that has since exited is not resumed, however young', () => {
    // The TTL's blind spot, made concrete: written a minute ago, from a daemon
    // that restarted thirty seconds ago. A 24h window keeps offering it and
    // every `continue` burns a turn failing on an id nothing answers to.
    const { store, dir } = freshStore(
      { repo: { sessionId: 's1', updatedAt: Date.now() - 60_000, daemon: OLD_DAEMON } },
      { daemonIdentity: () => NOW_DAEMON },
    );
    try {
      assert.equal(store.get('repo'), undefined, 'an id from a dead daemon must not be offered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a key from the daemon answering now is still resumed', () => {
    const { store, dir } = freshStore(
      { repo: { sessionId: 's1', updatedAt: Date.now(), daemon: NOW_DAEMON } },
      { daemonIdentity: () => NOW_DAEMON },
    );
    try {
      assert.equal(store.get('repo'), 's1');
      assert.equal(store.count(), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a dead-daemon key is dropped on the way past — the restart sweep is not only prune()', () => {
    const { store, path, dir } = freshStore(null, { daemonIdentity: () => NOW_DAEMON });
    try {
      writeFileSync(
        path,
        JSON.stringify({ repo: { sessionId: 's1', updatedAt: Date.now(), daemon: OLD_DAEMON } }),
        'utf8',
      );
      store.get('repo');
      assert.deepEqual(Object.keys(readMap(path)), [], 'a dead-daemon key must not survive being observed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prune() at creation reaps the previous daemon’s ids before the first poll', () => {
    // A host that starts against a NEW daemon: the sweep that used to wait for
    // someone to call `continue` now happens once, at store creation.
    const { store: first, path, dir } = freshStore(null, { daemonIdentity: () => OLD_DAEMON });
    try {
      first.set('repo', 's1');
      assert.ok(readMap(path).repo.daemon, 'set() must record which daemon issued the id');
      const second = createSessionStore(path, '', { ttlMs: TTL, daemonIdentity: () => NOW_DAEMON });
      assert.equal(second.count(), 0, 'the previous daemon’s id must be gone after the restart');
      assert.deepEqual(Object.keys(readMap(path)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an entry with NO daemon field survives a different daemon — unknown is not different', () => {
    // Data written before the field existed, or by a build that could not read
    // the identity file. Judging it dead would end a conversation on evidence
    // that does not exist — the same rule expiry follows for unknown age.
    const { store, dir } = freshStore(
      { legacy: { sessionId: 's1', updatedAt: Date.now() } },
      { daemonIdentity: () => NOW_DAEMON },
    );
    try {
      assert.equal(store.get('legacy'), 's1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreadable identity keeps every entry — "cannot judge" is not "different"', () => {
    // A `--no-auth` daemon writes no identity file; a daemon that is down right
    // now cannot be asked. Both must degrade to the TTL alone, never to a
    // blanket refusal that kills live side conversations.
    const { store, dir } = freshStore(
      { repo: { sessionId: 's1', updatedAt: Date.now(), daemon: 'daemon-something' } },
      { daemonIdentity: () => null },
    );
    try {
      assert.equal(store.get('repo'), 's1');
      assert.equal(store.count(), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a throwing identity probe degrades to "cannot judge", it does not break the turn', () => {
    const { store, dir } = freshStore(
      { repo: { sessionId: 's1', updatedAt: Date.now(), daemon: 'daemon-something' } },
      {
        daemonIdentity: () => {
          throw new Error('identity file exploded');
        },
      },
    );
    try {
      assert.equal(store.get('repo'), 's1', 'a broken probe must not take the store down with it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('set() without a readable identity omits the field — the entry ages on the TTL alone', () => {
    const { store, path, dir } = freshStore(null, { daemonIdentity: () => null });
    try {
      store.set('repo', 's1');
      assert.equal(readMap(path).repo.daemon, undefined, 'no identity read means no fingerprint claimed');
      assert.equal(store.get('repo'), 's1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('snapshot() answers both panel facts from one shape, dead-daemon keys excluded', () => {
    const { store, path, dir } = freshStore(null, { daemonIdentity: () => NOW_DAEMON });
    try {
      writeFileSync(
        path,
        JSON.stringify({
          live: { sessionId: 's1', updatedAt: Date.now() - 5_000, daemon: NOW_DAEMON },
          restart: { sessionId: 's2', updatedAt: Date.now() - 1_000, daemon: OLD_DAEMON },
          stale: { sessionId: 's3', updatedAt: STALE, daemon: NOW_DAEMON },
        }),
        'utf8',
      );
      const snap = store.snapshot();
      assert.equal(snap.tracked, 1, 'only the live key may be reported as tracked');
      assert.ok(snap.oldestAgeMs >= 5_000 && snap.oldestAgeMs < 60_000, `oldest LIVE age, got ${snap.oldestAgeMs}`);
      // The single-fact accessors must agree with the combined one — they are
      // the same predicate over the same read, and a second implementation is
      // how the two would drift.
      assert.equal(store.count(), snap.tracked);
      assert.equal(store.oldestAgeMs(), snap.oldestAgeMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no daemonIdentity configured (older callers) is the TTL-only store it always was', () => {
    const { store, dir } = freshStore({ repo: { sessionId: 's1', updatedAt: Date.now() } });
    try {
      assert.equal(store.get('repo'), 's1');
      assert.equal(store.count(), 1);
      assert.equal(store.snapshot().tracked, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
