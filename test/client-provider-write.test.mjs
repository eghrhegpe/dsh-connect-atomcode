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
  it('the response carries both branches, or nothing at all', async () => {
    const { providerSlotsOf } = (await loadClient()).__test;
    const answer = { ok: true, ask: { panel: 'A' }, review: { panel: 'B', effective: 'B' } };
    assert.deepEqual(providerSlotsOf(answer), { ask: { panel: 'A' }, review: { panel: 'B', effective: 'B' } });
    // A response with no branch is not a partial success — it adopts nothing, and
    // the caller falls back to the reload rather than publishing a half-truth.
    assert.equal(providerSlotsOf({ ok: true }), null);
    assert.equal(providerSlotsOf(null), null);
  });

  it('adoption produces a NEW snapshot and leaves the old one untouched', async () => {
    const { providerSlotsOf, snapshotWithSlots } = (await loadClient()).__test;
    const before = {
      provider: {
        ask: { panel: 'old-ask', effective: 'old-ask' },
        review: { panel: 'old-review', effective: 'old-review' },
      },
      daemon: { up: true },
    };
    const slots = providerSlotsOf({ ok: true, ask: { panel: 'new-ask', effective: 'new-ask' } });
    const after = snapshotWithSlots(before, slots);

    assert.notEqual(after, before, 'a new object — an identical reference renders nothing');
    assert.equal(after.provider.ask.panel, 'new-ask', 'the dropdown must show the value just accepted');
    assert.equal(before.provider.ask.panel, 'old-ask', 'the previous snapshot must not be mutated');
    assert.equal(after.provider.review.panel, 'old-review', 'the untouched branch is carried over, not cleared');
    assert.equal(after.daemon, before.daemon, 'everything outside the provider branch survives');
  });

  it('adopts nothing when there is no snapshot to adopt into', async () => {
    // First load failed / never happened: the reload fetches the truth instead.
    const { snapshotWithSlots } = (await loadClient()).__test;
    assert.equal(snapshotWithSlots(null, { ask: { panel: 'A' } }), null);
  });
});
