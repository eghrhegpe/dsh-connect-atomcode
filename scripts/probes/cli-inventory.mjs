#!/usr/bin/env node
/**
 * cli-inventory.mjs — 复核 `docs/AtomCode-CLI与daemon接口参考.md` 里那三份「N 个」清单。
 *
 * 为什么值得一个脚本：那三份清单是**手抄的**（`--help` 的转写、SPA bundle 的转写），
 * 而数字被写进了标题（18 / 28 / 21）。这类「列表 + 计数」在本仓库漂过两次——
 * `docs/README.md` 曾写「readConfig：30 个配置字段」（真值两个都不等于 30）、
 * `scripts/probes/README.md` 曾漏掉一个新探针——**同一个文件里的数字和列表也能分叉，
 * 因为读文档的人不会去数**。
 *
 * 它做三件事（只读、零额度）：
 *   1. 标题里的数字 vs 该小节列表的条目数 —— 三个小节都查；
 *   2. §1 / §2 的列表 vs 本机 `atomcode --help` / `atomcode review --help` 的**真实名字**
 *      （只比名字，不比描述：描述是人写的转述，选项名是接口面）；
 *   3. §3 的 21 个斜杠命令来自 daemon 内置 SPA 的 bundle，CLI 无法重derive ——
 *      因此只做第 1 项，并显式说明它没有被复核过，避免把「没查」当成「对」。
 *
 * 成本：**零额度**。只跑两条 `--help`（模型请求之前就退出），不启动 daemon、
 * 不发 HTTP、不写任何文件。用法：
 *
 *   node scripts/probes/cli-inventory.mjs [--binary <path>]
 *
 * `--binary` 省略时用 `$ATOMCODE_BIN`，再省略时用 `atomcode`（PATH）。
 * 退出码 0 = 一致，1 = 有漂移（打印缺的 / 多的）；二进制不存在则退出 2。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = join(ROOT, 'docs', 'AtomCode-CLI与daemon接口参考.md');

const argv = process.argv.slice(2);
const binaryArg = argv.indexOf('--binary');
const binary = binaryArg >= 0 ? argv[binaryArg + 1] : (process.env.ATOMCODE_BIN || 'atomcode');

const doc = readFileSync(DOC, 'utf8');

/**
 * 小节切分：`## N. 标题（M 个）…` 到下一个 `## ` 之前。返回 Map<编号, {title, body}>。
 */
const sections = new Map();
for (const part of doc.split(/^## /m).slice(1)) {
  const head = part.slice(0, part.indexOf('\n'));
  const dot = head.indexOf('.');
  if (dot > 0 && /^\d+$/.test(head.slice(0, dot))) {
    sections.set(head.slice(0, dot), { title: head, body: part.slice(head.length) });
  }
}

/** 标题里那个「（M 个）」。找不到就是它自己漏了计数。 */
const claimedCount = (title) => {
  const m = title.match(/（(\d+)\s*个）/);
  return m ? Number(m[1]) : null;
};

/** 小节里的第一个代码围栏。 */
const firstFence = (body) => {
  const m = body.match(/```\n([\s\S]*?)```/);
  return m ? m[1] : null;
};

/** §1：围栏里每行的第一个 token 是命令名。 */
const docCommands = (firstFence(sections.get('1').body) || '')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => line.split(/\s+/)[0]);

/**
 * §2：只看**表格行**里的 `--long-name`。不能只认整格反引号（doc 写的是
 * `` `--base <BASE>` ``，名字后面还有取值占位），也不能扫整节散文——描述里会
 * 交叉引用别的选项（`--max-duration` 那行提到 `--stream-timeout`），扫进散文就会
 * 把「引用」当成「条目」，两侧都变成噪声。
 */
const docReviewOptions = [
  ...new Set(
    sections
      .get('2')
      .body.split('\n')
      .filter((line) => line.trimStart().startsWith('|'))
      .flatMap((line) => [...line.matchAll(/(?<![\w-])--[a-z][a-z0-9-]+/g)].map((m) => m[0])),
  ),
];

