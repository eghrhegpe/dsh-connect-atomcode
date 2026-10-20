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
 * EVERY PREDICATE IS A NAMED FUNCTION so it can be fed a PLANTED BAD SAMPLE.
 * A scan-and-assert-empty gate passes for two opposite reasons — "the docs are
 * clean" and "the scanner stopped matching anything" — and those look identical
 * in a green run. The last `describe` here feeds each predicate one deliberately
 * broken input and one good one, so the second reason becomes a red test.
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

/** The probe scripts the probe index must account for. */
const PROBES = readdirSync(join(ROOT, 'scripts', 'probes'))
  .filter((f) => f.endsWith('.mjs'))
  .sort();

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

/** `见「X」` where X is not a substring of any heading in the same doc. */
function danglingHeadingRefs(doc, text, headings) {
  const offenders = [];
  for (const m of text.matchAll(/见「([^」]+)」/g)) {
    const name = m[1];
    if (!headings.some((h) => h.includes(name))) {
      offenders.push(`${doc}: 见「${name}」— 本文件没有任何标题包含这个名字`);
    }
  }
  return offenders;
}

/** Relative `](target)` links that do not resolve on disk. */
function brokenLinks(doc, text) {
  const broken = [];
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = m[1].trim().split(/\s+/)[0]; // drop an optional "title"
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = raw.split('#')[0].split('?')[0];
    if (!target) continue; // pure in-page anchor
    if (!existsSync(resolve(join(ROOT, dirname(doc)), target))) {
      broken.push(`${doc} → ${m[1]}`);
    }
  }
  return broken;
}

/**
 * Screenshot refs (`![alt](target)`). These are NOT ordinary relative links:
 * `assets/` is deliberately kept OUT of `package.json`'s `files` whitelist
 * (see `test/release-artifacts.test.mjs`), so a relative `assets/…` target renders
 * on GitHub and then goes missing on the registry page. The rule is therefore
 * "absolute raw address, and the file must exist here anyway" — the absolute form
 * keeps the typo net that leaving `brokenLinks()` would otherwise lose.
 */
const RAW_PREFIX = 'https://raw.githubusercontent.com/eghrhegpe/dsh-connect-atomcode/master/';

function screenshotRefs(doc, text) {
  const problems = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
    const raw = m[1];
    if (!/^https?:/.test(raw)) {
      const rel = raw.split('#')[0].split('?')[0];
      problems.push(
        `${doc}: 截图用了相对路径 ${raw}——assets/ 不进 npm 包（release-artifacts 钉着这条策略），registry 页上会裂；改成 ${RAW_PREFIX}${rel}`,
      );
      continue;
    }
    if (!raw.startsWith(RAW_PREFIX)) continue; // shields.io 之类的站外图
    const rel = raw.slice(RAW_PREFIX.length).split('#')[0].split('?')[0];
    if (!existsSync(resolve(join(ROOT, rel)))) problems.push(`${doc}: ${raw} 指向的 ${rel} 在本仓库里不存在`);
  }
  return problems;
}

/** Documents that spell out a mutable count ("N 条红线"). */
function redLineCounts(doc, text) {
  const line = text.split(/\r?\n/).findIndex((l) => /\d+\s*条红线/.test(l));
  return line === -1 ? [] : [`${doc}:${line + 1}`];
}

/** Probes the index never names. */
function unlistedProbes(indexText, probes) {
  return probes.filter((p) => !indexText.includes(p));
}

/** Probes no document outside the index ever cites (their conclusion has no home). */
function uncitedProbes(citedText, probes) {
  return probes.filter((p) => !citedText.includes(p));
}

/**
 * The reference doc (`docs/AtomCode-CLI与daemon接口参考.md`) is the declared
 * single source of truth for the daemon's HTTP endpoints — AGENTS.md routes
 * readers there ("命令数与选项数一律以本篇实测为准"). This predicate guards
 * that declaration, not general prose: the endpoints AGENTS.md names as its
 * quota sources, plus the bolded grouping heading that holds them, must still
 * be present in the reference. Scanning AGENTS.md itself for endpoint literals
 * is deliberately avoided — it carries retired names (`POST /inject`, the
 * review CLI's `v1/chat/completions`) that would false-alarm. Grouping labels
 * there are bold prose (`**用量与套餐**`), not `###` headings — that is how
 * the other endpoint groups in §4 are labelled too, so we match the actual
 * form rather than a `##`-shaped one the doc never uses.
 */
const REFERENCE_DOC = 'docs/AtomCode-CLI与daemon接口参考.md';
const REQUIRED_REFERENCE_ANCHORS = ['**用量与套餐**'];
const REQUIRED_REFERENCE_ENDPOINTS = [
  'GET /codingplan/usage/summary',
  'GET /codingplan/usage/daily',
  'POST /command',
  'POST /chat',
];

