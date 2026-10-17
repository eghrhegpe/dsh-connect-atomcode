/**
 * probes-index.test.mjs — `scripts/probes/` must not grow a probe nobody indexed.
 *
 * The disease is the one every other "index" suite in this repo was written to
 * catch: a hand-maintained list silently drops a member, and nothing downstream
 * notices, because the list is only ever READ, never diffed against the thing it
 * lists. Here the list is `scripts/probes/README.md` (the cost table that tells a
 * human which probe is safe to run — a probe costing a real model turn must never
 * be reachable by accident), and the thing it lists is the directory itself.
 * `AGENTS.md` states the contract twice ("每个脚本头注都写了成本", "复现 docs/ 里的实测
 * → scripts/probes/"), and until now both halves were prose-only: adding a probe
 * with no index row and no cost header failed nothing.
 *
 * Same shape as `test/client-id.test.mjs`'s locale scan and
 * `test/docs-code-map.test.mjs`'s per-file map pins: discover from disk, assert
 * the doc covers every name, and assert the doc names nothing that vanished.
 *
 * Offline, zero quota: this suite only reads text. It never runs a probe.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBES_DIR = join(ROOT, 'scripts', 'probes');

const probeFiles = readdirSync(PROBES_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
  .map((e) => e.name)
  .sort();
const INDEX = readFileSync(join(PROBES_DIR, 'README.md'), 'utf8');

// The index is the cost table, and only its FIRST column. The table has a second
// column (「原名」) holding the old gitignored root names like `.probe-signing.mjs`
// — those are deliberately-not-files, so scanning the whole README for `*.mjs`
// would report three phantom probes. A prose mention is not an index row either:
// the contract being pinned is "it has a cost row", not "its name appears".
const indexedProbes = new Set(
  INDEX.split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3)
    .map((cells) => cells[1].replace(/`/g, ''))
    .filter((name) => name.endsWith('.mjs')),
);

// A cost header is either the Chinese marker (newer probes) or the English
// `COST:` line (older ones). Either is fine; silence is not.
const COST_HEADER = /(成本|COST)/;

describe('scripts/probes/ — the index and the cost headers must stay complete', () => {
  it('there is at least one probe to index', () => {
    // Guards against the vacuous-pass shape: an empty directory makes every
    // "every X is covered" assertion below true. The probes are the point.
    assert.ok(probeFiles.length >= 5, `expected the probe directory to be populated, saw ${probeFiles.length}`);
    assert.ok(indexedProbes.size >= 5, `the cost table should have at least 5 rows, saw ${indexedProbes.size}`);
  });

  it('every probe has a row in scripts/probes/README.md 成本表', () => {
    const missing = probeFiles.filter((name) => !indexedProbes.has(name));
    assert.deepStrictEqual(
      missing,
      [],
      `这些探针没有成本表行：${missing.join(', ')} —— 成本表是唯一告诉人"这个探针跑起来要不要花额度"的地方，漏一行等于把花额度的东西放到没人知道的位置`,
    );
  });

  it('the 成本表 names no probe that has been removed', () => {
    const onDisk = new Set(probeFiles);
    const dangling = [...indexedProbes].filter((name) => !onDisk.has(name));
    assert.deepStrictEqual(
      dangling,
      [],
      `scripts/probes/README.md 成本表点了这些不存在的探针：${dangling.join(', ')} —— 要么把探针放回来，要么删掉那一行`,
    );
  });

  it('every probe declares its own cost in its header', () => {
    const silent = probeFiles.filter((name) => !COST_HEADER.test(readFileSync(join(PROBES_DIR, name), 'utf8')));
    assert.deepStrictEqual(
      silent,
      [],
      `这些探针头注没写成本：${silent.join(', ')} —— AGENTS.md 说"每个脚本头注都写了成本"，成本未知的探针等于没人敢跑，或者被人当零额度的跑了`,
    );
  });
});

