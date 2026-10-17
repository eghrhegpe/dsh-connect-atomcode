#!/usr/bin/env node
/**
 * release-status.mjs — 「发到哪一步了 / 还缺什么」的唯一跑法。
 *
 * 为什么存在。`docs/RELEASING.md` 的 §1 判定表与「最终闭环清单」一直是**散文 + 一份给人勾选的清单**，
 * 而本仓库其它纪律都有可执行门禁（`test/build-gate` 逐字节比产物、`test/docs-code-map` 比代码地图、
 * `test/wiring` 比两处版本号）。发版这一域因此是全仓库唯一「读过了也不会报错」的地方：
 * 2026-10-17 的 0.4.3 就是那样漏的——tag 推了、npm 发了、**Release 没建**，
 * 而发布提交上连着红了几条 CI run 也没人拦，因为清单把 CI 绿写成了「推荐」。
 *
 * 这个脚本只做一件事：把 §1 那组 A–E 命令与闭环清单的每一条**跑出来**、填好格子，
 * 让状态是一个命令的输出，而不是一段记忆。它**只读**：不 fetch、不 push、不 publish、不动 tag。
 * 对 `origin/master` 的判断基于本地已知的引用（脚本不联网取新引用）。
 *
 * 用法
 *   node scripts/release-status.mjs                  # 用 package.json 的 version
 *   node scripts/release-status.mjs 0.4.3            # 点名一个版本
 *   node scripts/release-status.mjs 0.4.3 --check    # 不完整时退出码 1（默认总是 0）
 *
 * 与 `test/release-consistency.test.mjs` 的分工：**离线不变量进测试**（最新版本节必须在 CHANGELOG 里、
 * tag 若存在必须与版本文件同号），**需要网络/凭据的事实只能在这里查**（npm / Release / CI 结论）——
 * 测试不许联网，这是本仓库的规矩。
 *
 * 符号：✓ 成立　✗ 不成立　? 查不动（没网 / 没 gh / 没 git）——`?` 与 `✗` 不同，别当成缺。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const explicit = argv.find((a) => !a.startsWith('--'));

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PKG = pkg.name;
const VERSION = explicit || pkg.version;
const TAG = `v${VERSION}`;

/** Run a command read-only; a non-zero exit is a FACT about the world, not a crash. */
function run(cmd, cmdArgs, { timeout = 20000 } = {}) {
  try {
    const out = execFileSync(cmd, cmdArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const why =
      err.code === 'ENOENT'
        ? `${cmd} 不在 PATH 里`
        : String(err.stderr || err.message || '')
            .trim()
            .split('\n')[0];
    return { ok: false, out: '', why };
  }
}

const git = (gitArgs) => run('git', gitArgs);

/** Display width: CJK counts as 2, so the ✓/✗ / label columns actually line up. */
function width(text) {
  let n = 0;
  for (const ch of text) {
    n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
      ? 2
      : 1;
  }
  return n;
}
const pad = (text, to) => text + ' '.repeat(Math.max(0, to - width(text)));
const mark = (state) => (state === 'yes' ? '✓' : state === 'no' ? '✗' : '?');

const lines = [];
const say = (line = '') => lines.push(line);
const detail = (text) => say(`                 · ${text}`);

// ── A. 仓库侧：tag 是否存在、指向哪里 ────────────────────────────────────────
const insideRepo = git(['rev-parse', '--is-inside-work-tree']);
const gitUsable = insideRepo.ok && insideRepo.out === 'true';

const tagSha = gitUsable ? git(['rev-parse', '--verify', '--quiet', `refs/tags/${TAG}`]) : { ok: false, why: 'git 不可用' };
const tag = tagSha.ok ? 'yes' : gitUsable ? 'no' : 'unknown';
const tagType = tag === 'yes' ? git(['cat-file', '-t', TAG]).out : '';

// ── B. master 侧：版本提交是否已在 origin/master ─────────────────────────────
const originMaster = gitUsable ? git(['rev-parse', '--verify', '--quiet', 'origin/master']) : { ok: false };
let onMaster = 'unknown';
let behindInfo = '';
if (tag === 'yes' && originMaster.ok) {
  const r = git(['merge-base', '--is-ancestor', tagSha.out, 'origin/master']);
  onMaster = r.ok ? 'yes' : 'no';
  const ahead = git(['rev-list', '--count', 'origin/master..HEAD']);
  if (ahead.ok && ahead.out !== '0') {
    const subjects = git(['log', '--oneline', 'origin/master..HEAD']).out.split('\n').filter(Boolean);
    behindInfo = `HEAD 比本地已知的 origin/master 多 ${ahead.out} 个提交：${subjects.join(' / ')}`;
  }
}

// ── C. 版本侧：两处版本文件 + CHANGELOG 的最新节 ──────────────────────────────
const indexSrc = readFileSync(join(ROOT, 'src', 'host', 'index.ts'), 'utf8');
const indexVersion = indexSrc.match(/^\s*version:\s*'([^']+)',\s*$/m)?.[1] ?? null;
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const changelogVersion = changelog.match(/^##\s+(\d+\.\d+\.\d+)/m)?.[1] ?? null;
/** The target version must be the one in BOTH hand-edited files AND the newest CHANGELOG section. */
const versions = pkg.version === VERSION && indexVersion === VERSION && changelogVersion === VERSION ? 'yes' : 'no';
const dirty = gitUsable ? git(['status', '--porcelain']) : { ok: false, out: '' };
const treeClean = dirty.ok && dirty.out === '';

// ── D. npm 侧：目标版本是否已发 ─────────────────────────────────────────────
/** Query the registry directly: no dependency on the npm CLI (Windows `npm.cmd` needs a shell) or its text output. */
async function registry(path, what) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return { state: 'no' };
    if (!res.ok) return { state: 'unknown', why: `HTTP ${res.status}` };
    return { state: 'yes', value: await res.json() };
  } catch (err) {
    const why = String(err?.cause?.code || err?.message || err).split('\n')[0];
    return { state: 'unknown', why: `${what} 查不到（${why}）` };
  }
}

