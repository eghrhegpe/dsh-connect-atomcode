/**
 * usage-store.test.mjs — the durable side of the panel's 「工具调用统计」 card.
 *
 * `stats.ask` counters used to live only in host memory: a reload or restart
 * reset them, so the panel's "ask 累计 tokens" read as a per-session curiosity.
 * `usage.json` persists them. These tests pin the parts that would silently
 * corrupt the count if they regressed:
 *
 *   - a missing file reads as zeroes (first run, nothing lost);
 *   - write→read round-trips the five counters exactly;
 *   - a corrupt file is preserved aside AND named via onError (红线 3), never
 *     silently replaced by zeroes with no trace;
 *   - junk values are clamped to 0, never coerced or echoed;
 *   - a document written by a NEWER build is read as zeroes and never
 *     overwritten (the next write must still refuse to clobber it).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageStore, emptyAskUsage, USAGE_FILE_VERSION } from '../lib/usage-store.js';

/** A throwaway state file, and a store over it, per test. */
function freshStore(initial, version = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'atomcode-usage-'));
  const path = join(dir, 'usage.json');
  if (initial !== null) writeFileSync(path, JSON.stringify(initial === 'doc' ? { version, ask: {} } : initial), 'utf8');
  const errors = [];
  const store = createUsageStore(path, (error) => errors.push(error));
  return { store, path, dir, errors };
}

describe('usage-store — the panel 累计 survives a restart', () => {
  it('reads zeroes for a file that does not exist, with no error', () => {
    const { store, errors } = freshStore(null);
    assert.deepEqual(store.read(), emptyAskUsage());
    assert.deepEqual(errors, [], 'a missing file is a normal first run, not a failure');
  });

  it('round-trips the five counters exactly', () => {
    const { store, path } = freshStore(null);
    const counters = { calls: 7, ok: 5, err: 2, msTotal: 123456, tokens: 98765 };
    store.write(counters);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(onDisk.version, USAGE_FILE_VERSION);
    assert.deepEqual(onDisk.ask, counters);
    // A fresh store over the SAME file must see them — this is the restart case.
    assert.deepEqual(createUsageStore(path).read(), counters);
  });

  it('clamps junk values to zero instead of coercing or echoing them', () => {
    const { store, errors } = freshStore(
      { version: 1, ask: { calls: '12', ok: -3, err: NaN, msTotal: null, tokens: Infinity } },
    );
    const got = store.read();
    assert.equal(got.calls, 0, 'a string count is not a number the renderer should coerce');
    assert.equal(got.ok, 0, 'a negative count is not something the user spent');
    assert.equal(got.tokens, 0, 'a non-finite token count is dropped, not printed');
    // No degradation is reported: the document was fine, only its values were junk.
    assert.deepEqual(errors, []);
  });

  it('preserves a corrupt file aside and NAMES the reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-usage-'));
    const path = join(dir, 'usage.json');
    // RAW bytes, not JSON.stringify — the point is a document that is not JSON.
    writeFileSync(path, '{not json', 'utf8');
    const errors = [];
    const store = createUsageStore(path, (error) => errors.push(error));
    assert.deepEqual(store.read(), emptyAskUsage());
    assert.match(errors[0], /corrupt/, 'a corrupt document must be named, not silently zeroed');
    // The bytes are still on disk under a .corrupt- name, so the loss is inspectable.
    assert.ok(errors[0].indexOf('preserved aside') >= 0);
    // The destination itself is untouched until the next successful write.
    assert.throws(() => JSON.parse(readFileSync(path, 'utf8')));
  });

  it('never overwrites a document written by a newer build', () => {
    const { store, path, errors } = freshStore(
      { version: USAGE_FILE_VERSION + 1, ask: { calls: 99, ok: 99, err: 0, msTotal: 1, tokens: 1 } },
    );
    assert.deepEqual(store.read(), emptyAskUsage());
    assert.match(errors[0], /newer build/);
    // The write must also refuse, so the newer counts survive.
    store.write({ calls: 1, ok: 1, err: 0, msTotal: 1, tokens: 1 });
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(onDisk.version, USAGE_FILE_VERSION + 1);
    assert.equal(onDisk.ask.calls, 99);
  });

  it('reads a current-version document even when its ask block is absent', () => {
    const { store, errors } = freshStore('doc');
    assert.deepEqual(store.read(), emptyAskUsage());
    assert.deepEqual(errors, [], 'an empty ask block is "nothing yet", not a failure');
  });
});