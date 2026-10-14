/**
 * client-id.test.mjs — guards the client-half registration contract.
 *
 * The Host keys client-module factories by PACKAGE NAME and resolves each row
 * as `factories.has(id)` (dsh-client-modules `arrive()`); `register()` itself
 * never validates the id, so a mismatched id loads "successfully" and then
 * fails the web boot audit with:
 *
 *   client-modules: could not load "<pkg>":
 *     <bundle>: ... ; <pkg>/client.js: loaded without registering "<pkg>" via __ModuleLoader__.load
 *
 * That is a full-boot failure caused by a one-word constant, so it gets a test:
 * execute client.js against a stub loader and require the registered id to equal
 * `package.json`'s `name` verbatim.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLIENT = join(ROOT, 'client.js');
const MANIFEST = join(ROOT, 'package.json');

/** Run client.js with a stub __ModuleLoader__ and return what it registered. */
async function loadClientRegistration() {
  const registered = [];
  const savedWindow = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load(reg) {
        registered.push(reg);
      },
    },
  };
  try {
    await import(`${pathToFileURL(CLIENT).href}?probe=${Date.now()}`);
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
  return registered;
}

describe('client half — registration contract', () => {
  it('registers exactly one factory, keyed by package.json name', async () => {
    const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const registered = await loadClientRegistration();
    assert.equal(registered.length, 1, 'client.js must call __ModuleLoader__.load exactly once');
    assert.equal(
      registered[0].id,
      pkg.name,
      `registration id must equal the package name "${pkg.name}" (the Host resolves the row as factories.has(name))`,
    );
    assert.equal(typeof registered[0].factory, 'function', 'registration must carry a factory function');
  });

  it('manifest declares the web client half the loader scans for', () => {
    const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    assert.equal(pkg.dsh?.client?.platform, 'web');
    assert.ok(pkg.exports?.['./client'], 'package.json exports must expose "./client"');
    assert.ok(pkg.files?.includes('client.js'), 'client.js must ship in files[]');
  });

  it('factory returns the slots/locale inject the panel needs', async () => {
    const registered = await loadClientRegistration();
    // The factory is only materialized by the loader; give it the two globals it
    // requires at construction time.
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
    const mod = registered[0].factory(fakeRequire);
    assert.deepEqual(mod.inject, ['slots', 'locale']);
    assert.equal(typeof mod.apply, 'function');
  });

  /**
 * The web boot's static seed table, as a `require`.
 *
 * The client half additionally asks for `react-dom` and
 * `@deepseek-ai/dsh-client-ui-primitives` (the quota panel's portal and
 * anchoring hooks). Both are seeds, so a stub that throws on them exercises
 * only the degraded `title` branch and would let the panel ship untested.
 */
function fakeRequire(name) {
  if (name === 'react') {
    return {
      createElement: () => null,
      useState: () => [null, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useCallback: (fn) => fn,
    };
  }
  if (name === 'react-dom') return { createPortal: (node) => ({ portal: node }) };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      Tooltip: () => null,
      useAnchoredPosition: () => ({ left: 0, top: 0 }),
      useDismissOnOutsidePointer: () => {},
    };
  }
  throw new Error(`unexpected require(${name})`);
}

/** Run the client half and return every slot registration it makes. */
async function claimSeats() {
  const registered = await loadClientRegistration();
  const mod = registered[0].factory(fakeRequire);
  const claims = [];
  mod.apply({
    slots: {
      inject(seat, fn) { fn(); },
      register(config) { claims.push(config); return () => {}; },
    },
  });
  return claims;
}

  it('claims the detail section and the composer-dock quota readout, never the single-occupancy seat', async () => {
    const claims = await claimSeats();

    const seats = claims.map((c) => c.name);
    assert.ok(seats.includes('plugins.detail.section'), 'the detail page section must stay registered');
    // The quota readout lives in the composer DOCK, beside the host's own
    // readouts (turns, tokens, the context ring). It used to sit in
    // `conversation.input.right`, which is the OPERATIONS row (mic / send) —
    // a gauge among buttons. A quota number is a readout, so it moved.
    assert.ok(
      seats.includes('conversation.composer.dock'),
      'the compact quota readout must be claimed in the composer dock',
    );
    assert.ok(
      !seats.includes('conversation.input.right'),
      'must NOT sit in the submit-adjacent controls row (that is the mic/send cluster)',
    );
    // `conversation.input.activity` is kind=single and the voice-input bundle
    // already holds it — claiming it would displace that control.
    assert.ok(
      !seats.includes('conversation.input.activity'),
      'must NOT claim the single-occupancy activity seat (owned by voice input)',
    );
    for (const c of claims) assert.ok(c.id, `every claim needs an id; got ${JSON.stringify(c)}`);
    assert.equal(new Set(claims.map((c) => c.id)).size, claims.length, 'claim ids must be unique');
  });

  it('orders the dock readout between the host stat pills and decorations', async () => {
    // `dsh-client-ui-chat` registers its turns/tokens pills in this same seat at
    // order 0 under id "stats"; the shipped decoration template uses order 5.
    // Sitting between them is what makes the strip read as one row.
    const dock = (await claimSeats()).find((c) => c.name === 'conversation.composer.dock');
    assert.ok(dock, 'dock seat must be claimed');
    assert.equal(dock.id, 'atomcode-bridge-quota', 'a fresh id, so the host entry is not replaced');
    assert.ok(dock.order > 0, `must sort after the host stats pills (order 0); got ${dock.order}`);
    assert.ok(dock.order < 5, `must sort before decorations (template order 5); got ${dock.order}`);
  });

  it('survives a shell without the composer seat (degrades, does not throw)', async () => {
    const registered = await loadClientRegistration();
    const mod = registered[0].factory((name) => {
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
    });
    const claims = [];
    const ctx = {
      slots: {
        // Only the detail seat exists in this hypothetical shell.
        inject(seat, fn) {
          if (seat === 'plugins.detail.section') fn();
          else throw new Error(`unknown slot ${seat}`);
        },
        register(config) { claims.push(config); return () => {}; },
      },
    };
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.deepEqual(claims.map((c) => c.name), ['plugins.detail.section']);
  });

  it('cordis.patch.yml row identity matches the package name', () => {
    // The patch file's own comment warns that the host matches the row specifier
    // against the nearest manifest and SILENTLY DROPS a mismatch.
    //
    // Which field is load-bearing: our row is a bare `- insert:` entry, and
    // app-boot's applyEntryPatches just does `data.push(...insert)` for inserts
    // (it never matches inserted rows against existing entries), so the loader
    // resolves the MODULE from `name`. `id` is only the handle later patches
    // target. Both are asserted because both are documented as the package name.
    const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const yaml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
    const strip = (value) => value.replace(/^['"]|['"]$/g, '');
    const field = (key) =>
      // `-?` because the first key of a YAML list item shares its line with the dash.
      [...yaml.matchAll(new RegExp(`^\\s*-?\\s*${key}:\\s*(\\S+)\\s*$`, 'gm'))].map((m) => strip(m[1]));
    const names = field('name');
    const ids = field('id');
    assert.ok(names.length > 0, 'cordis.patch.yml must declare a row name');
    assert.ok(names.includes(pkg.name), `row name must include "${pkg.name}"; found ${JSON.stringify(names)}`);
    assert.ok(ids.includes(pkg.name), `row id must include "${pkg.name}"; found ${JSON.stringify(ids)}`);
  });
});