const npmExact = await registry(`${PKG}/${VERSION}`, 'npm 上这个版本');
const npmLatest = await registry(`${PKG}/latest`, 'npm latest');
const npmPublished = npmExact.state;
const npmLatestVersion = npmLatest.state === 'yes' ? npmLatest.value.version : null;

// ── E. GitHub 侧：Release 是否已建 ──────────────────────────────────────────
function gh(args, { notFoundPattern } = {}) {
  const r = run('gh', args, { timeout: 25000 });
  if (!r.ok) {
    if (notFoundPattern && notFoundPattern.test(r.why)) return { state: 'no', why: r.why };
    return { state: 'unknown', why: r.why };
  }
  try {
    return { state: 'yes', value: JSON.parse(r.out) };
  } catch {
    return { state: 'unknown', why: 'gh 返回的不是 JSON' };
  }
}

const release = gh(['release', 'view', TAG, '--json', 'name,tagName,isDraft,isPrerelease,assets,url'], {
  notFoundPattern: /not found|Could not resolve to a Release|HTTP 404/i,
});

// ── F. CI 侧：发布提交与 master 头上那条，各自的最新结论 ──────────────────────
async function ciConclusion(sha) {
  if (!sha) return { state: 'unknown', why: '没有可比对的提交' };
  const list = gh(['run', 'list', '--limit', '50', '--json', 'databaseId,headSha,status,conclusion']);
  if (list.state !== 'yes') return list;
  const mine = list.value
    .filter((r) => r.headSha === sha)
    .sort((a, b) => b.databaseId - a.databaseId);
  if (mine.length === 0) return { state: 'unknown', why: `该提交没有 run（或 gh 只看到最近 50 条）：${sha.slice(0, 7)}` };
  const latest = mine[0];
  const conclusion = latest.status !== 'completed' ? latest.status : latest.conclusion;
  return { state: conclusion === 'success' ? 'yes' : 'no', value: `run ${latest.databaseId} ${conclusion}`, why: sha.slice(0, 7) };
}

const ciTag = await ciConclusion(tag === 'yes' ? tagSha.out : null);
const ciMaster = await ciConclusion(originMaster.ok ? originMaster.out : null);

// ── 输出 ───────────────────────────────────────────────────────────────────
say(`发版状态：${PKG} ${VERSION}（tag ${TAG}）`);
say(`基于本地已知的 origin/master；本脚本只读，不 fetch / 不 push / 不动 tag。`);
say();

say(`${pad('仓库可查', 16)}${mark(tag)} ${tag === 'yes' ? `${TAG} → ${tagSha.out.slice(0, 7)}（${tagType === 'tag' ? '附注 tag' : '轻量 tag'}）` : tag === 'no' ? `${TAG} 不存在` : tagSha.why}`);
say(`${pad('master 可查', 16)}${mark(onMaster)} ${onMaster === 'yes' ? `该提交已在 origin/master 上` : onMaster === 'no' ? `该提交不在 origin/master 上` : '查不动（没有 tag 或没有 origin/master）'}`);
if (behindInfo) detail(behindInfo);

