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
import type {
  ProviderBranch,
  ProviderSlotName,
} from './types.ts';
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
  providerRows,
  providerSelectModel,
  turnBoundaryRows,
  isLoopbackEndpoint,
  daemonStatusLine,
  protocolDriftNotice,
} from './rows.ts';
import { createStatusSection } from './status-section.ts';
import { createQuotaChip } from './quota-chip.ts';

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
    let adoptedProvider: { slots: Record<string, unknown>; at: number } | null = null;

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
      isLoopbackEndpoint,
      daemonStatusLine,
      protocolDriftNotice,
      providerSlotsOf,
      snapshotWithSlots,
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
     * The two provider branches a write's response carries, or null when it
     * carries none.
     *
     * Both are taken, not just the one that was written: the server recomputes
     * `effective`/`source` for the whole branch, and a pick in one namespace
     * never changes the other — adopting both keeps the two dropdowns reading
     * from one freshly-answered snapshot.
     */
    function providerSlotsOf(provider: any): Record<string, unknown> | null {
      if (!provider || typeof provider !== 'object') return null;
      const slots: Record<string, unknown> = {};
      for (const slot of ['ask', 'review']) {
        if (provider[slot] && typeof provider[slot] === 'object') slots[slot] = provider[slot];
      }
      return Object.keys(slots).length > 0 ? slots : null;
    }

    /**
     * One snapshot plus adopted slots in, the NEXT snapshot out — a NEW object.
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
    function snapshotWithSlots(current: any, slots: Record<string, unknown>): any | null {
      if (!current) return null;
      return { ...current, provider: { ...(current.provider || {}), ...slots } };
    }

    function adoptProviderSnapshot(provider: any): boolean {
      const slots = providerSlotsOf(provider);
      const next = slots ? snapshotWithSlots(statsCache.data, slots) : null;
      if (!next || !slots) return false;
      adoptedProvider = { slots, at: Date.now() };
      statsCache.data = next;
      return true;
    }

    /** Re-apply the adopted branch over an answer a pre-click poll just delivered. */
    function reapplyAdoptedProvider(startedAt: number): void {
      if (!adoptedProvider || adoptedProvider.at <= startedAt) return;
      const next = snapshotWithSlots(statsCache.data, adoptedProvider.slots);
      if (next) statsCache.data = next;
    }

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
            title: trouble || override || warning || title,
            'aria-label': label,
          },
          model.options.map((option, index) =>
            h('option', { key: slotName + '-' + index, value: option.value }, option.label)
          )
        ),
        trouble ? h('span', { style: S.valWarn, title: trouble }, trouble) : null,
        warning ? h('span', { style: S.valWarn, title: warning }, warning) : null,
        override ? h('span', { style: S.valWarn, title: override }, override) : null,
        note ? h('span', { style: S.valIdle }, note) : null
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
      StatusPill,
      Row,
      Metric,
      CallStat,
      ProviderSelectRow,
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
