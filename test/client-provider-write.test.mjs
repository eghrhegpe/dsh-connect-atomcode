/**
 * client-provider-write.test.mjs — a click on a model dropdown must MOVE the
 * dropdown, not bounce back to the old value.
 *
 * The bug: `reload` is `load()`, and `load()`'s first line commits the CACHED
 * snapshot while it is still fresh (within POLL_MS). So the click's own reload
 * re-rendered the panel from the pre-click snapshot, and because
 * `ProviderSelectRow`'s `<select>` is controlled (`value: model.value`), React
 * snapped the control back to the old pick and held it there until the next 5s
 * poll — a control that looks like it ignored the click, with no text anywhere
 * saying the write succeeded (the "已选 X" line was removed on purpose: only a
 * failure needs words).
 *
 * The write's own response already carries the accepted value; adopting it is a
 * pure step, and that is what is asserted here. The two properties that make
 * the fix work are the ones a re-render would silently undo:
 *   - the next snapshot is a NEW object (React bails out on an identical
 *     reference, so an in-place mutation publishes new content and no repaint);
 *   - the previous snapshot is not mutated (the shared cache is read by every
 *     other mounted instance).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'client.js');

/** Load client.js against a stub loader and return one materialized factory. */
async function loadClient() {
  const registered = [];
  const saved = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (reg) => registered.push(reg) } };
  try {
    await import(`${pathToFileURL(CLIENT).href}?provider-write=${Date.now()}`);
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
  const fakeRequire = (name) => {
    if (name === 'react') {
      const h = () => null;
      return {
        createElement: h,
        useState: () => [null, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null }),
        useCallback: (fn) => fn,
      };
    }
    throw new Error(`unexpected require(${name})`);
  };
  return registered[0].factory(fakeRequire);
}

describe('provider write — the panel adopts the value the server accepted', () => {
  it('the response carries one flat branch, or nothing at all', async () => {
    const { providerBranchOf } = (await loadClient()).__test;
    const answer = { ok: true, provider: { panel: 'A', effective: 'A', source: 'panel' } };
    assert.deepEqual(providerBranchOf(answer), { panel: 'A', effective: 'A', source: 'panel' });
    // A response with no branch is not a partial success — it adopts nothing, and
    // the caller falls back to the reload rather than publishing a half-truth.
    assert.equal(providerBranchOf({ ok: true }), null);
    assert.equal(providerBranchOf(null), null);
  });

  it('adoption produces a NEW snapshot and leaves the old one untouched', async () => {
    const { providerBranchOf, snapshotWithBranch } = (await loadClient()).__test;
    const before = {
      provider: { panel: 'old-ask', effective: 'old-ask', storePath: '/x/provider.json' },
      daemon: { up: true },
    };
    const branch = providerBranchOf({ ok: true, provider: { panel: 'new-ask', effective: 'new-ask', storePath: '/x/provider.json' } });
    const after = snapshotWithBranch(before, branch);

    assert.notEqual(after, before, 'a new object — an identical reference renders nothing');
    assert.equal(after.provider.panel, 'new-ask', 'the dropdown must show the value just accepted');
    assert.equal(before.provider.panel, 'old-ask', 'the previous snapshot must not be mutated');
    assert.equal(after.provider.storePath, '/x/provider.json', 'steps the answer did not carry are carried over, not cleared');
    assert.equal(after.daemon, before.daemon, 'everything outside the provider branch survives');
  });

  it('adopts nothing when there is no snapshot to adopt into', async () => {
    // First load failed / never happened: the reload fetches the truth instead.
    const { snapshotWithBranch } = (await loadClient()).__test;
    assert.equal(snapshotWithBranch(null, { panel: 'A' }), null);
  });
});
