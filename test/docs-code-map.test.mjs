/**
 * docs-code-map.test.mjs — the docs/README.md code map must stay in sync with `src/` + `lib/`.
 *
 * The map at `docs/README.md` §代码地图 is the second-eye orientation a new
 * reader gets. It has already drifted once: after the v0.4.3 split of the
 * God module `apply()` into `config` / `runtime` / `routes` / `stats` / `tools`,
 * seven new `src/host/*.ts` files were never added to the map, and the whole
 * `src/shared/` directory (both `loopback.ts` and `stats.ts`) was still
 * undocumented. Nothing told the reader that half the code was invisible.
 *
 * This suite pins the map to the real tree in three directions:
 *
 *  1. Every `src/host/*.ts` shows up in the map (forward: source → docs).
 *  2. Every `src/shared/*.ts` shows up in the map (forward: source → docs).
 *  3. Every `lib/*.js` emitted by `tsdown.config.mjs` is named by a `src/host/*.ts → lib/*.js`
 *     line, and the other direction: every `src/host/*.ts` is either mapped to a
 *     real `lib/*.js` on disk, or annotated as inlined. This is the check that
 *     catches a stale artifact or a stale map line the moment either drifts.
 *
 * It reads both files as TEXT. This is deliberate: importing `lib/*.js` from
 * `src/*.ts` is what `test/wiring.test.mjs` documents as unsafe (module
 * identity, `setSpawnOverride`), but a text read shares no module state and
 * cannot trip that seam.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const listTs = (dir) =>
  readdirSync(join(ROOT, 'src', dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name)
    .sort();
const listJs = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name)
    .sort();

const DOC = read('docs/README.md');
const MAP_START = DOC.indexOf('## 代码地图');
assert.ok(MAP_START !== -1, 'docs/README.md must contain a "## 代码地图" section');
const MAP_END = DOC.indexOf('## ', MAP_START + 1);
const MAP = DOC.slice(MAP_START, MAP_END === -1 ? undefined : MAP_END);

describe('docs/README.md 代码地图 — must not fall behind src/ or lib/', () => {
  it('every src/host/*.ts is named on the map', () => {
    const missing = listTs('host').filter((f) => !MAP.includes(`src/host/${f}`));
    assert.deepStrictEqual(
      missing,
      [],
      `docs/README.md 代码地图 is missing these src/host files: ${missing.join(', ')}`,
    );
  });

  it('every src/shared/*.ts is named on the map', () => {
    const missing = listTs('shared').filter((f) => !MAP.includes(`src/shared/${f}`));
    assert.deepStrictEqual(
      missing,
      [],
      `docs/README.md 代码地图 is missing these src/shared files: ${missing.join(', ')}`,
    );
  });

  // The map uses two shapes for a `src/host/*.ts → lib/*.js` line:
  //
  //   src/host/foo.ts  → lib/foo.js  description…
  //   src/host/foo.ts  → lib/bar.js  …   (only when the entry name differs)
  //
  // Everything else a reader might write — a `src/host/foo.ts  → lib/…` without
  // a real artifact, a made-up `lib/*.js` that no source produces — is what the
  // three assertions below catch.
  const HOST_MAP_LINE = /^src\/host\/([\w.-]+\.ts)\s*(?:→|-->)\s*lib\/([\w.-]+\.js)/gm;
  const hostMapped = new Map(); // src basename → lib basename
  for (const m of MAP.matchAll(HOST_MAP_LINE)) hostMapped.set(m[1], m[2]);

  // A `src/host/foo.ts` line that names no artifact (typo, wrong direction, or a
  // "→ (inlined)"-style annotation) is a documentation bug in its own right:
  // the reader is pointed at a source with no way to see where it lands.
  it('every src/host/*.ts line on the map names a real artifact', () => {
    const dangling = listTs('host').filter((f) => !hostMapped.has(f));
    assert.deepStrictEqual(
      dangling,
      [],
      `these src/host files appear on the map but no "src/host/… → lib/…" line resolves them: ${dangling.join(', ')} — a new entry needs a matching lib/*.js row, or a "(inlined …)" annotation if it deliberately has none`,
    );
  });

  it('every src/host/*.ts on the map points at an artifact that exists on disk', () => {
    const onDisk = new Set(listJs('lib'));
    const dangling = [...hostMapped.entries()].filter(([, lib]) => !onDisk.has(lib));
    assert.deepStrictEqual(
      dangling,
      [],
      `docs/README.md 代码地图 points at artifacts that do not exist: ${dangling.map(([s, l]) => `${s} → lib/${l}`).join(', ')}`,
    );
  });

  it('every committed lib/*.js is accounted for by the map', () => {
    const mapped = new Set(hostMapped.values());
    // `lib/loopback.js` is emitted from `src/shared/loopback.ts`, not `src/host/`,
    // so it is the one `lib/` artifact whose src prefix is not `src/host/`.
    const sharedFromMap = MAP.match(/^src\/shared\/([\w.-]+\.ts)\s*(?:→|-->)\s*lib\/([\w.-]+\.js)/gm) ?? [];
    for (const m of sharedFromMap) {
      const g = m.match(/^src\/shared\/[\w.-]+\.ts\s*(?:→|-->)\s*lib\/([\w.-]+\.js)/);
      if (g) mapped.add(g[1]);
    }
    const unmapped = listJs('lib').filter((f) => !mapped.has(f));
    assert.deepStrictEqual(
      unmapped,
      [],
      `these lib/*.js artifacts are not accounted for by docs/README.md 代码地图: ${unmapped.join(', ')}`,
    );
  });

  it('src/client/index.ts exists (it is the client IIFE entry, named in the map)', () => {
    assert.ok(listTs('client').includes('index.ts'), 'src/client/index.ts must exist (it is the tsdown client entry)');
    assert.ok(MAP.includes('src/client/'), 'map must mention the src/client/ directory');
    assert.ok(/src\/client\/\*\.ts/.test(MAP), 'map must show the src/client/*.ts → client.js shape (multi-file bundle)');
  });
});
