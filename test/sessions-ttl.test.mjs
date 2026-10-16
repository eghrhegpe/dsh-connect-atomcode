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
