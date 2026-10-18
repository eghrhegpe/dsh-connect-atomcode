/**
 * dsh-connect-atomcode — Client half (renderer).
 *
 * Registers a `plugins.bundle.config` slot on this plugin's detail page that
 * surfaces live startup/usage statistics, polled over the host's read-only
 * same-origin route `/api/atomcode-bridge/stats` (see src/host/index.ts).
 *
 * This is the SOURCE of the committed IIFE artifact `client.js` (pnpm refuses to
 * build git-dep bundles, so the artifact is committed — see tsdown.config.mjs).
 * The factory receives the loader's `require` and returns `{ inject, apply }`,
 * mirroring the dsh-connect-sensenova-token-plan client contract: React is
 * obtained at factory time via `require("react")` so the same instance the app
 * uses backs every component.
 *
 * @module dsh-connect-atomcode/client
 */
import type { ReactElement } from 'react';
import type { ProviderBranch } from './types.ts';
import { S } from './styles.ts';
import {
  barWidth,
  fmtCountdown,
  fmtDuration,
  liveRemaining,
  pctLabel,
  quotaColor,
  quotaFacts,
  quotaView,
  panelStyle,
} from './quota.ts';
import {
  inFlightText,
  providerRows,
  providerSelectModel,
  turnBoundaryRows,
  isLoopbackEndpoint,
  daemonStatusLine,
  protocolDriftNotice,
  messageTextOf,
} from './rows.ts';
import { createStatusSection } from './status-section.ts';
import { createQuotaChip } from './quota-chip.ts';
import { createReviewHandoff } from './review-handoff.ts';
import { createMessageAsk } from './message-ask.ts';

// The loader hands the factory an untyped `require`; the host resolves
// `react` from the web boot's seed table.
type LoaderRequire = (id: string) => any;

