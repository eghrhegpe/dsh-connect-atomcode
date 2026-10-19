/**
 * provider-select.ts — the model dropdown row, and the reasoning-effort dropdown
 * beside it.
 *
 * Split out of `src/client/index.ts` alongside ./panel-controls.ts: those two were
 * the last inline components declared inside the factory, and the factory's job is
 * assembly (seats, transport, the shared stats cache), not rendering. See the
 * module header of ./status-section.ts for the same reasoning, already applied
 * there.
 *
 * WHY IT IS A `createProviderSelect(deps)` FACTORY AND NOT A PLAIN COMPONENT: the
 * client half gets React from the loader at FACTORY time (`require('react')`), and
 * it must be the app's own instance — a module that called `require('react')` for
 * itself could bind a second copy and break hooks. So `h` and the hooks are
 * INJECTED by the assembly point rather than imported here. What this file imports
 * directly is only what is React-free: `S`, and the pure formatters in `rows.ts`.
 *
 * Nothing about the component itself moved with the file: same props, same hooks in
 * the same order, same render. `test/client-render.test.mjs` drives `useState` from
 * a call-order script across the whole render, so what it can see is the call
 * SEQUENCE — and this component's place in the tree is unchanged.
 *
 * @module dsh-connect-atomcode/client/provider-select
 */
import type { ReactElement } from 'react';
import { S } from './styles.ts';
import { providerSelectModel } from './rows.ts';
import type { ProviderBranch } from './types.ts';

// Reasoning-effort is the only panel control the user asked "why can't I change
// it" about: the write route has existed since the first version but nothing in
// the client ever POSTed to it, so the old "力度: low / high（当前 high）" line
// read as a control the user could not use.
const EFFORT_TITLE = '推理力度：模型每轮思考的深度。low 更快更省额度、high 更深入。选一个会让 daemon 记下来，之后的咨询默认用它；也可以在某一次咨询时临时传 reasoning_effort 覆盖';

/**
 * Everything `ProviderSelectRow` needs that is bound to the app's React instance or
 * to the factory's closure. Injected, never imported — see the module header.
 */