function missingReferenceFacts(referenceText) {
  const missing = [];
  for (const anchor of REQUIRED_REFERENCE_ANCHORS) {
    if (!referenceText.includes(anchor)) missing.push(`${anchor} 分组标题`);
  }
  for (const endpoint of REQUIRED_REFERENCE_ENDPOINTS) {
    if (!referenceText.includes(endpoint)) missing.push(`${endpoint} 端点行`);
  }
  return missing.map((m) => `${REFERENCE_DOC} 缺 ${m}（AGENTS.md「三条事实」第 2 条与「额度」论述以此为真源）`);
}

describe('docs 引用完整性 — 引用的标题必须真实存在', () => {
  it('每个 `见「X」` 的 X 都是同一份文档里某个标题的子串', () => {
    const offenders = DOCS.flatMap((doc) => danglingHeadingRefs(doc, withoutFences(read(doc)), headingsOf(read(doc))));
    assert.deepStrictEqual(
      offenders,
      [],
      '悬空引用：标题被改名/搬走，或引用该写成跨文件链接：\n' + offenders.join('\n'),
    );
  });
});

describe('docs 引用完整性 — 相对链接必须落地', () => {
  it('每个 `](相对路径)` 指向真实存在的文件', () => {
    const broken = DOCS.flatMap((doc) => brokenLinks(doc, withoutFences(read(doc))));
    assert.deepStrictEqual(broken, [], '相对链接指向了不存在的文件：\n' + broken.join('\n'));
  });
});

describe('docs 引用完整性 — 截图必须是绝对 raw 地址（assets/ 不进 npm 包）', () => {
  // 四张图里三张是 shields.io 徽章（站外，跳过），只有 README 的两张截图是仓库内的。
  // 它们曾经写成 `assets/xxx.png`：GitHub 上正常，registry 页上必裂——因为 `files`
  // 白名单刻意不含 assets/（test/release-artifacts.test.mjs 钉着这条策略）。
  // 绝对化之后 `brokenLinks()` 不再覆盖它们，所以「路径写错」这张网在这里补回来。
  it('仓库内的截图要么是 raw 绝对地址、要么就报错，且该文件在仓库里存在', () => {
    const offenders = DOCS.flatMap((doc) => screenshotRefs(doc, withoutFences(read(doc))));
    assert.deepStrictEqual(offenders, [], '截图引用不合格：\n' + offenders.join('\n'));
  });
});

