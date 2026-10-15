/**
 * dsh-atomcode-bridge — Client half (renderer).
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
 * @module dsh-atomcode-bridge/client
 */
import type { CSSProperties, ReactElement } from 'react';
import type {
  ProviderBranch,
  ProviderSlotName,
} from './types.ts';
import {
  S,
  CHIP_STYLE,
  CHIP_TRIGGER_STYLE,
} from './styles.ts';
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
import { providerRows, providerSelectModel, turnBoundaryRows } from './rows.ts';

// The loader hands the factory an untyped `require`; the host resolves
// `react` from the web boot's seed table.
type LoaderRequire = (id: string) => any;

const REGISTRATION = {
  // MUST equal this package's name verbatim: the Host keys client-module
  // factories by package name and resolves the row as `factories.has(id)`.
  // Any other id loads without registering and fails the web boot audit.
  id: 'dsh-atomcode-bridge',
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
    // `$DSH_HOME/state/dsh-atomcode-bridge/provider.json` — never to
    // ~/.atomcode/config.toml, which stays read-only for us (AGENTS.md 红线 8).
    const PROVIDER_PATH = '/api/atomcode-bridge/provider';
    const POLL_MS = 5000;

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
    };

    async function postProvider(slotName: ProviderSlotName, value: string) {
      try {
        const response = await fetch(PROVIDER_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slot: slotName, provider: value === '' ? null : value }),
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

    /**
     * One interactive provider control: a dropdown scoped to ONE namespace.
     *
     * Two per snapshot, never merged: ask lists daemon model profiles, review lists
     * config.toml direct entries (红线 8). Laid out as one line with two cells —
     * the label sits above its dropdown, and the provenance that used to sit in
     * the card body now lives in the `title` (see providerRows()).
     *
     * Pending/error state is local, and the control is never swapped back to static
     * text — a failed write must stay visible with its reason, or the user cannot
     * tell "the plugin refused" from "my click did nothing".
     */
    function ProviderSelectRow({
      label,
      slotName,
      provider,
      fallbackLabel,
      title,
      reload,
    }: {
      label: string;
      slotName: ProviderSlotName;
      provider: ProviderBranch | undefined;
      fallbackLabel: string;
      title?: string;
      reload?: () => void;
    }) {
      const model = providerSelectModel(provider, slotName, fallbackLabel);
      const [note, setNote] = useState('');
      const [pending, setPending] = useState(false);
      const onChange = async (event: any) => {
        const value = event && event.target ? event.target.value : '';
        setPending(true);
        setNote('');
        const result = await postProvider(slotName, value);
        setPending(false);
        if (!result.ok) {
          setNote('保存失败：' + result.error);
          return;
        }
        // NO "已选 X" on success. The dropdown itself now shows X — that IS the
        // confirmation, and printing it again under the control was the last piece
        // of "每格都挂一句话" the user objected to. Only a FAILURE needs words,
        // because a failure has nowhere else to show up.
        if (typeof reload === 'function') void reload();
      };
      // `note` is a pre-worded sentence about the effective value (see
      // providerSelectModel). It is empty when there is nothing to say —
      // narrating "this came from the panel" next to the user's own click was
      // decoration, and it made every row two lines tall.
      const override = model.note;
      const trouble = model.disabled ? model.reason : '';
      return h(
        'div',
        { style: S.provCell },
        h('span', { style: S.provLabel, title }, label),
        h(
          'select',
          {
            style: model.disabled || pending ? { ...S.select, ...S.selectOff } : S.select,
            value: model.value,
            disabled: model.disabled || pending,
            onChange,
            title: trouble || override || title,
            'aria-label': label,
          },
          model.options.map((option, index) =>
            h('option', { key: slotName + '-' + index, value: option.value }, option.label)
          )
        ),
        trouble ? h('span', { style: S.valWarn, title: trouble }, trouble) : null,
        override ? h('span', { style: S.valWarn, title: override }, override) : null,
        note ? h('span', { style: S.valIdle }, note) : null
      );
    }

    function useStats() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [updatedAt, setUpdatedAt] = useState(0);
      const generation = useRef(0);
      const inFlight = useRef(null);

      const load = useCallback(async () => {
        generation.current += 1;
        const mine = generation.current;
        const isCurrent = () => generation.current === mine;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        inFlight.current = controller;
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
        try {
          const response = await fetch(STATS_PATH, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
            ...(controller ? { signal: controller.signal } : {}),
          });
          if (!isCurrent()) return;
          if (!response.ok) {
            setError('HTTP ' + response.status);
            setData(null);
            return;
          }
          const body = await response.json();
          if (!isCurrent()) return;
          setData(body && body.ok ? body : null);
          setError(null);
          setUpdatedAt(Date.now());
        } catch (reason: any) {
          if (!isCurrent()) return;
          // An abort we caused is a TIMEOUT, not a user cancellation: say so, or a
          // wedged daemon reports the AbortError text and reads like a bug in here.
          setError(
            timedOut
              ? `面板数据 ${deadlineMs / 1000}s 未返回（daemon 可能卡住）`
              : reason && reason.message
                ? reason.message
                : String(reason)
          );
        } finally {
          clearTimeout(timer);
        }
      }, []);

      useEffect(() => {
        load();
        const id = setInterval(load, POLL_MS);
        return () => {
          clearInterval(id);
          generation.current += 1;
          if (inFlight.current && inFlight.current.abort) inFlight.current.abort();
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

    function Metric({
      num,
      label,
      color,
    }: {
      num: unknown;
      label: string;
      color?: string;
    }): ReactElement {
      return h(
        'div',
        { style: S.metric },
        h('span', { style: { ...S.metricNum, color: color || 'var(--dsw-alias-label-primary)' } }, String(num)),
        h('span', { style: S.metricLabel }, label),
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
     * Compact quota readout: `atom · 5小时 19%` — a click-opens panel.
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
    function QuotaChip() {
      const { data } = useStats();
      const [open, setOpen] = useState(false);
      // 1s tick ONLY while the panel is open: the countdown is the one thing
      // that goes stale between the 5s polls, and an always-on interval would
      // re-render every composer in every session on every second.
      const [, setTick] = useState(0);
      const rootRef = useRef(null);
      const panelRef = useRef(null);

      const view = quotaView(data && data.quota, Date.now());

      useEffect(() => {
        if (!open) return undefined;
        const id = setInterval(() => setTick((n: number) => n + 1), 1000);
        return () => clearInterval(id);
      }, [open]);

      // Escape closes, matching the neighbouring popovers.
      useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [open]);

      // The two primitive hooks are part of this component's FIXED tail, not an
      // optional branch: this component is only ever registered when both seeds
      // resolved (see `QUOTA_READOUT`), so their presence cannot vary between
      // renders of one instance. That is what makes the early return below legal.
      const anchored = primitives.useAnchoredPosition({
        open: open && view.known,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        gap: 8,
        margin: 12,
      });
      primitives.useDismissOnOutsidePointer(rootRef, open && view.known, setOpen, panelRef);

      // Every hook has now run unconditionally. Bailing here keeps the dock
      // empty instead of printing a percent that has not arrived yet.
      if (!view.known) return null;

      return h(
        'span',
        {
          ref: rootRef,
          'data-quota-percent': view.pct,
          style: CHIP_STYLE(view.color),
        },
        h(
          primitives.Tooltip,
          {
            label: view.facts.join(' · '),
            side: 'top',
            delayMs: 200,
            // The panel already shows this; two stacked tooltips fight.
            disabled: open,
          },
          h(
            'button',
            {
              type: 'button',
              style: CHIP_TRIGGER_STYLE,
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              onClick: () => setOpen(!open),
            },
            // Built by quotaView, which cannot produce a label at all unless
            // the percent is a real number — so `null%` is unconstructable.
            view.label
          )
        ),
        open &&
          reactDom.createPortal(
            h(
              'div',
              {
                ref: panelRef,
                role: 'dialog',
                'aria-label': 'CodingPlan 额度',
                // Same shape the host's ContextMeter uses: `position ?? {hidden,0,0}`.
                // The merge order is load-bearing, so it lives in `panelStyle`
                // (guarded by test/client-fns.test.mjs) rather than inline here.
                style: panelStyle(S.panelSurface, anchored),
              },
              h(
                'div',
                { style: S.panelHead },
                h('span', { style: S.panelTitle }, 'CodingPlan 额度'),
                h(
                  'span',
                  { style: S.panelPct },
                  pctLabel(view.pct),
                  view.limited ? h('span', { style: S.panelLimited }, '已用尽') : null
                )
              ),
              // Single-hue bar: the daemon's `status` text carries only a
              // total, so there is no system/tools/message split to draw —
              // inventing one would be a number this plugin cannot support.
              h(
                'div',
                { style: S.panelTrack },
                h('div', {
                  style: {
                    height: '100%',
                    width: view.barWidth + '%',
                    background: view.color,
                  },
                })
              ),
              view.facts.map((fact, index) =>
                h(
                  'p',
                  {
                    key: 'fact-' + index,
                    style: index === 0 ? S.panelFactLead : S.panelFact,
                  },
                  fact
                )
              )
            ),
            document.body
          )
      );
    }

    /**
     * The seed-less host variant: same number, native `title` instead of a
     * panel. It calls NO primitive hooks, which is the whole reason it exists
     * as its own component — a single QuotaChip that branched over
     * `primitives` would have a conditional hook tail (Rules of Hooks). That
     * is survivable only because `primitives` is a factory-scope constant, and
     * it turns into "Rendered fewer hooks than expected" the moment the seed
     * table is loaded lazily, with the crash site far from the cause.
     */
    function QuotaChipDegraded() {
      const { data } = useStats();
      const view = quotaView(data && data.quota, Date.now());
      if (!view.known) return null;
      return h(
        'span',
        {
          title: view.facts.join(' · '),
          'data-quota-percent': view.pct,
          style: CHIP_STYLE(view.color),
        },
        view.label
      );
    }

    /**
     * Which readout the composer dock gets — decided ONCE, at factory time,
     * from whether the two seed modules resolved. Stable for the life of the
     * registration, so whichever component is chosen always runs the same
     * hook sequence in every render.
     */
    const QUOTA_READOUT = primitives && reactDom ? QuotaChip : QuotaChipDegraded;

    /**
     * The bundle card's one-liner (`view: 'summary'`).
     *
     * Reports LIVE state only. The card already prints the localized description
     * from `locale/*.json` directly above this line, so any prose here would both
     * duplicate it and create a second place to keep the same words in sync.
     * One line, and it says something the description cannot: is the bridge up.
     */
    function SummaryLine() {
      const { data, error } = useStats();
      if (error || !data) return h('span', { style: S.provLabel }, '状态未知');
      const d = data.daemon || {};
      const cfg = data.config || {};
      const parts = [
        d.up ? 'daemon 运行中' + (data.protocol && data.protocol.daemonVersion ? ' ' + data.protocol.daemonVersion : '') : d.autoStart ? 'daemon 未运行（可自动拉起）' : 'daemon 未运行',
        '端口 ' + (d.port == null ? '—' : d.port),
      ];
      if (cfg.reviewAvailable === false) parts.push('评审不可用');
      return h('span', { style: S.provLabel, title: parts.join(' · ') }, parts.join(' · '));
    }

    function StatusSection(props: any) {
      const view = props && props.view;
      const subject = props && props.subject;
      // Two seats can mount this, and they address the page differently:
      //  - `plugins.bundle.config` is KEYED by package name, so the host has already
      //    proved this is our bundle and passes no `subject`; it also asks for
      //    `view: 'summary'` (the one-liner on the card) as well as `'page'`.
      //  - `plugins.detail.section` is a LIST seat: it passes the page's `subject`
      //    and we must claim it by name.
      // An unknown/absent view means the list seat, which is the older path.
      const keyed = view === 'summary' || view === 'page';
      if (!keyed) {
        const name = subject && subject.kind === 'bundle' ? subject.pkg && subject.pkg.name : undefined;
        if (name !== 'dsh-atomcode-bridge') return null;
      }
      // `summary` is the plugin CARD's one-liner, which already renders the bundle
      // description (from locale/*.json) right above us. Repeating the blurb there
      // would be the "four lines of English" problem again AND a second source of
      // truth for the same string — so the summary reports the one thing the
      // description cannot: whether the bridge is actually live right now.
      if (view === 'summary') {
        return h(SummaryLine, null);
      }

      const { data, error, updatedAt, reload } = useStats();

      let body;
      if (error) {
        body = h('div', { style: S.notice }, h('p', { style: S.error }, '统计信息加载失败：' + error));
      } else if (!data) {
        body = h('div', { style: S.notice }, '加载中…');
      } else {
        const d = data.daemon || {};
        const bin = data.binary || {};
        const cfg = data.config || {};
        const quota = data.quota || {};
        const ask = data.ask || { calls: 0, ok: 0, err: 0, msTotal: 0, tokens: 0 };
        const review = data.review || { calls: 0, ok: 0, err: 0, msTotal: 0 };
        const proto = data.protocol || {};
        // The model knobs. `null` = an older host that has no provider branch;
        // the rows still render, disabled and WITH a reason, so the panel never
        // shows an empty dropdown (红线 3).
        const prov = data.provider || null;
        const retryNote = cfg.daemonRetrySecs > 0 ? cfg.daemonRetrySecs + 's' : '每次轮询';
        // Countdown is derived locally from the snapshot's fetch time, so it
        // keeps ticking between polls instead of showing a frozen server string.
        const liveResetSecs = liveRemaining(quota.resetInSecs, quota.fetchedAt, Date.now());
        const quotaPct = typeof quota.usagePercent === 'number' ? quota.usagePercent : null;
        const quotaExpiry = [quota.expires, quota.planWindow].filter(Boolean).join(' · ');
        const askAvg = ask.calls > 0 ? Math.round(ask.msTotal / ask.calls) : 0;
        const reviewAvg = review.calls > 0 ? Math.round(review.msTotal / review.calls) : 0;
        const binPath = bin.configured || bin.env || '自动探测（PATH）';
        // Check `up` first: a daemon that answered while a start is still
        // winding down must not be labelled "starting".
        const spawnNote = d.up
          ? d.spawnTried
            ? '已自动拉起'
            : '运行中'
          : d.starting
            ? '正在拉起…'
            : d.spawnTried
              ? '自动拉起失败'
              : '未触发自动拉起';

        body = h(
          'div',
          { style: S.wrap },
          h(
            'div',
            { style: S.titleRow },
            h('h3', { style: S.title }, '运行统计'),
            // The badge reports the ACTUAL freshness, not a hopeful constant. It used
            // to read 实时 unconditionally, including while the panel was showing an
            // error or a snapshot from minutes ago — a "live" label over stale data
            // is exactly the silent degradation this plugin forbids.
            h(
              'span',
              { style: error ? { ...S.live, ...S.liveStale } : S.live },
              error ? '已断开' : '实时'
            ),
            updatedAt
              ? h(
                  'span',
                  { style: S.updated, title: error || '' },
                  (error ? '最后更新 ' : '更新于 ') + new Date(updatedAt).toLocaleTimeString('zh-CN')
                )
              : null,
            error
              ? h('span', { style: { ...S.updated, ...S.staleReason }, title: error }, error)
              : null
          ),
          // 静默降级的显式信号：额度文本形状变了（AtomCode 升级）时必须说出来，
          // 而不是让面板看起来像"额度为 0"。
          proto.quotaTextDrift
            ? h(
                'div',
                { style: S.notice },
                '额度解析失配：daemon 的 status 文本已不符合已知形状（AtomCode 可能已升级），' +
                  '下面显示的是原始文本而非解析结果。可手工核对 /api/atomcode-bridge/stats 的 quota.raw。'
              )
            : null,
          // 评审 CLI 受限时把原因摊开：这是本机配置事实，不是临时故障
          cfg.reviewAvailable
            ? null
            : h(
                'div',
                { style: S.notice },
                '代码评审（atomcode_review）当前不可用：' +
                  (cfg.reviewReason || '本机 AtomCode 配置没有可用的直连 provider') +
                  '。侧边咨询（atomcode_ask）不受影响。'
              ),
          h(
            'div',
            { style: S.grid },
            // Card order is by how often a user READS each one, not by how the code
            // happens to be written: 启动情况 / 运行环境 / 回合边界 are setup facts you
            // check once, while CodingPlan 额度 is the figure that decides whether a
            // turn will be throttled. See the note on the 额度 card below.
            // 启动情况
            h(
              'div',
              { style: S.card },
              // The status pill rides in the TITLE row, not on a data row of its own.
              // It is a state of the card, not a field of it: giving it a full row
              // (with the same layout as 监听端口) made one badge occupy as much
              // vertical space as a labelled value, and left a visibly empty line
              // under the heading.
              h(
                'p',
                { style: { ...S.cardTitle, display: 'flex', alignItems: 'center', gap: '8px' } },
                '启动情况',
                h(StatusPill, { up: !!d.up })
              ),
              h(Row, { label: '监听端口' }, String(d.port)),
              h(Row, { label: '自动启动' }, d.autoStart ? '开启' : '关闭'),
              h(Row, { label: '拉起状态' }, spawnNote),
              // Which daemon build the bridged (private, unversioned) protocol
              // is being spoken against — the earliest drift signal.
              h(Row, { label: 'daemon 版本' }, proto.daemonVersion || (d.up ? '未知' : '—')),
              !d.up && d.spawnFailures > 1
                ? h(Row, { label: '拉起重试' }, `失败 ${d.spawnFailures} 次（每 ${retryNote} 重试一次）`)
                : null
            ),
            // 运行环境 ────────────────────────────────────────────────────
            // Only what varies. `来源` was merged into the path line (it WAS the
            // path line's provenance, said twice), and `评审可用性` appears only
            // when it is NOT 可用 — a row that always reads "可用" is a row the
            // user learns to skip, which is how a real warning gets missed.
            h(
              'div',
              { style: S.card },
              h('p', { style: S.cardTitle }, '运行环境'),
              h(Row, { label: 'AtomCode' }, binPath),
              // Two columns, one line, NEVER one merged control: two DIFFERENT
              // namespaces (红线 8). providerRows() owns the wording, the
              // snapshot's `provider` branch owns what is selectable right now — so
              // an older host without the branch renders the same two controls
              // disabled, with a reason, rather than an empty dropdown.
              h(
                'div',
                { style: S.provGrid },
                providerRows(cfg).map((row) =>
                  h(ProviderSelectRow, {
                    key: 'provider-' + row.slotName,
                    label: row.label,
                    slotName: row.slotName,
                    provider: prov,
                    fallbackLabel: row.fallback,
                    title: row.title,
                    reload,
                  })
                )
              ),
              cfg.reviewAvailable
                ? null
                : h(
                    Row,
                    { label: '评审可用性' },
                    h('span', { style: S.error }, '不可用 — 改用 atomcode_ask')
                  )
            ),
            // 回合边界 ────────────────────────────────────────────────────
            // Split out of the card above because these are not "runtime": they
            // are the SAFETY POSTURE and SCOPE of a bridged turn, and they are
            // patch-only fields this panel cannot edit (no input exists for them).
            // So each row says whether it is the plugin's own default or something
            // the user actually set — reporting an unset default as if it were a
            // live setting is how six constant rows ended up on screen. The
            // verdict comes from cfg.authored (the HOST's record of what the patch
            // supplied), never from comparing against a hardcoded default here.
            h(
              'div',
              { style: S.card },
              h('p', { style: S.cardTitle }, '回合边界'),
              turnBoundaryRows(cfg).map((row) =>
                h(Row, { key: 'bound-' + row.label, label: row.label }, h('span', { title: row.title }, row.text))
              )
            ),
            // 会话
            h(
              'div',
              { style: S.card },
              h('p', { style: S.cardTitle }, '侧边会话'),
              h(
                'div',
                { style: S.metrics },
                h(Metric, { num: (data.sessions && data.sessions.tracked) || 0, label: '已跟踪会话' })
              ),
              h(Row, { label: '运行时长' }, fmtDuration(data.uptimeMs))
            ),
            // 工具使用
            h(
              'div',
              { style: S.card },
              h('p', { style: S.cardTitle }, '工具调用统计'),
              // Two GROUPS on one line, each rendered as `label  数字 数字 数字`
              // rather than as stacked metrics. The stacked form put each caption
              // UNDER its own number while the group label sat on the baseline, so
              // the row mixed two alignment conventions and read as scattered text.
              // Inline (number followed by its caption) keeps everything on one
              // baseline, which is how the host's own dock readouts do it.
              h(
                'div',
                { style: S.callGroups },
                h(
                  'div',
                  { style: S.callGroup },
                  h('span', { style: S.callGroupLabel }, 'atomcode_ask'),
                  h(CallStat, { num: ask.calls, label: '调用' }),
                  h(CallStat, { num: ask.ok, label: '成功', color: ask.ok ? 'var(--dsw-alias-state-success-primary)' : undefined }),
                  h(CallStat, { num: ask.err, label: '失败', color: ask.err ? 'var(--dsw-alias-state-error-primary)' : undefined })
                ),
                h(
                  'div',
                  { style: { ...S.callGroup, borderRight: 'none', paddingRight: 0 } },
                  h('span', { style: S.callGroupLabel }, 'atomcode_review'),
                  h(CallStat, { num: review.calls, label: '调用' })
                )
              ),
              h(Row, { label: 'ask 累计 tokens' }, String(ask.tokens)),
              h(Row, { label: 'ask 平均耗时' }, fmtDuration(askAvg)),
              h(Row, { label: 'review 平均耗时' }, fmtDuration(reviewAvg))
            ),
            h(
              'div',
              { style: S.card },
              h('p', { style: S.cardTitle }, 'CodingPlan 额度'),
              !quota.available
                ? h('p', { style: S.error }, quota.reason || '额度不可用（daemon 未运行或命令不可用）')
                : quotaPct == null && !quota.plan
                  ? h(
                      'div',
                      null,
                      h('p', { style: S.key }, quota.reason || '未能从 status 文本中识别出额度'),
                      quota.raw && quota.raw.usageLine
                        ? h('p', { style: S.key }, quota.raw.usageLine)
                        : null,
                      quota.raw && quota.raw.planLine
                        ? h('p', { style: S.key }, quota.raw.planLine)
                        : null
                    )
                  : h(
                      'div',
                      // No extra inner wrapper: the card itself is already a
                      // `flex-direction: column` with `gap: 6px`. Nesting another
                      // `gap: 8px` column made THIS card's rhythm differ from every
                      // neighbour, so its rows sat further apart and the card grew
                      // taller than the ones beside it.
                      null,
                      // ONE headline number plus one clarifying clause — not two peer
                      // gauges. `0%` is a RATIO and `1h26m` is a DURATION; rendering
                      // both at 18px/700 side by side asked the reader to compare two
                      // different quantities as if they were the same kind of fact.
                      // The countdown is supporting detail, so it follows the number
                      // in the label line at normal weight.
                      quotaPct == null
                        ? h(
                            'div',
                            { style: S.metric },
                            h('span', { style: S.metricLabel }, quota.reason || '额度读数不可用')
                          )
                        : h(
                            'div',
                            { style: S.metric },
                            h(
                              'span',
                              { style: { ...S.metricNum, color: quotaColor(quotaPct, quota.limited) } },
                              pctLabel(quotaPct)
                            ),
                            h(
                              'span',
                              { style: S.metricLabel },
                              '当前时间窗口用量' +
                                (liveResetSecs == null ? '' : ' · ' + fmtCountdown(liveResetSecs) + ' 后重置')
                            )
                          ),
                      quotaPct == null
                        ? null
                        : h(
                            'div',
                            {
                              style: {
                                height: '6px',
                                borderRadius: '3px',
                                border: '1px solid var(--dsw-alias-border-l1)',
                                overflow: 'hidden',
                              },
                            },
                            h('div', {
                              style: {
                                height: '100%',
                                width: barWidth(quotaPct) + '%',
                                background: quotaColor(quotaPct, quota.limited),
                              },
                            })
                          ),
                      h(Row, { label: '套餐' }, quota.plan || '—'),
                      h(Row, { label: '到期' }, quotaExpiry || '—'),
                      h(Row, { label: '重置于' }, quota.resetAt || '—'),
                      quota.limited
                        ? h('p', { style: S.error }, '当前 5 小时窗口已用尽，回合会被限流')
                        : null
                    )
            )
          )
        );
      }

      return body;
    }

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