export interface ProviderSelectDeps {
  h: (type: any, props?: any, ...children: any[]) => ReactElement;
  useState: <T>(initial: T) => [T, (value: T | ((prev: T) => T)) => void];
  /** The provider write (`POST /provider`), echoing the branch the server stored. */
  postProvider: (value: string) => Promise<{ ok: boolean; provider?: any; error?: string }>;
  /** The reasoning-effort write (`POST /reasoning-effort`); no echo to adopt. */
  postReasoningEffort: (effort: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Adopt the server's echo into the shared cache, so the controlled `<select>`
   * does not bounce back to the stale value for up to POLL_MS.
   */
  adoptProviderSnapshot: (provider: any) => boolean;
}

/**
 * Build the model dropdown row.
 *
 * @param {ProviderSelectDeps} deps
 * @returns {(props: any) => ReactElement} the `ProviderSelectRow` component.
 */
export function createProviderSelect(deps: ProviderSelectDeps) {
  const { h, useState, postProvider, postReasoningEffort, adoptProviderSnapshot } = deps;

  /**
   * The interactive provider control: a dropdown over the ONE model ladder.
   *
   * There used to be two of these — ask listed daemon model profiles, review
   * listed config.toml direct entries, and 红线 8 existed to keep them from
   * being read as one knob. The review namespace died with its CLI, so the
   * panel shows one control for the one ladder both entry points climb.
   *
   * Pending/error state is local, and the control is never swapped back to static
   * text — a failed write must stay visible with its reason, or the user cannot
   * tell "the plugin refused" from "my click did nothing".
   */
  function ProviderSelectRow({
    label,
    provider,
    fallbackLabel,
    title,
    reload,
  }: {
    label: string;
    provider: ProviderBranch | undefined;
    fallbackLabel: string;
    title?: string;
    reload?: () => void;
  }) {
    const model = providerSelectModel(provider, fallbackLabel);
    const [note, setNote] = useState('');
    const [pending, setPending] = useState(false);
    // Reasoning-effort write state — separate from `note` so a provider-write
    // failure cannot overwrite an effort-write failure (and vice versa).
    const [effortPending, setEffortPending] = useState(false);
    const [effortError, setEffortError] = useState('');
    const effortLevels = model.effortLevels && model.effortLevels.length > 0 ? model.effortLevels : [];
    const currentEffort = typeof model.currentEffort === 'string' ? model.currentEffort : '';
    // The daemon's /live/reasoning_effort only SETS a level; there is no
    // "clear" verb. So when the current value is unknown (null — the daemon
    // has not been told, or the provider was just switched) we show a
    // disabled placeholder instead of fabricating a level the model is not on.
    const effortHasCurrent = effortLevels.indexOf(currentEffort) >= 0;
    const effortValue = effortHasCurrent ? currentEffort : '';
    const onEffortChange = async (event: any) => {
      const value = event && event.target ? event.target.value : '';
      if (value === '' || value === currentEffort) return; // no-op / placeholder
      setEffortPending(true);
      setEffortError('');
      const result = await postReasoningEffort(value);
      setEffortPending(false);
      if (!result.ok) {
        setEffortError('保存失败：' + result.error);
        return;
      }
      if (typeof reload === 'function') void reload();
    };
    const onChange = async (event: any) => {
      const value = event && event.target ? event.target.value : '';
      setPending(true);
      setNote('');
      const result = await postProvider(value);
      setPending(false);
      if (!result.ok) {
        setNote('保存失败：' + result.error);
        return;
      }
      // NO "已选 X" on success. The dropdown itself now shows X — that IS the
      // confirmation, and printing it again under the control was the last piece
      // of "每格都挂一句话" the user objected to. Only a FAILURE needs words,
      // because a failure has nowhere else to show up.
      //
      // Which is exactly why the dropdown must actually MOVE: adopt the
      // server's answer first, then reload, or the controlled `<select>` gets
      // re-rendered from the stale cache and bounces back for up to POLL_MS.
      adoptProviderSnapshot(result.provider);
      if (typeof reload === 'function') void reload();
    };
    // `note` is a pre-worded sentence about the effective value (see
    // providerSelectModel). It is empty when there is nothing to say —
    // narrating "this came from the panel" next to the user's own click was
    // decoration, and it made every row two lines tall.
    const override = model.note;
    const trouble = model.disabled ? model.reason : '';
    // A capacity kept for a sentence nothing writes yet: `warning` carried
    // the loopback dependency note ("this pick bills through a local
    // sidecar"), and its producer died with the review CLI — see
    // `providerSelectModel`. Should a producer return, it renders in the SAME
    // style as trouble (both say "read this before you rely on this
    // control") while NOT being a disabled reason: the control still works.
    const warning = model.warning || '';
    // `warning` and `override` answer two different questions — what this
    // pick DEPENDS ON vs which layer actually won — but both are "read this
    // before you rely on this control", so they share ONE line, separated
    // by ` · `. Stacked, they made the card grow a second line; keeping them
    // on one line is what stops that from coming back with the next producer.
    // `trouble` keeps a line of its own: the control is unusable, and that
    // outranks both.
    const advisory = [warning, override].filter((part) => part !== '').join(' · ');
    return h(
      'div',
      { style: S.provCell },
      h(
        'div',
        { style: S.provFieldRow },
        h('span', { style: S.provLabel, title }, label),
        h(
          'select',
          {
            style: { ...(model.disabled || pending ? { ...S.select, ...S.selectOff } : S.select), flex: '1 1 auto', minWidth: 0 },
            value: model.value,
            disabled: model.disabled || pending,
            onChange,
            title: trouble || override || warning || title,
            'aria-label': label,
          },
          model.options.map((option, index) =>
            h('option', { key: 'prov-' + index, value: option.value }, option.label)
          )
        )
      ),
      trouble ? h('span', { style: S.valWarn, title: trouble }, trouble) : null,
      advisory ? h('span', { style: S.valWarn, title: advisory }, advisory) : null,
      note ? h('span', { style: S.valIdle }, note) : null,
      // The effort control: a dropdown over the SELECTED model's legal levels.
      // This replaces the old read-only "力度: low / high（当前 high）" line.
      // It stays a separate row from the model dropdown because the levels are
      // a property of the pick above it — merging them would read as "the pick
      // controls the depth", when in fact the model controls the levels and
      // this control sets the daemon's persistent one.
      effortLevels.length > 0
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h(
              'div',
              { style: S.provFieldRow },
              h('span', { style: S.provLabel, title: EFFORT_TITLE }, '推理力度'),
              h(
                'select',
                {
                  style: { ...(effortPending ? { ...S.select, ...S.selectOff } : S.select), flex: '1 1 auto', minWidth: 0 },
                  value: effortValue,
                  disabled: effortPending,
                  onChange: onEffortChange,
                  title: EFFORT_TITLE,
                  'aria-label': '推理力度',
                },
                effortLevels
                  .map((level) => h('option', { key: 'effort-' + level, value: level }, level))
                  // The daemon's /live/reasoning_effort has no "clear" verb, so
                  // when the current value is unknown (never set, or the
                  // provider was just switched) we show a disabled placeholder
                  // rather than fabricate a level the model is not on.
                  .concat(
                    effortHasCurrent
                      ? []
                      : [h('option', { key: 'effort-unset', value: '', disabled: true }, '未设置')]
                  )
              )
            ),
            effortError ? h('span', { style: S.valWarn }, effortError) : null
          )
        : null
    );
  }
  return ProviderSelectRow;
}