describe('docs 引用完整性 — 会变的计数不写进文档', () => {
  // AGENTS.md 文档纪律 1（"会变的计数不写进文档"）：红线条数已经漂过一次
  // （加了第 9 条，索引里还写着 8）。这条门只禁「N 条红线」这一种写法——它是
  // 明确写死的纪律，不是对散文的抽查。
  it('没有任何文档写出「N 条红线」', () => {
    const offenders = DOCS.flatMap((doc) => redLineCounts(doc, read(doc)));
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

describe('docs 引用完整性 — AGENTS.md 引用的事实点必须在接口参考里有真源', () => {
  // AGENTS.md「三条事实」第 2 条把额度的真源指到 daemon 端点，而
  // `docs/AtomCode-CLI与daemon接口参考.md` 的 §1 说明明写"命令数与选项数一律
  // 以本篇实测为准"——那份参考因此是端点事实的唯一家。2026-10-20 发现它已经
  // 漂过一次：`GET /codingplan/usage/{summary,daily}` 落进 AGENTS.md 之后
  // 一直没进参考（`grep -c` 为 0），于是"下次 daemon 升级悄悄改了这个端点"
  // 没有任何一个地方会被红到。这条断言钉住 AGENTS.md 已命名的那些事实，
  // 而不是扫 AGENTS.md 全部端点字符串——它同时携带已退役的历史名
  // （`POST /inject`、review CLI 的 `v1/chat/completions`），那些会误报。
  it('参考文档仍收录 AGENTS.md「三条事实」点名的所有端点与它们所在的章节', () => {
    const missing = missingReferenceFacts(read(REFERENCE_DOC));
    assert.deepStrictEqual(missing, [], '真源缺席：\n' + missing.join('\n'));
  });
});

describe('docs 引用完整性 — 探针索引必须收录每个探针，且结论有出处', () => {
  // `scripts/probes/README.md` 的「纪律」一节写着：新增探针要 ① 头注写成本、
  // ② 结论写进 docs/、③ 凭据运行时读。它是手写列表，于是漂了一次——
  // `probe-gate-diff.mjs` 落盘（2026-10-17）后既没进索引，也在**任何**文档里
  // 零引用，索引当时还只列 5 个探针。这两条把「索引漏了」和「结论没归属」
  // 变成机械可查的事实，而不是靠下次有人想起来。
  //
  // 判据刻意宽松：结论记在 `docs/*.md`、`README.md` 或 `AGENTS.md` 任一处都算
  // 有出处（有的探针产出的是操作纪律而不是协议结论，AGENTS.md 才是它的家）。
  it('scripts/probes/README.md 提到了 scripts/probes/ 下每一个 *.mjs', () => {
    const unlisted = unlistedProbes(read(join('scripts', 'probes', 'README.md')), PROBES);
    assert.deepStrictEqual(
      unlisted,
      [],
      'scripts/probes/README.md 是探针索引——新探针落盘却没进表：' + unlisted.join(', '),
    );
  });

  it('每个探针至少在索引之外被引用一次（结论有出处，不是只活在自己的头注里）', () => {
    const orphans = uncitedProbes(DOCS.map(read).join('\n'), PROBES);
    assert.deepStrictEqual(
      orphans,
      [],
      '探针对应的结论必须落在 docs/、README.md 或 AGENTS.md 里（探针头注只写成本与用法）：' +
        orphans.join(', '),
    );
  });
});

describe('docs 引用完整性 — 扫描器自己活着（扫不到东西 ≠ 干净）', () => {
  it('扫描面非空，且覆盖已知的关键文件', () => {
    // 门槛取「比今天少一点」，不是等于今天——文档增删不该红。它挡的是
    // 「目录读错了 / 过滤写歪了，于是每个判据都空着通过」。
    assert.ok(DOCS.length >= 8, `扫描面只有 ${DOCS.length} 份文档，明显不是 docs/ 的全集`);
    assert.ok(DOCS.includes('AGENTS.md'), '扫描面必须包含仓库根的 AGENTS.md');
    assert.ok(DOCS.includes(join('docs', 'RELEASING.md')), '扫描面必须包含 docs/RELEASING.md');
    assert.ok(DOCS.includes(join('docs', 'README.md')), '扫描面必须包含文档索引 docs/README.md');
    assert.ok(PROBES.length >= 5, `只认出 ${PROBES.length} 个探针，探测目录或过滤失效了`);
  });

  it('每个判据都能抓住故意做坏的样本，也会放过好样本', () => {
    // 见「X」
    assert.equal(danglingHeadingRefs('x.md', '见「不存在的标题」', ['真实标题']).length, 1);
    assert.equal(danglingHeadingRefs('x.md', '见「真实标题」', ['真实标题']).length, 0);
    // 相对链接（从仓库根文档出发）
    assert.equal(brokenLinks('x.md', '](不存在的文件.md)').length, 1);
    assert.equal(brokenLinks('x.md', '](docs/README.md)').length, 0);
    // 截图（绝对 raw + 路径必须落地）
    assert.equal(screenshotRefs('README.md', '![a](assets/x.png)').length, 1);
    assert.equal(screenshotRefs('README.md', `![a](${RAW_PREFIX}assets/atomcode-review.png)`).length, 0);
    assert.equal(screenshotRefs('README.md', `![a](${RAW_PREFIX}assets/no-such-shot.png)`).length, 1);
    assert.equal(screenshotRefs('README.md', '![npm](https://img.shields.io/npm/v/x)').length, 0);
    // 会变的计数
    assert.equal(redLineCounts('x.md', '本仓库共 8 条红线').length, 1);
    assert.equal(redLineCounts('x.md', '红线若干条').length, 0);
    // 探针索引 / 出处
    assert.equal(unlistedProbes('表里只有 probe-a.mjs', ['probe-b.mjs']).length, 1);
    assert.equal(unlistedProbes('表里有 probe-b.mjs', ['probe-b.mjs']).length, 0);
    assert.equal(uncitedProbes('docs 里没提过它', ['probe-b.mjs']).length, 1);
    assert.equal(uncitedProbes('docs 引用了 probe-b.mjs', ['probe-b.mjs']).length, 0);
    // 参考文档的真源锚点
    const fullRef = ['**用量与套餐**', 'GET /codingplan/usage/summary', 'GET /codingplan/usage/daily', 'POST /command', 'POST /chat'].join('\n');
    assert.equal(missingReferenceFacts(fullRef).length, 0);
    assert.equal(missingReferenceFacts(fullRef.replace('GET /codingplan/usage/daily\n', '')).length, 1);
    assert.equal(missingReferenceFacts(fullRef.replace('**用量与套餐**', '')).length, 1);
    // 标题抽取本身也要能认出标题（否则「悬空引用」会永远空着通过）
    assert.deepEqual(headingsOf('## 一个标题\n正文\n'), ['一个标题']);
    assert.deepEqual(headingsOf('```\n# 位于代码块里的井号\n```\n'), []);
  });
});
