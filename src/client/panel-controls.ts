/**
 * panel-controls.ts — the four editable rows of the detail panel: review brief
 * mode, the working directory, the approval mode, and the ask round cap.
 *
 * Split out of `src/client/index.ts` alongside ./provider-select.ts. Same
 * reasoning as ./status-section.ts, whose module header records it in full.
 *
 * WHY IT IS A `createPanelControls(deps)` FACTORY AND NOT A PLAIN COMPONENT: see
 * ./provider-select.ts — `h` and the hooks come from the app's own React instance,
 * which only the factory holds. `S` and the two `rows.ts` verdict helpers are
 * React-free and imported directly.
 *
 * Every row here overrides a patch field at execution time (panel-settings.json),
 * so a click takes effect on the very next turn. `null` is always the value that
 * means "no override, the patch value applies" — never an empty string, which the
 * route would read as "clear it".
 *
 * @module dsh-connect-atomcode/client/panel-controls
 */
import type { ReactElement } from 'react';
import { S } from './styles.ts';
import { boundaryTag, boundaryVerdict } from './rows.ts';
import { APPROVAL_MODES, REVIEW_BRIEF_MODES } from '../shared/closed-sets.ts';

/**
 * Everything `PanelSettingsControls` needs that is bound to the app's React
 * instance or to the factory's closure. Injected, never imported — see the module
 * header.
 */
