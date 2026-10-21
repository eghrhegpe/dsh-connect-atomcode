/**
 * release-artifacts.test.mjs — the two declared artifact lists must match the disk.
 *
 * WHAT THIS GUARDS. `package.json`'s `files` whitelist is what npm actually ships,
 * and the market reads `screenshots.json` for the plugin card. Both are
 * hand-written lists, and both can point at something that does not exist:
 *
 *   - a `files` entry with a typo ships a package missing a file the manifest
 *     still promises (`main`, `exports`, the client bundle) — the install looks
 *     fine until the host imports the missing path;
 *   - a screenshot path with a typo, or a file that is not an image, makes the
 *     market card break with a green build, a clean tree and a green test run.
 *
 * Three separate facts are asserted, because they fail independently:
 *   1. every `files` entry exists on disk;
 *   2. every path the manifest EXPOSES (`main` + `exports`, globs included) is
 *      covered by that whitelist — an exposed-but-unshipped path is a package
 *      that cannot be imported;
 *   3. every declared screenshot exists, is a real image (extension AND magic
 *      bytes), and fits the market's 1–8 slot.
 *
 * DELIBERATELY NOT SHIPPED — and that is pinned too. `assets/` and
 * `screenshots.json` stay OUT of `files` on purpose: the market reads them from
 * the repository root (README.md §截图, AGENTS.md 的装载方式一节,
 * RELEASING.md 的内容核验). The last assertion states that policy so that
 * "someone added them to `files`" and "someone removed them from the repo" are
 * both visible as a red test pointing at the policy note, instead of a silent
 * policy change.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** The market's plugin card accepts between one and eight screenshots. */
const SCREENSHOT_MIN = 1;
const SCREENSHOT_MAX = 8;

/** Extension → leading magic bytes. A `.png` that is really a JPEG is a red test. */
const MAGIC = [
  ['.png', [0x89, 0x50, 0x4e, 0x47]],
  ['.jpg', [0xff, 0xd8, 0xff]],
  ['.jpeg', [0xff, 0xd8, 0xff]],
  ['.gif', [0x47, 0x49, 0x46, 0x38]],
  ['.webp', [0x52, 0x49, 0x46, 0x46]],
];

/**
 * `files` entries are path PREFIXES: `lib` covers `lib/index.js`, and an entry
 * may carry a leading `./` or a trailing `/`. This is the same coverage rule the
 * market's own entry yml is read with.
 */
function coveredByFiles(rel) {
  const norm = rel.replace(/^\.\//, '');
  return (pkg.files ?? []).some((entry) => {
    const prefix = entry.replace(/^\.\//, '').replace(/\/$/, '');
    return norm === prefix || norm.startsWith(`${prefix}/`);
  });
}

/** Every string path the manifest exposes: `main`, `icon`, and every `exports` value. */
function exposedPaths() {
  const found = new Set();
  const walk = (value) => {
    if (typeof value === 'string') found.add(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
  };
  walk(pkg.main);
  walk(pkg.icon);
  walk(pkg.exports);
  return [...found];
}

describe('发版产物 — npm 包声明的内容必须在磁盘上真实存在', () => {
  it('every `files` entry exists on disk', () => {
    const missing = (pkg.files ?? []).filter((entry) => !existsSync(join(ROOT, entry)));
    // Liveness: a floor, not `missing.length >= 0` — that is true for every input
    // including an empty whitelist, so it would have proved nothing.
    assert.ok(
      (pkg.files ?? []).length >= 5,
      `expected the manifest to whitelist several paths, saw ${(pkg.files ?? []).length}`,
    );
    assert.deepEqual(
      missing,
      [],
      'package.json 的 files 白名单指向了不存在的东西——npm 包会缺文件而这里没有别的门禁：' +
        missing.join(', '),
    );
  });

  it('every path the manifest exposes is covered by `files`', () => {
    const exposed = exposedPaths();
    // Liveness: a scan that finds nothing because it read nothing is not a pass.
    assert.ok(exposed.length >= 5, `expected the manifest to expose several paths, saw ${exposed.length}`);
    // npm ALWAYS puts `package.json` in the tarball, whitelist or not — so
    // `exports["./package.json"]` is the one exposed path that does not need a
    // `files` entry. Carved out narrowly and by name, not by a pattern.
    const unshipped = exposed.filter((p) => p !== './package.json' && !coveredByFiles(p));
    assert.deepEqual(
      unshipped,
      [],
      'main/exports 暴露了路径，但 files 白名单没带上它——安装方会 import 到一个不存在的文件：' +
        unshipped.join(', '),
    );
  });

  it('the market screenshots exist, are real images, and are deliberately not shipped', () => {
    const listPath = join(ROOT, 'screenshots.json');
    assert.ok(existsSync(listPath), 'screenshots.json 是市场读的那份清单（仓库根，不是包内）');
    const declared = JSON.parse(readFileSync(listPath, 'utf8'));
    assert.ok(Array.isArray(declared), 'screenshots.json 必须是一个 JSON 数组');
    assert.ok(
      declared.length >= SCREENSHOT_MIN && declared.length <= SCREENSHOT_MAX,
      `市场卡片只接受 ${SCREENSHOT_MIN}–${SCREENSHOT_MAX} 张截图，当前 ${declared.length} 张`,
    );
    const problems = [];
    for (const rel of declared) {
      if (typeof rel !== 'string' || rel === '') {
        problems.push(`${JSON.stringify(rel)} 不是路径字符串`);
        continue;
      }
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) {
        problems.push(`${rel} 在磁盘上不存在`);
        continue;
      }
      if (!statSync(abs).isFile()) {
        problems.push(`${rel} 不是文件`);
        continue;
      }
      const rule = MAGIC.find(([ext]) => rel.toLowerCase().endsWith(ext));
      if (!rule) {
        problems.push(`${rel} 的扩展名不在市场允许的图片类型里（${MAGIC.map(([e]) => e).join(' ')}）`);
        continue;
      }
      const head = readFileSync(abs).subarray(0, rule[1].length);
      if (!rule[1].every((byte, i) => head[i] === byte)) {
        problems.push(`${rel} 的扩展名说是 ${rule[0]}，内容却对不上（magic bytes）`);
      }
      // The deliberate half: the market reads the repo root, so these must NOT ship.
      if (coveredByFiles(rel) || coveredByFiles('screenshots.json')) {
        problems.push(
          `${rel} / screenshots.json 出现在 files 白名单里——本插件的截图是「仓库根可见、不进 npm 包」的既有策略` +
            '（README.md §截图、RELEASING.md 的内容核验）；改策略就要同步改这里与那两处说明',
        );
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });
});
