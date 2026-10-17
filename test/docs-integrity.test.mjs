/**
 * docs-integrity.test.mjs — the docs' own cross-references and indices must not rot.
 *
 * WHAT THIS GUARDS, AND WHY IT EXISTS NOW. The repo already pins two kinds of
 * prose (docs-code-map.test.mjs pins the code map; wiring.test.mjs pins the
 * config-field comments), but nothing watched the REFERENCES between sections.
 * Two of them had already drifted by 2026-10-17:
 *
 *   - `README.md` told the reader to "见「治理记录」" for a section that had been
 *     moved out of README into `docs/DECISIONS.md` a day earlier — a dangling
 *     reference no gate could see;
 *   - `docs/README.md` described AGENTS.md as carrying "8 条红线" after a ninth
 *     was added — the exact failure AGENTS.md's own 文档纪律 1 forbids
 *     ("会变的计数不写进文档").
 *
 * WHAT THIS SUITE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. Every check here
 * is an INVARIANT — a reference resolves, a link lands, a forbidden COUNT is
 * absent, an index is complete. None of them pins what a sentence SAYS. That
 * distinction is the whole point: a test that reads prose snapshots ages into a
 * tautology the moment the prose is edited for good reason, while a test that
 * reads links and counts catches the rot it was written for. (The same
 * reasoning is why `docs-code-map.test.mjs` reads the map as TEXT but checks
 * file EXISTENCE, not wording.)
 *
 * DISCOVERY IS BY SCAN, not by a list: a new `docs/*.md` joins the gate by
 * existing, exactly as `scripts/test.mjs` auto-discovers suites — so adding a
 * doc can never silently fall outside the guard.
 *
 * Headings are collected with fenced code blocks skipped: `docs/README.md`'s
 * code map, `docs/RELEASING.md`'s shell transcripts and `README.md`'s PowerShell
 * blocks all contain lines that begin with `#` and are not headings.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every doc that participates: the four top-level docs plus everything under `docs/`. */
const DOCS = [
  ...readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name),
  ...readdirSync(join(ROOT, 'docs'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => join('docs', e.name)),
].sort();

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Drop fenced code blocks so transcript `#` lines are not mistaken for headings. */
function withoutFences(text) {
  let inFence = false;
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
}

/** The heading TEXTS of one doc, fence-aware (`## Foo` → `Foo`). */
function headingsOf(text) {
  return withoutFences(text)
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
}

describe('docs 引用完整性 — 引用的标题必须真实存在', () => {
  it('每个 `见「X」` 的 X 都是同一份文档里某个标题的子串', () => {
    const offenders = [];
    for (const doc of DOCS) {
      const text = withoutFences(read(doc));
      const headings = headingsOf(read(doc));
      for (const m of text.matchAll(/见「([^」]+)」/g)) {
        const name = m[1];
        if (!headings.some((h) => h.includes(name))) {
          offenders.push(`${doc}: 见「${name}」— 本文件没有任何标题包含这个名字`);
        }
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      '悬空引用：标题被改名/搬走，或引用该写成跨文件链接：\n' + offenders.join('\n'),
    );
  });
});

describe('docs 引用完整性 — 相对链接必须落地', () => {
  it('每个 `](相对路径)` 指向真实存在的文件', () => {
    const broken = [];
    for (const doc of DOCS) {
      const text = withoutFences(read(doc));
      for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
        const raw = m[1].trim().split(/\s+/)[0]; // drop an optional "title"
        if (/^(https?:|mailto:|#)/.test(raw)) continue;
        const target = raw.split('#')[0].split('?')[0];
        if (!target) continue; // pure in-page anchor
        if (!existsSync(resolve(join(ROOT, dirname(doc)), target))) {
          broken.push(`${doc} → ${m[1]}`);
        }
      }
    }
    assert.deepStrictEqual(broken, [], '相对链接指向了不存在的文件：\n' + broken.join('\n'));
  });
});

describe('docs 引用完整性 — 会变的计数不写进文档', () => {
  // AGENTS.md 文档纪律 1（"会变的计数不写进文档"）：红线条数已经漂过一次
  // （加了第 9 条，索引里还写着 8）。这条门只禁「N 条红线」这一种写法——它是
  // 明确写死的纪律，不是对散文的抽查。
  it('没有任何文档写出「N 条红线」', () => {
    const offenders = [];
    for (const doc of DOCS) {
      const line = read(doc)
        .split(/\r?\n/)
        .findIndex((l) => /\d+\s*条红线/.test(l));
      if (line !== -1) offenders.push(`${doc}:${line + 1}`);
    }
    assert.deepStrictEqual(
      offenders,
      [],
      '红线条数是会变的计数，别写进文档（AGENTS.md 文档纪律 1）：' + offenders.join(', '),
    );
  });
});

describe('docs 引用完整性 — 索引必须收录 docs/ 下每份文档', () => {
  it('docs/README.md 的索引提到了 docs/ 里每一个 *.md', () => {
    const index = read(join('docs', 'README.md'));
    const unlisted = readdirSync(join(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .filter((f) => !index.includes(f));
    assert.deepStrictEqual(
      unlisted,
      [],
      'docs/README.md 是文档层唯一索引——新文档落盘却没进索引：' + unlisted.join(', '),
    );
  });
});