say(
  `${pad('版本文件可查', 16)}${mark(versions)} package.json=${pkg.version} / src/host/index.ts=${indexVersion ?? '（没抽到）'} / CHANGELOG 最新节=${changelogVersion ?? '（没有版本号节）'}`,
);
detail(treeClean ? '工作树干净（§7 证据①）' : `工作树有未提交改动（§7 证据① 不成立）：\n${dirty.out.split('\n').slice(0, 8).join('\n')}`);

say(
  `${pad('npm 可查', 16)}${mark(npmPublished)} ${
    npmPublished === 'yes'
      ? `npm 上已有 ${VERSION}（latest=${npmLatestVersion ?? '?'}）`
      : npmPublished === 'no'
        ? `npm 上还没有 ${VERSION}（latest=${npmLatestVersion ?? '?'}）`
        : npmExact.why
  }`,
);

const relInfo = release.state === 'yes' ? release.value : null;
say(
  `${pad('Release 可查', 16)}${mark(release.state)} ${
    relInfo
      ? `${TAG}（tagName=${relInfo.tagName}，draft=${relInfo.isDraft}，prerelease=${relInfo.isPrerelease}，assets=${(relInfo.assets ?? []).length}）`
      : release.state === 'no'
        ? `${TAG} 没有 Release`
        : release.why
  }`,
);
if (relInfo?.url) detail(relInfo.url);

say(`${pad('发布提交 CI 绿', 16)}${mark(ciTag.state)} ${ciTag.state === 'unknown' ? ciTag.why : `${ciTag.value}（${ciTag.why}）`}`);
detail(
  '这一条不进「完整发布」判定（npm 与 Release 都在时，包本身是完整的），但进「能不能请人 publish」判定：§7 证据④',
);
if (ciMaster.state !== 'unknown') {
  detail(`master 头上那条：${ciMaster.value}（${ciMaster.why}）`);
} 

// ── 判定（照 docs/RELEASING.md §1 的格子，规则以那张表为准） ──────────────────
const facts = {
  tag: tag === 'yes',
  master: onMaster === 'yes',
  versions: versions === 'yes',
  npm: npmPublished === 'yes',
  release: release.state === 'yes',
};
const complete = facts.tag && facts.master && facts.versions && facts.npm && facts.release;
const unknown = [tag, onMaster, versions, npmPublished, release.state].filter((s) => s === 'unknown').length;

let state;
let next;
if (complete) {
  state = 'S4 完整';
  next = '四个事实都在——只做最终核对（§9 的核对清单已由上面几行覆盖）。';
} else if (facts.tag && facts.npm && !facts.release) {
  state = 'S3 已 npm';
  next = '只走 §9：`gh release create` 补建 Release（务必带 `--verify-tag`）。';
} else if (facts.tag && !facts.npm) {
  state = 'S2 已 tag';
  next = '走 §7/§8/§9：先请人 `npm publish`，再做 §8 内容核验，最后补 Release。';
} else if (!facts.tag && facts.npm) {
  state = 'S2′ 顺序颠倒：已 npm、未 tag';
  next = '先按 §8 核验「npm 上那一版 == 哪个提交的构建产物」，再把 tag 指到**被核验过的那个提交**（不是当时 HEAD），最后补 Release；不要重新 publish。';
} else if (!facts.tag && !facts.npm) {
  // S1 vs S0: S1 means the code work is already committed (the tree is dirty or HEAD has moved past
  // the last release tag) and only the version files / tag / npm / Release are missing.
  const lastTag = gitUsable ? git(['describe', '--tags', '--abbrev=0']) : { ok: false };
  const lastTagSha = lastTag.ok && lastTag.out !== '' ? git(['rev-parse', `${lastTag.out}^{commit}`]).out : '';
  const headSha = gitUsable ? git(['rev-parse', 'HEAD']).out : '';
  const hasWork = !treeClean || (lastTagSha !== '' && lastTagSha !== headSha);
  state = hasWork ? 'S1 代码已入库' : 'S0 未开始';
  next = hasWork
    ? '先补齐 §3/§4（两处版本号 + CHANGELOG 节），再走 §6/§7/§8/§9。`npm run typecheck && npm run build && npm test` 必须全绿。'
    : '从 §3 走完整链路。';
} else {
  state = '未完整（组合不在判定表里）';
  next = '回 §1 逐条看哪一格对不上——别假设「前面那一步已经做完了」。';
}

say();
say(`判定：${state}`);
say(`还缺什么 / 下一步：${next}`);
if (unknown > 0) say(`（有 ${unknown} 条事实查不动，打了 ?——它们既不算成立也不算缺，先解决查询通道再下结论。）`);

console.log(lines.join('\n'));
if (CHECK && !complete) process.exitCode = 1;