/** §3：围栏里所有空白分隔的 id。 */
const docSlashCommands = (firstFence(sections.get('3').body) || '')
  .split(/\s+/)
  .map((s) => s.trim())
  .filter(Boolean);

/** 本机二进制自己的 `--help`。 */
function help(args) {
  return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function liveCommands() {
  const text = help(['--help']);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^Commands:\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    out.push(line.trim().split(/\s+/)[0]);
  }
  return out;
}

function liveReviewOptions() {
  const text = help(['review', '--help']);
  const names = new Set([...text.matchAll(/(?<![\w-])--[a-z][a-z0-9-]+/g)].map((m) => m[0]));
  names.delete('--help');
  return [...names];
}

const row = (ok, label, detail) => `${ok ? '✔' : '✖'} ${label.padEnd(34)} ${detail}`;
const diff = (expected, actual) => ({
  missing: expected.filter((x) => !actual.includes(x)),
  extra: actual.filter((x) => !expected.includes(x)),
});
const listDiff = (d) =>
  [
    d.missing.length ? `doc 有而本机无：${d.missing.join(' ')}` : '',
    d.extra.length ? `本机有而 doc 无：${d.extra.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('；');

let failed = false;
const lines = [];

// ---- 版本对照（软信号：换版本后描述漂移是合理的，但不该没人知道）----
const docVersion = (doc.match(/\*\*版本：`([^`]+)`\*\*/) || [])[1] || '(未写)';
let liveVersion = '(取不到)';
try {
  liveVersion = help(['--version']).trim().split(/\r?\n/)[0];
} catch {
  /* 二进制不可用，下面统一退出 */
}
lines.push(`doc 记的版本：${docVersion}`);
lines.push(`本机版本    ：${liveVersion}`);
if (docVersion !== liveVersion) {
  lines.push(
    '⚠️ 版本不同 —— 下面的差异可能只是版本推进，但每一处仍要人判断并更新 doc 的版本行',
  );
}
lines.push('');

// ---- §1 ----
const c1 = claimedCount(sections.get('1').title);
const d1 = diff(docCommands, liveCommands());
const ok1 = docCommands.length === c1 && d1.missing.length === 0 && d1.extra.length === 0;
failed ||= !ok1;
lines.push(
  row(
    ok1,
    '§1 atomcode 顶层命令',
    ok1
      ? `${docCommands.length} 个，标题写 ${c1}，与本机 --help 逐条一致`
      : `doc ${docCommands.length} 个（标题写 ${c1}），本机 ${liveCommands().length} 个${listDiff(d1) ? '；' + listDiff(d1) : ''}`,
  ),
);

// ---- §2 ----
const c2 = claimedCount(sections.get('2').title);
const d2 = diff(docReviewOptions, liveReviewOptions());
const ok2 = docReviewOptions.length === c2 && d2.missing.length === 0 && d2.extra.length === 0;
failed ||= !ok2;
lines.push(
  row(
    ok2,
    '§2 atomcode review 选项',
    ok2
      ? `${docReviewOptions.length} 个，标题写 ${c2}，与本机 --help 一致（--help 不计）`
      : `doc ${docReviewOptions.length} 个（标题写 ${c2}），本机 ${liveReviewOptions().length} 个${listDiff(d2) ? '；' + listDiff(d2) : ''}`,
  ),
);

// ---- §3 ----
const c3 = claimedCount(sections.get('3').title);
const ok3 = docSlashCommands.length === c3;
failed ||= !ok3;
lines.push(
  row(
    ok3,
    '§3 TUI 斜杠命令（bundle 来源）',
    ok3
      ? `${docSlashCommands.length} 个，标题写 ${c3}，列表自洽 —— ⚠️ 未被复核：来源是 SPA bundle，CLI 拿不到，只有人能从 bundle 重抄`
      : `doc ${docSlashCommands.length} 个，标题却写 ${c3}`,
  ),
);

console.log(lines.join('\n'));
console.log(
  `\n${failed ? '✖ 有漂移：上面每一行 ✖ 都要人判断是修 doc 还是修代码' : '✔ 三份清单与标题数字一致（§1/§2 另与本机 --help 对照过）'}`,
);
process.exit(failed ? 1 : 0);