export interface PanelControlsDeps {
  h: (type: any, props?: any, ...children: any[]) => ReactElement;
  useState: <T>(initial: T) => [T, (value: T | ((prev: T) => T)) => void];
  /**
   * The working-dir input syncs its local value off the last SERVER value it has
   * seen, so a poll arriving mid-edit does not stomp the user's keystrokes.
   */
  useRef: <T>(initial: T) => { current: T };
  /** The panel-settings write (`POST /panel-settings`), one field at a time. */
  postPanelSettings: (fields: Record<string, any>) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Build the panel-settings controls.
 *
 * @param {PanelControlsDeps} deps
 * @returns {(props: any) => ReactElement} the `PanelSettingsControls` component.
 */
export function createPanelControls(deps: PanelControlsDeps) {
  const { h, useState, useRef, postPanelSettings } = deps;

  /**
   * The panel-settings controls: a brief-mode dropdown and a working-dir input.
   *
   * These override the patch fields at execution time (panel-settings.json),
   * so a click takes effect on the very next turn — no reload needed. The
   * current values come from the stats snapshot (`config.panelBriefMode`,
   * `config.panelWorkingDir`); `null` means "no override, patch value applies".
   *
   * P1 fix: the working-dir input is LOCAL-STATE driven (seeded from the
   * server value when it changes), so focus+blur without typing does NOT
   * POST null. A save only fires when the value differs from the current
   * server value. An explicit clear (empty string + save button click) is
   * the only way to remove the override.
   */
  function PanelSettingsControls({
    cfg,
    reload,
  }: {
    cfg: any;
    reload?: () => void;
  }) {
    // P2 fix: every row owns its pending/error pair. The approval and rounds
    // rows used to reuse the brief row's `briefPending`/`briefError`: a failed
    // approval save printed 「保存失败」 under the WRONG row (the brief row's
    // span), and a pending brief save disabled every other control. Now each
    // row disables only itself and reports under itself.
    const [briefPending, setBriefPending] = useState(false);
    const [briefError, setBriefError] = useState('');
    const [dirPending, setDirPending] = useState(false);
    const [dirError, setDirError] = useState('');
    const [approvalPending, setApprovalPending] = useState(false);
    const [approvalError, setApprovalError] = useState('');
    const [roundsPending, setRoundsPending] = useState(false);
    const [roundsError, setRoundsError] = useState('');

    // The dropdown options come from the shared closed sets (../shared/closed-sets.ts) —
    // the same lists the host validates against. They used to be spelled out
    // here a third time, so a new daemon mode had to be edited in three files.
    const briefModes = REVIEW_BRIEF_MODES;
    const approvalModes = APPROVAL_MODES;
    const currentBrief = cfg && typeof cfg.panelBriefMode === 'string' ? cfg.panelBriefMode : '';
    const currentDir = cfg && typeof cfg.panelWorkingDir === 'string' ? cfg.panelWorkingDir : '';
    const currentApproval = cfg && typeof cfg.panelApprovalMode === 'string' ? cfg.panelApprovalMode : '';
    const currentRounds = cfg && typeof cfg.panelAskMaxRounds === 'number' ? cfg.panelAskMaxRounds : '';
    const currentRoundsStr = currentRounds === '' ? '' : String(currentRounds);

    // "你改过没有" — the same wording the read-only rows used before these
    // controls replaced them (./rows.ts boundaryTag). Without this the panel
    // stops saying whether a value is the user's own choice or the shipped
    // default, and a stock `bypass` installation reads as "someone set this".
    // The host answers via `cfg.authored`, exactly as the read-only rows asked
    // it; the resolved value and the shipped default are the same two inputs.
    const tagFor = (
      key: 'approvalMode' | 'workingDir' | 'askMaxRounds' | 'reviewBriefMode',
      resolved: unknown,
      shippedDefault: unknown,
    ) => {
      const authored = cfg && cfg.authored && typeof cfg.authored === 'object' ? cfg.authored : null;
      return boundaryTag(boundaryVerdict(authored, key, resolved, shippedDefault));
    };
    const tagStyle = { color: '#9aa1ac', fontSize: 10, fontWeight: 'normal' as const, marginLeft: 4 };

    // Local editing state for the working-dir input, seeded from the server
    // value. Syncs when the server value changes (a poll or a successful
    // write from elsewhere), so the input always reflects the latest state.
    const [dirValue, setDirValue] = useState(currentDir);
    const lastServerDir = useRef(currentDir);
    if (currentDir !== lastServerDir.current) {
      lastServerDir.current = currentDir;
      setDirValue(currentDir);
    }

    // P2 fix: the rounds input now mirrors the dir input's server-sync. It
    // used to hold local state seeded ONCE — a poll that carried a new
    // `panelAskMaxRounds` (a write from the other profile, a reload after a
    // save elsewhere) left the input showing the stale typed value.
    const [roundsValue, setRoundsValue] = useState(currentRoundsStr);
    const lastServerRounds = useRef(currentRounds);
    if (currentRounds !== lastServerRounds.current) {
      lastServerRounds.current = currentRounds;
      setRoundsValue(currentRoundsStr);
    }

    const onBriefChange = async (event: any) => {
      const value = event && event.target ? event.target.value : '';
      if (value === currentBrief) return; // no-op: already the server value
      setBriefPending(true);
      setBriefError('');
      const result = await postPanelSettings({ briefMode: value === '' ? null : value });
      setBriefPending(false);
      if (!result.ok) {
        setBriefError('保存失败：' + result.error);
        return;
      }
      if (typeof reload === 'function') void reload();
    };

    /** Only saves when the value differs from the current server state. */
    const saveDir = async () => {
      const trimmed = dirValue.trim();
      if (trimmed === currentDir) return; // no change: do NOT post (prevents focus+blur clear)
      setDirPending(true);
      setDirError('');
      const result = await postPanelSettings({ workingDir: trimmed === '' ? null : trimmed });
      setDirPending(false);
      if (!result.ok) {
        setDirError('保存失败：' + result.error);
        return;
      }
      if (typeof reload === 'function') void reload();
    };

    const onApprovalChange = async (event: any) => {
      const value = event && event.target ? event.target.value : '';
      if (value === currentApproval) return; // no-op: already the server value
      setApprovalPending(true);
      setApprovalError('');
      const result = await postPanelSettings({ approvalMode: value === '' ? null : value });
      setApprovalPending(false);
      if (!result.ok) {
        setApprovalError('保存失败：' + result.error);
        return;
      }
      if (typeof reload === 'function') void reload();
    };

    /** Only saves when the value differs from the current server state. */
    const saveRounds = async () => {
      if (roundsValue === currentRoundsStr) return; // no-op: compare the STRING form
      setRoundsPending(true);
      setRoundsError('');
      const num = roundsValue === '' ? null : parseInt(roundsValue, 10);
      const next = num === null || Number.isNaN(num) ? null : num;
      const result = await postPanelSettings({ askMaxRounds: next });
      setRoundsPending(false);
      if (!result.ok) {
        setRoundsError('保存失败：' + result.error);
        return;
      }
      if (typeof reload === 'function') void reload();
    };

    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      // Brief mode — inline editable row, replaces the old read-only row
      h(
        'div',
        { style: S.provCell },
        h(
          'div',
          { style: S.provFieldRow },
          h('span', { style: S.provLabel, title: '这里的选择优先于插件配置（cordis.patch.yml）里 review_brief_mode；选「不覆盖」就回到配置值。含义：代码评审时是否自动补一段评审提示词' }, '评审时自动补提示词'),
          h('span', { style: tagStyle }, tagFor('reviewBriefMode', cfg && cfg.reviewBriefMode, cfg && cfg.defaults && cfg.defaults.reviewBriefMode)),
          h(
            'select',
            {
              style: { ...(briefPending ? { ...S.select, ...S.selectOff } : S.select), flex: '1 1 auto', minWidth: 0 },
              value: currentBrief,
              disabled: briefPending,
              onChange: onBriefChange,
              'aria-label': '评审时自动补提示词',
            },
            h('option', { value: '' }, '不覆盖（用配置 ' + (cfg && typeof cfg.reviewBriefMode === 'string' ? cfg.reviewBriefMode : '默认') + '）'),
            briefModes.map((m) => h('option', { key: m, value: m }, m))
          )
        )
      ),
      briefError ? h('span', { style: S.valWarn }, briefError) : null,
      // Working directory — inline editable row, replaces the old read-only row
      h(
        'div',
        { style: S.provCell },
        h(
          'div',
          { style: S.provFieldRow },
          h('span', { style: S.provLabel, title: '这里填的文件夹优先于插件配置里的默认目录；清空并保存 = 不覆盖，改回用配置值或本次会话目录。AtomCode 会在你填的这个文件夹里读文件、跑 git' }, 'AtomCode 干活的文件夹'),
          h('span', { style: tagStyle }, tagFor('workingDir', cfg && cfg.defaultWorkingDir, null)),
          h(
            'div',
            { style: { display: 'flex', gap: 4, flex: '1 1 auto', minWidth: 0 } },
            h('input', {
              style: { ...S.select, flex: '1 1 auto', minWidth: 0, padding: '2px 6px', fontSize: 12 },
              value: dirValue,
              placeholder: currentDir || '不覆盖（用配置/会话目录）',
              disabled: dirPending,
              onChange: (e: any) => setDirValue(e.target ? e.target.value : ''),
              onKeyDown: (e: any) => { if (e.key === 'Enter') saveDir(); },
              'aria-label': 'AtomCode 干活的文件夹（面板覆盖）',
            }),
            h('button', {
              style: { ...S.select, width: 'auto', flex: '0 0 auto', fontSize: 11, cursor: dirPending ? 'wait' : 'pointer', whiteSpace: 'nowrap' },
              disabled: dirPending || dirValue.trim() === currentDir,
              onClick: saveDir,
            }, dirPending ? '…' : '保存')
          )
        )
      ),
      dirError ? h('span', { style: S.valWarn }, dirError) : null,
      // Approval mode — inline editable row
      h(
        'div',
        { style: S.provCell },
        h(
          'div',
          { style: S.provFieldRow },
          h('span', { style: S.provLabel, title: '这里的选择优先于插件配置里的 approval_mode；选「不覆盖」就回到配置值。含义：AtomCode 自动执行工具时受多大限制。注意：当前 daemon 对后台调用一律自动放行，切换这里实际不改变行为' }, 'AtomCode 自动执行权限'),
          h('span', { style: tagStyle }, tagFor('approvalMode', cfg && cfg.approvalMode, cfg && cfg.defaults && cfg.defaults.approvalMode)),
          h(
            'select',
            {
              style: { ...(approvalPending ? { ...S.select, ...S.selectOff } : S.select), flex: '1 1 auto', minWidth: 0 },
              value: currentApproval,
              disabled: approvalPending,
              onChange: onApprovalChange,
              'aria-label': 'AtomCode 自动执行权限',
            },
            h('option', { value: '' }, '不覆盖（用配置 ' + (cfg && typeof cfg.approvalMode === 'string' ? cfg.approvalMode : 'bypass') + '）'),
            approvalModes.map((m) => h('option', { key: m, value: m }, m))
          )
        )
      ),
      approvalError ? h('span', { style: S.valWarn }, approvalError) : null,
      // Ask max rounds — inline editable row
      h(
        'div',
        { style: S.provCell },
        h(
          'div',
          { style: S.provFieldRow },
          h('span', { style: S.provLabel, title: '这里填的数字优先于插件配置里的 ask_max_rounds；0 = 不设上限（交给 daemon 治理）；留空 = 不覆盖。含义：一次「问 AtomCode」最多让它自己循环多少轮' }, '单次咨询最多轮数'),
          h('span', { style: tagStyle }, tagFor('askMaxRounds', cfg && cfg.askMaxRounds, cfg && cfg.defaults && cfg.defaults.askMaxRounds)),
          h(
            'div',
            { style: { display: 'flex', gap: 4, flex: '1 1 auto', minWidth: 0 } },
            h('input', {
              style: { ...S.select, flex: '1 1 auto', minWidth: 0, padding: '2px 6px', fontSize: 12 },
              value: roundsValue,
              placeholder: '不覆盖（' + (cfg && typeof cfg.askMaxRounds === 'number' ? cfg.askMaxRounds : '25') + '）',
              disabled: roundsPending,
              type: 'number',
              min: 0,
              max: 1000,
              onChange: (e: any) => setRoundsValue(e.target ? e.target.value : ''),
              onKeyDown: (e: any) => { if (e.key === 'Enter') saveRounds(); },
              'aria-label': '单次咨询最多轮数',
            }),
            h('button', {
              style: { ...S.select, width: 'auto', flex: '0 0 auto', fontSize: 11, cursor: roundsPending ? 'wait' : 'pointer' },
              disabled: roundsPending || roundsValue === currentRoundsStr,
              onClick: saveRounds,
            }, roundsPending ? '…' : '保存')
          )
        )
      ),
      roundsError ? h('span', { style: S.valWarn }, roundsError) : null,
    );
  }
  return PanelSettingsControls;
}
