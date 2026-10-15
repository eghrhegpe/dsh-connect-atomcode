/**
 * The「回合边界」card rows — patch-only knobs and their provenance verdict.
 *
 * Moved verbatim from the pre-TypeScript `client.js`; the only edits are the de-indent,
 * the `export` keyword, and type annotations.
 */

import type { BoundaryRow, ConfigBranch } from './types.ts';

/**
 * The "回合边界" card's rows — a pure function so the honesty rule below is
 * testable without a browser.
 *
 * The rule: a patch-only knob is labelled by WHAT THE HOST SAYS ABOUT IT, not by
 * whether it happens to look default-ish. `cfg.authored` means "this value
 * DEPARTS from the plugin's shipped default" — the host decides that, because a
 * renderer only sees the resolved value and could not tell a deliberate
 * `approval_mode: bypass` from our own fallback. Comparing `askMaxRounds === 25`
 * here would also be a SECOND copy of a number `lib/index.js` owns.
 *
 * Rows are KEPT (not hidden) when at their defaults, because this is the card
 * that carries the `bypass` safety posture — silently dropping it would remove
 * the one place a user can see that AtomCode's own tools run unattended.
 *
 * @param {object|undefined} cfg the snapshot's config branch (may predate
 *   `authored` entirely — an older host, or the desktop install copy)
 */
export function turnBoundaryRows(cfg: ConfigBranch | null | undefined): BoundaryRow[] {
  const src: ConfigBranch = cfg && typeof cfg === 'object' ? cfg : {};
  const authored: NonNullable<ConfigBranch['authored']> =
    src.authored && typeof src.authored === 'object' ? src.authored : {};
  const defaults: NonNullable<ConfigBranch['defaults']> =
    src.defaults && typeof src.defaults === 'object' ? src.defaults : {};
  const askDefault = Number.isInteger(defaults.askMaxRounds) ? (defaults.askMaxRounds as number) : null;
  const approvalDefault = typeof defaults.approvalMode === 'string' ? defaults.approvalMode : '';
  const mode = typeof src.approvalMode === 'string' ? src.approvalMode : '';
  const dir = typeof src.defaultWorkingDir === 'string' ? src.defaultWorkingDir : '';
  const rounds = Number.isInteger(src.askMaxRounds) ? (src.askMaxRounds as number) : null;
  // Verdict: 'changed' | 'default' | 'unknown'.
  //
  // 'unknown' is NOT decoration — it is the only honest answer when the host
  // reports no `authored` branch AND sent no default to compare against. An
  // older host (or the desktop install copy) hands us only the RESOLVED value,
  // and `approvalMode: 'ask'` from it is either the user's choice or a build
  // whose default is 'ask' — we cannot tell. Tagging that "（插件默认）" would
  // assert what we do not know, the same class of lie as printing a guessed
  // quota number (红线 2). So when we cannot tell, we do not tag at all.
  type Verdict = 'changed' | 'default' | 'unknown';
  const verdict = (
    key: 'approvalMode' | 'workingDir' | 'askMaxRounds',
    value: unknown,
    fallback: unknown,
  ): Verdict => {
    if (authored && key in authored) return authored[key] === true ? 'changed' : 'default';
    if (fallback === null || fallback === undefined || fallback === '') return 'unknown';
    return value === fallback ? 'default' : 'changed';
  };
  const tag = (v: Verdict): string =>
    v === 'changed' ? '（已改）' : v === 'default' ? '（插件默认）' : '';
  return [
    {
      label: '审批模式',
      text: mode === '' ? '—' : mode + tag(verdict('approvalMode', mode, approvalDefault)),
      title:
        'patch 字段 approval_mode；面板上没有输入框，改它要动 cordis.patch.yml。' +
        'bypass = AtomCode 自己的工具在回合内无人值守执行（AtomCode 侧自主，与 DSH 的权限预设无关）。',
    },
    {
      label: '工作目录',
      text: dir === '' ? '（会话工作目录）' : dir + tag(verdict('workingDir', dir, null)),
      title: dir === '' ? 'patch 字段 working_dir 留空 = 靠调用参数或会话工作目录' : 'patch 字段 working_dir',
    },
    {
      label: 'ask 轮数上限',
      text:
        rounds === null
          ? '—'
          : rounds > 0
            ? String(rounds) + tag(verdict('askMaxRounds', rounds, askDefault))
            : '不限',
      title:
        'patch 字段 ask_max_rounds。超出即停止等待（不是远端 kill：daemon 侧的回合可能仍在后台跑完）。',
    },
  ];
}
