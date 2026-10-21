/**
 * release-consistency.test.mjs — 发版链自己的离线门禁。
 *
 * 为什么存在。仓库其它纪律都有可执行的门禁（`build-gate` 逐字节比产物、`docs-code-map` 比代码地图、
 * `docs-integrity` 比文档引用、`wiring` 比两处版本号），唯独**发版链**只有 `RELEASING.md` 的散文
 * 加一份给人勾选的清单。2026-10-17 那次 0.4.3 发版就是那样漏的：tag 推了、npm 发了、Release 没建，
 * 而清单把 CI 绿写成了「推荐」——**读过了不会报错**。凡是「只能靠人记得」的步骤，就会漏第二次。
 *
 * 这个套件补的是**离线**那一半：不需要网络、不需要 gh、不需要凭据，因此在 CI 与任何一台开发机上都能跑。
 *
 * 断言的是**不变量**，不是散文：
 *   1. `CHANGELOG.md` 里最新的版本节必须是 `package.json` 的版本（§4：先写条目再 publish）。
 *   2. 若本地存在该版本的 tag，`package.json` 在**那个 tag 的提交上**必须就是同一个版本
 *      —— 这钉的是 §2 不可逆点 4 那个坑：tag 指到了错误的提交，而"发出去的内容"永远追不回来。
 *
 * 刻意**不**做的事：不查 npm 是否已发、不查 Release 是否存在、不查 CI 结论。那些是**需要网络的事实**，
 * 只能是 `scripts/release-status.mjs` 的输出（本仓库的测试不许联网）。这个套件只保证「仓库内可自证的部分」
 * 不会说谎；两者合起来才是 `RELEASING.md` §1 判定表的可执行版本。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

/**
 * Read-only git. Returns `null` when git is unavailable, the checkout is not a repository, or the
 * command fails — all of which mean "this fact cannot be established here", never "the fact is false".
 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

describe('发版一致性 — 版本自洽（离线能自证的部分）', () => {
  it('CHANGELOG 里最新的版本节就是 package.json 的版本', () => {
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const newest = changelog.match(/^##\s+(\d+\.\d+\.\d+)/m)?.[1] ?? null;
    assert.equal(
      newest,
      VERSION,
      `package.json 是 ${VERSION}，而 CHANGELOG 里最新的版本节是 ${newest}：` +
        '§4 要求发版前先把这一版的条目写好再 publish——没写就发，市场渲染出来的更新日记会停在上一版，' +
        '而 npm 上的内容不可覆盖。',
    );
  });

  it('若本地存在该版本的 tag，它在那个提交上必须也是同一个版本', (t) => {
    const tag = `v${VERSION}`;
    const sha = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
    if (sha === null) {
      // 浅克隆（CI 默认只取一个提交）、源码压缩包、或本来还没打 tag——这里没有可查的事实。
      t.skip(`本地没有 ${tag} 这个 tag：这一半自动跳过（不是失败）`);
      return;
    }
    const atTag = git(['show', `${tag}:package.json`]);
    assert.notEqual(atTag, null, `${tag} 存在，但读不到它那个提交上的 package.json——tag 可能指向一个已被改写的历史`);
    assert.equal(
      JSON.parse(atTag).version,
      VERSION,
      `${tag} 指向的提交里 package.json 是另一个版本：tag 与版本文件分叉了。` +
        `§2 不可逆点 4 说的就是这个——publish 之后取证责任在你身上（§8），别移动 tag，开下一个版本号。`,
    );
  });
});