const REGISTRATION = {
  // MUST equal this package's name verbatim: the Host keys client-module
  // factories by package name and resolves the row as `factories.has(id)`.
  // Any other id loads without registering and fails the web boot audit.
  id: 'dsh-connect-atomcode',
  factory: function (require: LoaderRequire) {
    const react = require('react');
    const h = react.createElement;
    const useState = react.useState;
    const useEffect = react.useEffect;
    const useRef = react.useRef;
    const useCallback = react.useCallback;

    // Seed modules of the web boot's static table (see `dsh-web-frontend`'s
    // `staticModules`): `react-dom` and `@deepseek-ai/dsh-client-ui-primitives`
    // are both delivered to every factory's `require`, so the quota panel can
    // use the official Tooltip / anchoring hooks WITHOUT declaring a
    // `dsh.client.inject` entry. Declaring one would be the documented-but-
    // unverifiable route (a sibling plugin's AGENTS.md warns that declaring
    // inject is not evidence the package resolves).
    //
    // Required defensively anyway: a factory that throws fails to
    // materialize and takes its CONSUMER down with it, so a host without
    // these two degrades to the native-tooltip chip (`QuotaChipDegraded`, picked
    // at factory time — see QUOTA_READOUT) instead of failing to mount.
    let reactDom: any = null;
    let primitives: any = null;
    try {
      reactDom = require('react-dom');
    } catch (error) {
      /* no portal available — the chip falls back to a native title */
    }
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      /* no anchoring hooks — same fallback */
    }

    const STATS_PATH = '/api/atomcode-bridge/stats';
    // The plugin's OWN write endpoint for the model dropdowns. It persists to
    // `$DSH_HOME/state/dsh-connect-atomcode/provider.json` — never to
    // ~/.atomcode/config.toml, which stays read-only for us (AGENTS.md 红线 8).
    const PROVIDER_PATH = '/api/atomcode-bridge/provider';
    const POLL_MS = 5000;

    // ── Module-level shared stats cache ────────────────────────────────────
    //
    // Without this, every open session mounts its own useStats() and polls
    // /api/atomcode-bridge/stats independently — 20 sessions = 4 req/s to the
    // DSH host, each carrying a sessions.count() disk read. The cache lets
    // all component instances share one fetch: the first caller initiates,
    // others await the same promise, and a fresh result is reused within
    // POLL_MS.
    interface StatsCache {
      data: any;
      error: any;
      fetchedAt: number;
      promise: Promise<void> | null;
      /** When the in-flight `promise` was STARTED — see `adoptedProvider`. */
      promiseStartedAt: number;
    }
    let statsCache: StatsCache = { data: null, error: null, fetchedAt: 0, promise: null, promiseStartedAt: 0 };

    /**
     * The provider branch adopted from a write's own response, and WHEN.
     *
     * A poll that was already in flight when the click landed answers with a
     * snapshot the server built BEFORE the write reached it. Without re-applying
     * the adopted branch on top of that answer, the stale one wins the next
     * `commit()` and the dropdown bounces back anyway — the same bug, one race
     * narrower. The timestamp is what tells "this answer predates the click"
     * from "this answer already includes it".
     */
    let adoptedProvider: { branch: Record<string, unknown>; at: number } | null = null;

    const TESTABLE = {
      fmtDuration,
      fmtCountdown,
      quotaColor,
      liveRemaining,
      pctLabel,
      barWidth,
      quotaFacts,
      panelStyle,
      quotaView,
      providerRows,
      providerSelectModel,
      turnBoundaryRows,
      inFlightText,
      isLoopbackEndpoint,
      daemonStatusLine,
      protocolDriftNotice,
      providerBranchOf,
      snapshotWithBranch,
      // The message's text, pulled from the chat projection by messageId —
      // pure, so the 锐评 button's whole read path is testable without React.
      messageTextOf,
      // The hand-off factory, so a test can drive `requestReview`'s prefill
      // contract (and each of its three named failures) with no component tree.
      createReviewHandoff,
      // The surviving half of the old popover: a button that reads the rendered
      // reply and calls `requestReview`. Exposed for the same reason — its whole
      // contract is testable without a React tree.
      createMessageAsk,
    };

    /**
     * Fold a successful write's OWN answer into the shared snapshot, before the
     * reload that follows it.
     *
     * `POST /provider` answers with the recomputed `provider` branch — the value
     * the server just accepted (`routes.ts`) — and `reload` is `load()`, whose
     * first line commits the CACHED snapshot while it is still fresh (within
     * POLL_MS). So without this, the click's own reload re-rendered the panel
     * from the pre-click snapshot: `ProviderSelectRow`'s `<select>` is
     * controlled (`value: model.value`), so React snapped the dropdown back to
     * the old pick and held it there until the next 5s poll — up to five
     * seconds in which the control looks like it ignored the click, with no
     * text anywhere saying the write succeeded (the "已选 X" line was removed
     * deliberately: only a failure needs words). Data already in hand was being
     * thrown away.
     *
     * Replacing `statsCache.data` with a NEW object — rather than mutating it —
     * is load-bearing: `commit()` calls `setData(statsCache.data)`, and React
     * bails out of a state update whose value is identical by reference, so an
     * in-place mutation would publish new content and no re-render.
     *
     * @returns {boolean} whether the snapshot actually changed.
     */
    /**
     * The provider branch a write's response carries, or null when it carries
     * none.
     *
     * It is taken whole rather than pieced together: the server recomputes
     * `effective`/`source`/`catalog` for the entire ladder, so adopting its
     * answer keeps the one dropdown reading from the snapshot the server just
     * justified.
     *
     * There used to be TWO branches here (`ask` and `review`, one per provider
     * namespace). The review namespace died with its CLI, and the host now
     * answers with one flat branch, so this reads that branch directly — a
     * leftover loop over slot names would have found nothing in the new shape
     * and silently adopted no update at all.
     */
    function providerBranchOf(provider: any): Record<string, unknown> | null {
      if (!provider || typeof provider !== 'object') return null;
      // The route answers `{ok, provider: {panel, effective, ...}}`; the older
      // shape nested those under a slot name. Both end up here as "does the
      // payload carry step fields", never as "which slot was it".
      const branch = provider.provider && typeof provider.provider === 'object' ? provider.provider : provider;
      const hasStep = ['panel', 'effective', 'config'].some((key) => key in branch)
        || ('catalog' in branch)
        || ('storePath' in branch);
      return hasStep ? branch : null;
    }

    /**
     * One snapshot plus an adopted branch in, the NEXT snapshot out — a NEW
     * object.
     *
     * "New object" is the whole point: `commit()` calls `setData(statsCache.data)`
     * and React bails out of a state update whose value is identical by
     * reference, so mutating the cached snapshot in place would publish new
     * content and no re-render — the dropdown would stay where it was.
     *
     * Kept pure and split from `adoptProviderSnapshot` so it can be asserted
     * offline: this bug lived between a network round-trip and a React commit,
     * which is exactly the seam no DOM-free suite could reach before.
     */
    function snapshotWithBranch(current: any, branch: Record<string, unknown>): any | null {
      if (!current) return null;
      return { ...current, provider: { ...(current.provider || {}), ...branch } };
    }

    function adoptProviderSnapshot(provider: any): boolean {
      const branch = providerBranchOf(provider);
      const next = branch ? snapshotWithBranch(statsCache.data, branch) : null;
      if (!next || !branch) return false;
      adoptedProvider = { branch, at: Date.now() };
      statsCache.data = next;
      return true;
    }

    /** Re-apply the adopted branch over an answer a pre-click poll just delivered. */
    function reapplyAdoptedProvider(startedAt: number): void {
      if (!adoptedProvider || adoptedProvider.at <= startedAt) return;
      const next = snapshotWithBranch(statsCache.data, adoptedProvider.branch);
      if (next) statsCache.data = next;
    }

    async function postProvider(value: string) {
      try {
        const response = await fetch(PROVIDER_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The slot field is still sent: the route rejects anything but
          // `ask` by name rather than guessing, and a wire field that has
          // always been there is not worth silently dropping.
          body: JSON.stringify({ slot: 'ask', provider: value === '' ? null : value }),
        });
        let parsed: any = null;
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
        if (parsed && parsed.ok === true) return { ok: true as const, provider: parsed };
        return { ok: false as const, error: (parsed && parsed.error) || 'HTTP ' + response.status };
      } catch (reason: any) {
        return { ok: false as const, error: reason && reason.message ? reason.message : String(reason) };
      }
    }

    const PANEL_SETTINGS_PATH = '/api/atomcode-bridge/panel-settings';
    /** Write the panel's briefMode / workingDir override. One field at a time. */
    async function postPanelSettings(fields: { briefMode?: string | null; workingDir?: string | null; approvalMode?: string | null; askMaxRounds?: number | null }) {
      try {
        const response = await fetch(PANEL_SETTINGS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fields),
        });
        let parsed: any = null;
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
        if (parsed && parsed.ok === true) return { ok: true as const };
        return { ok: false as const, error: (parsed && parsed.error) || 'HTTP ' + response.status };
      } catch (reason: any) {
        return { ok: false as const, error: reason && reason.message ? reason.message : String(reason) };
      }
    }


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
      // The loopback dependency warning renders in the SAME style as trouble
      // (both are "read this before you rely on this control"), but it is not
      // a disabled reason: the control still works — until the local process
      // it bills through exits.
      const warning = model.warning || '';
      // `warning` and `override` answer two different questions — what this
      // pick DEPENDS ON vs which layer actually won — but both are "read this
      // before you rely on this control", so they share ONE line, separated
      // by ` · `. Stacked, they made the card grow two lines without warning
      // the moment a loopback endpoint was picked. `trouble` keeps a line of
      // its own: the control is unusable, and that outranks both.
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
        // Show the effort levels for the selected model, if any. This is the
        // only place the user learns which reasoning-effort values are legal
        // before firing a turn — the daemon's /models is the source of truth.
        model.effortLevels && model.effortLevels.length > 0
          ? h(
              'span',
              {
                style: S.valIdle,
                title: '本模型支持的推理力度（per-turn 传参 reasoning_effort 取这些值；留空 = 用当前持久值）',
              },
              '力度: ' +
                model.effortLevels.join(' / ') +
                (model.currentEffort ? '（当前 ' + model.currentEffort + '）' : ''),
            )
          : null
      );
    }

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
      const [briefPending, setBriefPending] = useState(false);
      const [briefError, setBriefError] = useState('');
      const [dirPending, setDirPending] = useState(false);
      const [dirError, setDirError] = useState('');

      const briefModes = ['always', 'when-empty', 'never'];
      const currentBrief = cfg && typeof cfg.panelBriefMode === 'string' ? cfg.panelBriefMode : '';
      const currentDir = cfg && typeof cfg.panelWorkingDir === 'string' ? cfg.panelWorkingDir : '';

      // Local editing state for the working-dir input, seeded from the server
      // value. Syncs when the server value changes (a poll or a successful
      // write from elsewhere), so the input always reflects the latest state.
      const [dirValue, setDirValue] = useState(currentDir);
      const lastServerDir = useRef(currentDir);
      if (currentDir !== lastServerDir.current) {
        lastServerDir.current = currentDir;
        setDirValue(currentDir);
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
        (() => {
          const approvalModes = ['build', 'accept_edits', 'bypass', 'plan'];
          const currentApproval = cfg && typeof cfg.panelApprovalMode === 'string' ? cfg.panelApprovalMode : '';
          const onApprovalChange = async (event: any) => {
            const value = event && event.target ? event.target.value : '';
            if (value === currentApproval) return;
            setBriefPending(true);
            const result = await postPanelSettings({ approvalMode: value === '' ? null : value });
            setBriefPending(false);
            if (!result.ok) { setBriefError('保存失败：' + result.error); return; }
            if (typeof reload === 'function') void reload();
          };
          return h(
            'div',
            { style: S.provCell },
            h(
              'div',
              { style: S.provFieldRow },
              h('span', { style: S.provLabel, title: '这里的选择优先于插件配置里的 approval_mode；选「不覆盖」就回到配置值。含义：AtomCode 自动执行工具时受多大限制。注意：当前 daemon 对后台调用一律自动放行，切换这里实际不改变行为' }, 'AtomCode 自动执行权限'),
              h(
                'select',
                {
                  style: { ...S.select, flex: '1 1 auto', minWidth: 0 },
                  value: currentApproval,
                  disabled: briefPending,
                  onChange: onApprovalChange,
                  'aria-label': 'AtomCode 自动执行权限',
                },
                h('option', { value: '' }, '不覆盖（用配置 ' + (cfg && typeof cfg.approvalMode === 'string' ? cfg.approvalMode : 'bypass') + '）'),
                approvalModes.map((m) => h('option', { key: m, value: m }, m))
              )
            )
          );
        })(),
        // Ask max rounds — inline editable row
        (() => {
          const currentRounds = cfg && typeof cfg.panelAskMaxRounds === 'number' ? cfg.panelAskMaxRounds : '';
          const [roundsValue, setRoundsValue] = useState(currentRounds === '' ? '' : String(currentRounds));
          const saveRounds = async () => {
            const num = roundsValue === '' ? null : parseInt(roundsValue, 10);
            if (num === currentRounds) return;
            setBriefPending(true);
            setBriefError('');
            const result = await postPanelSettings({ askMaxRounds: num === null || Number.isNaN(num) ? null : num });
            setBriefPending(false);
            if (!result.ok) { setBriefError('保存失败：' + result.error); return; }
            if (typeof reload === 'function') void reload();
          };
          return h(
            'div',
            { style: S.provCell },
            h(
              'div',
              { style: S.provFieldRow },
              h('span', { style: S.provLabel, title: '这里填的数字优先于插件配置里的 ask_max_rounds；0 = 不设上限（交给 daemon 治理）；留空 = 不覆盖。含义：一次「问 AtomCode」最多让它自己循环多少轮' }, '单次咨询最多轮数'),
              h(
                'div',
                { style: { display: 'flex', gap: 4, flex: '1 1 auto', minWidth: 0 } },
                h('input', {
                  style: { ...S.select, flex: '1 1 auto', minWidth: 0, padding: '2px 6px', fontSize: 12 },
                  value: roundsValue,
                  placeholder: '不覆盖（' + (cfg && typeof cfg.askMaxRounds === 'number' ? cfg.askMaxRounds : '25') + '）',
                  disabled: briefPending,
                  type: 'number',
                  min: 0,
                  max: 1000,
                  onChange: (e: any) => setRoundsValue(e.target ? e.target.value : ''),
                  onKeyDown: (e: any) => { if (e.key === 'Enter') saveRounds(); },
                  'aria-label': '单次咨询最多轮数',
                }),
                h('button', {
                  style: { ...S.select, width: 'auto', flex: '0 0 auto', fontSize: 11, cursor: briefPending ? 'wait' : 'pointer' },
                  disabled: briefPending || roundsValue === (currentRounds === '' ? '' : String(currentRounds)),
                  onClick: saveRounds,
                }, '保存')
              )
            )
          );
        })(),
      );
    }

    function useStats() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [updatedAt, setUpdatedAt] = useState(0);
      // Is THIS instance still mounted? The shared request lives on `statsCache`
      // and is owned by NO instance (see the module-level cache note), so an
      // unmount must only stop THIS instance's setState — never abort a request
      // its peers may still be awaiting.
      //
      // The previous shape kept the AbortController in a per-instance ref and
      // aborted it in the cleanup, so whichever instance happened to START the
      // shared fetch cancelled it for every other consumer the moment it
      // unmounted — a needless error flash that only healed on the next poll.
      // The per-instance `generation` counter had the mirror-image flaw: an
      // unmount bumped it, so the shared request's `isCurrent()` check went
      // permanently false and it could no longer write the cache for its
      // surviving peers at all.
      const alive = useRef(true);

      /** Publish the shared cache to this instance — unless it has unmounted. */
      const commit = useCallback(() => {
        if (!alive.current) return;
        setData(statsCache.data);
        setError(statsCache.error);
        setUpdatedAt(statsCache.fetchedAt);
      }, []);

      const load = useCallback(async () => {
        // Reuse a fresh cache entry: another instance fetched within POLL_MS.
        if (statsCache.fetchedAt > 0 && Date.now() - statsCache.fetchedAt < POLL_MS) {
          commit();
          return;
        }
        // No request in flight? WE start one and publish it for peers to share.
        // From here the request owns its own lifetime — it runs to success,
        // error or its own deadline and clears itself — regardless of which
        // consumer unmounts, so no peer's cleanup can cancel it.
        if (!statsCache.promise) {
          const controller = typeof AbortController === 'function' ? new AbortController() : null;
          // A HARD DEADLINE, separate from the poll interval.
          //
          // Without it a request that never settles (the daemon wedged on
          // `POST /command`, a half-open socket) leaves this promise pending forever:
          // the catch never runs, `error` stays null, and the panel keeps rendering
          // the last good snapshot while `更新于` silently freezes. That is a silent
          // degradation — the one thing this plugin is not allowed to do — and it is
          // the LIKELIEST failure mode, because quota polling is the most frequent
          // daemon call we make.
          //
          // Slightly under POLL_MS so a hung request is surfaced before the next tick
          // replaces it, making the failure visible instead of merely late.
          const deadlineMs = Math.max(1000, POLL_MS - 1000);
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            if (controller && controller.abort) controller.abort();
          }, deadlineMs);
          // Publish the in-flight promise so other instances can share it.
          statsCache.promiseStartedAt = Date.now();
          statsCache.promise = (async () => {
            try {
              const response = await fetch(STATS_PATH, {
                headers: { accept: 'application/json' },
                cache: 'no-store',
                ...(controller ? { signal: controller.signal } : {}),
              });
              if (!response.ok) {
                statsCache.error = 'HTTP ' + response.status;
                statsCache.data = null;
                return;
              }
              const body = await response.json();
              statsCache.data = body && body.ok ? body : null;
              statsCache.error = null;
              statsCache.fetchedAt = Date.now();
            } catch (reason: any) {
              // An abort we caused is a TIMEOUT, not a user cancellation: say so, or a
              // wedged daemon reports the AbortError text and reads like a bug in here.
              statsCache.error =
                timedOut
                  ? `面板数据 ${deadlineMs / 1000}s 未返回（daemon 可能卡住）`
                  : reason && reason.message
                    ? reason.message
                    : String(reason);
              statsCache.data = null;
            } finally {
              clearTimeout(timer);
              statsCache.promise = null;
            }
          })();
        }
        // Read BEFORE awaiting: a promise this call just started is stamped
        // `now`, which is later than any adoption, so it is never overwritten.
        const startedAt = statsCache.promiseStartedAt;
        await statsCache.promise;
        reapplyAdoptedProvider(startedAt);
        commit();
      }, [commit]);

      useEffect(() => {
        alive.current = true;
        load();
        const id = setInterval(load, POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(id);
        };
      }, [load]);

      return { data, error, updatedAt, reload: load };
    }

    // ── primitives (inlined from primitives.ts) ──────────────────────────

    function StatusPill({ up }: { up: boolean }): ReactElement {
      const color = up ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)';
      return h(
        'span',
        {
          style: {
            ...S.pill,
            color,
            background: 'transparent',
            border: '1px solid ' + color,
          },
        },
        up ? '运行中' : '未运行',
      );
    }

    function Row({ label, children }: { label: string; children?: unknown }): ReactElement {
      return h(
        'div',
        { style: S.row },
        h('span', { style: S.key }, label),
        h('span', { style: S.val }, children),
      );
    }

    function CallStat({
      num,
      label,
      color,
    }: {
      num: unknown;
      label: string;
      color?: string;
    }): ReactElement {
      return h(
        'span',
        { style: { ...S.callStat, color: color || 'var(--dsw-alias-label-primary)' } },
        String(num),
        h('span', { style: S.callStatLabel }, label),
      );
    }

    // ── quota chip ────────────────────────────────────────────────────────

    /**
     * Compact quota readout: `atom · 2% · 29m13s 后重置` — a click-opens panel.
     * The countdown leads the facts because the rolling window refilling is
     * the thing that changes what the user can do next; the plan period
     * (`3d / 共 7d`) is deliberately absent from the strip (see `chipLabel`).
     *
     * Rendered into `conversation.composer.dock` ("Ambient entries below the
     * composer card") — the strip that already carries the host's own
     * readouts (`7 轮 141 步`, `21.4M tok · 缓存命中`, the context ring). A
     * quota number is a READOUT, so it belongs with the readouts; it used to
     * sit in `conversation.input.right`, which is the submit-adjacent
     * OPERATIONS row (see the registration site for the full reason).
     *
     * The panel replaces a native `title` tooltip. The old one-liner packed
     * four facts into a single line, which read as noise and could not show a
     * LIVE countdown (the browser paints the `title` once, at hover, and it
     * is stale by the time it is read). The panel renders the same facts as
     * rows and re-derives the countdown from `fetchedAt` on every tick.
     *
     * Mirrors the host's own ContextMeter (dsh-client-ui-conversation): a
     * `Tooltip`-wrapped trigger button plus a `createPortal` dialog, dismissed
     * by Escape or an outside pointer. Both primitives are seed modules, so
     * neither `inject` nor a build step is involved; when either is missing
     * the chip degrades to the native `title` rather than failing to mount.
     *
     * Renders nothing when the quota is unknown. The dock itself also
     * collapses when empty (`.dock:empty{display:none}`), so an absent quota
     * costs no layout — a stopped daemon leaves no permanent error badge in
     * the composer, and the detail page still explains why.
     */
    // The composer dock's two readouts live in `./quota-chip.ts` now — the
    // portal popover and its seed-less twin. They are BUILT here rather than
    // imported ready-made because everything they render is made of `h` and
    // hooks (the app's own React instance, taken at factory time), and because
    // they need the two seed modules the factory resolved: `react-dom` for the
    // portal, the primitives package for the anchoring and the Tooltip.
    const { QuotaChip, QuotaChipDegraded } = createQuotaChip({
      h,
      useStats,
      useState,
      useEffect,
      useRef,
      primitives,
      reactDom,
    });

    /**
     * Which readout the composer dock gets — decided ONCE, at factory time,
     * from whether the two seed modules resolved. Stable for the life of the
     * registration, so whichever component is chosen always runs the same
     * hook sequence in every render.
     */
    const QUOTA_READOUT = primitives && reactDom ? QuotaChip : QuotaChipDegraded;

    // The detail-page panel itself lives in `./status-section.ts` now. It is
    // BUILT here rather than imported ready-made because everything it renders
    // is made of `h` — the app's own React instance, taken at factory time
    // above. A module that called `require('react')` for itself could bind a
    // second copy and break hooks, so the components and the stats hook are
    // INJECTED; what that file imports on its own is only what is React-free
    // (the style object and the pure formatters in quota.ts / rows.ts).
    const StatusSection = createStatusSection({
      h,
      useStats,
      // The sections collapse and expand on their own — that state lives here.
      useState,
      StatusPill,
      Row,
      CallStat,
      ProviderSelectRow,
      PanelSettingsControls,
    });

    // The composer's insertion rail, and the 锐评 hand-off that needs it. The
    // rail renders NOTHING — see ./review-handoff.ts for why a visible seat is
    // spent on a null component: the transcript's 锐评 row sits in a seat whose
    // props carry no `inputActions`, so only a component inside the composer can
    // pre-fill the official `/atomcode-review` command for it.
    const { ReviewRail, requestReview } = createReviewHandoff();

    // The 锐评 entry beside each assistant message (`conversation.chat.assistant-
    // actions`). It does not open anything: it pre-fills the official slash
    // command with that message quoted, and the HOST runs the review. Why the
    // text is readable at all, and why this is not the rejected P2 injection, is
    // written out in ./message-ask.ts's header.
    const MessageAsk = createMessageAsk({
      h,
      requestReview,
    });

    function apply(ctx: any) {
      // The detail page, at the seat that renders BETWEEN the description and the
      // shipped rows — where a bundle's own configuration is documented to live
      // ("rendered on the bundle's page between its description and its rows",
      // `plugins.bundle.config`, `kind: keyed`, keyed by the bundle's package name).
      //
      // This was `plugins.detail.section` first, purely because that seat's NAME read
      // like "the plugin's detail page". It is a LIST seat appended AFTER the shipped
      // rows, so the readout landed below `运行统计` / `包含的组件` instead of above
      // them — a placement the user noticed before I did ("sensenova 是放在已运行插件
      // 上方的"). Read the contract summary, not the name. AGENTS.md 红线 7 records the
      // same lesson for the composer dock.
      //
      // EXACTLY ONE seat gets the panel. The fallback is for a host that does not
      // offer `plugins.bundle.config` at all (an older build, or the desktop install
      // copy): registering on both would render the whole panel TWICE on a modern
      // host, which is worse than the placement bug this fixes. `inject` invokes the
      // callback only when the seat exists, so the first branch that mounts wins and
      // the second stays unclaimed — hence the `mounted` latch, which also keeps this
      // ordered (preferred seat first).
      let mounted = false;
      const mount = (seat: string, options: Record<string, unknown>) => {
        if (mounted) return;
        try {
          ctx.slots.inject(seat, function () {
            if (mounted) return function () {};
            try {
              const dispose = ctx.slots.register(options, StatusSection);
              mounted = true;
              return dispose;
            } catch (e) {
              return function () {};
            }
          });
        } catch (e) {
          /* slots service unavailable — try the next seat, then degrade silently */
        }
      };
      // Preferred: the bundle-configuration seat (renders before the shipped rows).
      mount('plugins.bundle.config', { name: 'plugins.bundle.config', key: REGISTRATION.id });
      // Fallback: the detail-section list seat (renders after the shipped rows).
      mount('plugins.detail.section', {
        name: 'plugins.detail.section',
        id: 'atomcode-bridge-status',
        order: 30,
      });

      // Ambient quota readout in the composer DOCK — the strip BELOW the
      // composer card where the host already parks its own readouts
      // (`7 轮 141 步 · 139 tok/s`, `21.4M tok · 缓存命中 99%`, the context
      // ring). A quota number is a READOUT, so it belongs with the readouts.
      //
      // It was previously on `conversation.input.right` because that seat's
      // name read like a good home — it does not. That seat is documented as
      // "Compact controls before the composer submit action": it is where the
      // mic and the send button live, i.e. the OPERATIONS row. A gauge among
      // buttons reads as a control, and it crowds the submit cluster.
      //
      // `order: 1` places it after `dsh-client-ui-chat`'s `stats` entry
      // (order 0, which owns the turns/tokens pills) and before the host's
      // own decoration template (order 5). The host CSS gives the row
      // `gap:12px` and `.dock:empty{display:none}`, so spacing is inherited
      // and an absent quota costs no space.
      try {
        ctx.slots.inject('conversation.composer.dock', function () {
          try {
            return ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'atomcode-bridge-quota',
                order: 1,
              },
              QUOTA_READOUT
            );
          } catch (e) {
            return function () {};
          }
        });
      } catch (e) {
        /* the shell without a composer dock simply has no such seat */
      }

      // The composer's insertion rail, on the seat whose props carry it. Read the
      // seat's contract summary before trusting the name (红线 7):
      // `conversation.input.left` is "Compact controls at the left of the composer
      // tool row" — a CONTROL row, so a control could live here. This one does
      // not: `ReviewRail` renders null and only takes the rail (see
      // ./review-handoff.ts). The seat is still the RIGHT one, because it is
      // `scope: session` and the host renders it only with a mounted composer —
      // exactly when there IS a draft to pre-fill.
      //
      // `order: 100` puts it after whatever the host ever adds to the left row.
      // The id is fresh, so nothing shipped is replaced (`replaceRisk`: none).
      try {
        ctx.slots.inject('conversation.input.left', function () {
          try {
            return ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'atomcode-bridge-rail',
                order: 100,
              },
              ReviewRail
            );
          } catch (e) {
            return function () {};
          }
        });
      } catch (e) {
        /* the shell without a composer tool row simply has no such seat */
      }

      // The 锐评 entry in an assistant message's own action row. Its contract
      // summary is "Ordered actions for one finalized assistant message" and its
      // owner props are `{ messageId }` — that messageId is the whole reason
      // this seat and not another: it lets the button read THAT reply's text out
      // of the chat projection the owner already hands us (`useChat`), which is
      // the same source the shipped 复制 button reads. No fetching, no scraping.
      //
      // A fresh id beside the shipped `feedback` (order 10) rather than a
      // replacement: reusing an id REPLACES that entry, and nothing here has any
      // business removing the feedback control. `order: 10` puts 锐评 right after
      // it, before the usage/时间 cell the host appends.
      try {
        ctx.slots.inject('conversation.chat.assistant-actions', function () {
          try {
            return ctx.slots.register(
              {
                name: 'conversation.chat.assistant-actions',
                id: 'atomcode-bridge-review',
                order: 10,
              },
              MessageAsk
            );
          } catch (e) {
            return function () {};
          }
        });
      } catch (e) {
        /* a shell whose chat nodes do not expose the action row */
      }
    }

    // `__test` exposes the pure formatters to the offline suite (see
    // test/client-fns.test.mjs). Unknown keys are ignored by the loader, so
    // this costs nothing in the browser.
    return { inject: ['slots', 'locale'], apply: apply, __test: TESTABLE };
  },
};

// The web boot evaluates this file and calls `__ModuleLoader__.load`, so the
// registration is delivered by that call and NOT by a module export: an export
// would make the IIFE bundler emit a `window` global that the handwritten
// artifact never had (it would be a new page-global side effect).
if (typeof window !== 'undefined' && (window as any).__ModuleLoader__) {
  (window as any).__ModuleLoader__.load(REGISTRATION);
}
