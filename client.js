/**
 * dsh-atomcode-bridge — Client half (renderer).
 *
 * Registers a `plugins.detail.section` slot on this plugin's detail page that
 * surfaces live startup/usage statistics, polled over the host's read-only
 * same-origin route `/api/atomcode-bridge/stats` (see lib/index.js).
 *
 * This is a committed IIFE artifact (pnpm refuses to build git-dep bundles),
 * evaluated by the web boot, which calls `window.__ModuleLoader__.load`.
 * The factory receives the loader's `require` and returns `{ inject, apply }`,
 * mirroring the dsh-connect-sensenova-token-plan client contract: React is
 * obtained at factory time via `require("react")` so the same instance the app
 * uses backs every component.
 *
 * @module dsh-atomcode-bridge/client
 */
(function () {
  const REGISTRATION = {
    // MUST equal this package's name verbatim: the Host keys client-module
    // factories by package name and resolves the row as `factories.has(id)`.
    // Any other id loads without registering and fails the web boot audit.
    id: 'dsh-atomcode-bridge',
    factory: function (require) {
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
      let reactDom = null;
      let primitives = null;
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
      const POLL_MS = 5000;

      const S = {
        wrap: {
          maxWidth: '760px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          color: 'var(--dsw-alias-label-primary)',
        },
        titleRow: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          margin: '0 0 2px',
        },
        title: { margin: 0, fontSize: '13px', fontWeight: 600, lineHeight: '20px' },
        live: {
          fontSize: '11px',
          padding: '1px 7px',
          borderRadius: '999px',
          color: 'var(--dsw-alias-state-success-primary)',
          border: '1px solid var(--dsw-alias-state-success-primary)',
        },
        updated: { marginLeft: 'auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
        grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
        card: {
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          borderRadius: '8px',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        },
        cardFull: { gridColumn: '1 / -1' },
        cardTitle: { margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
        row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', fontSize: '12.5px' },
        key: { color: 'var(--dsw-alias-label-tertiary)' },
        val: { color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word', textAlign: 'right' },
        // An UNPINNED knob is a fact about what the bridge is NOT doing, so it is
        // deliberately quieter than a pinned name (which is a live setting the user
        // chose). Same row shape, one step down the label ladder.
        valIdle: { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word', textAlign: 'right' },
        pill: {
          fontSize: '12px',
          fontWeight: 600,
          padding: '2px 10px',
          borderRadius: '6px',
        },
        metrics: { display: 'flex', gap: '14px', flexWrap: 'wrap' },
        metric: { display: 'flex', flexDirection: 'column', gap: '2px' },
        metricNum: { fontSize: '18px', fontWeight: 700, lineHeight: '22px' },
        metricLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
        notice: {
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          borderRadius: '8px',
          padding: '14px 16px',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: '12.5px',
        },
        error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12.5px' },

        // ── 额度读数 chip 与其面板（只给 QUOTA_READOUT 两个变体用） ────────
        // Theme tokens only, no hardcoded colors: a wrong token name fails
        // SILENTLY to a fallback rather than throwing, so these must match the
        // host's real `--dsw-*` names (a sibling plugin burned an incident on
        // `--dsw-alias-state-warning-primary`; the shipped name is `warn`).
        panelHead: {
          display: 'flex',
          alignItems: 'baseline',
          gap: '8px',
          margin: '0 0 8px',
        },
        panelTitle: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
        panelPct: {
          marginLeft: 'auto',
          fontSize: '16px',
          fontWeight: 700,
          lineHeight: '20px',
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--dsw-alias-label-primary)',
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: '6px',
        },
        panelLimited: { fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' },
        panelTrack: {
          height: '6px',
          borderRadius: '3px',
          border: '1px solid var(--dsw-alias-border-l1)',
          overflow: 'hidden',
          margin: '0 0 8px',
        },
        panelFact: { margin: '0 0 2px', fontSize: '11.5px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' },
        panelFactLead: { margin: '0 0 2px', fontSize: '11.5px', lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' },
        // Copied field-for-field from the host's own ContextMeter panel
        // (`.JObwrW_panel` in dsh-client-ui-conversation): the same
        // `z-index:1100`, `--dsw-specific-menu` fill, `--dsw-radius-lg`,
        // `--dsw-menu-backdrop-filter`, `--dsw-elevation-prominent`, and
        // `min(264px, 100vw - 24px)` width.
        //
        // Two details that are easy to "improve" into a bug:
        //   - `border: 0` + the `--dsw-elevation-stroke-color` custom property.
        //     The shell draws that hairline through the elevation token; adding a
        //     literal `1px solid` border stacks a SECOND edge on top of the
        //     shadow, which reads as a fuzzy outline next to the ring.
        //   - the `min()` width, not a flat 264px: a narrow viewport would
        //     otherwise push the fixed panel off-screen.
        panelSurface: {
          zIndex: 1100,
          boxSizing: 'border-box',
          position: 'fixed',
          borderRadius: 'var(--dsw-radius-lg)',
          background: 'var(--dsw-specific-menu)',
          backdropFilter: 'var(--dsw-menu-backdrop-filter)',
          boxShadow: 'var(--dsw-elevation-prominent)',
          '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
          border: 0,
          color: 'var(--dsw-alias-label-secondary)',
          cursor: 'default',
          padding: '12px',
          width: 'min(264px, 100vw - 24px)',
          fontSize: '12px',
          lineHeight: '20px',
        },
      };

      /**
       * The chip's outer pill, drawn as one of the dock's READOUTS.
       *
       * Deliberately weaker than a control: no pill background, no border, and
       * the tertiary label color. Its neighbours (`7 轮`, `21.4M tok`) are
       * session-scoped products; this one is an account-scoped environment
       * fact that happens to be visible here. The visual weight says "different
       * kind of number" without needing a legend.
       *
       * `color` overrides the text color ONLY for the one state that is a real
       * alarm — an exhausted window throttles turns, so it must not be styled
       * like decoration.
       */
      function CHIP_STYLE(color) {
        return {
          fontSize: '11px',
          lineHeight: '16px',
          color,
          whiteSpace: 'nowrap',
          display: 'inline-flex',
          alignItems: 'center',
          // A quiet leading marker distinguishes it from the session pills at
          // a glance without adding another glyph to the strip.
          opacity: color === 'var(--dsw-alias-label-tertiary)' ? 0.85 : 1,
        };
      }

      /**
       * The trigger: bare text, no chrome of its own. `font: inherit` keeps the
       * host's composer typography so the strip does not change height when the
       * chip mounts.
       */
      const CHIP_TRIGGER_STYLE = {
        font: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        color: 'inherit',
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        // The dock row is a readout strip, not a toolbar: nothing here should
        // look pressable. Host hover feedback comes from the panel opening.
        WebkitAppearance: 'none',
      };

      /**
       * Pure formatters, hoisted OUT of the factory closure and attached to the
       * returned module as `__test`. They were untestable while nested inside
       * `factory(require)` (the only way in was the module loader, which needs
       * a browser), and they are exactly the kind of edge-case code that needs
       * tests: 0ms, negative countdowns, null quota, 100% state.
       *
       * The production code below calls these same functions.
       */
      function fmtDuration(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return '—';
        if (ms < 1000) return Math.round(ms) + ' ms';
        return (ms / 1000).toFixed(1) + ' s';
      }

      /** Compact countdown for the CodingPlan rolling-window reset. */
      function fmtCountdown(secs) {
        if (!Number.isFinite(secs) || secs < 0) return '—';
        if (secs >= 3600) return Math.floor(secs / 3600) + 'h' + Math.floor((secs % 3600) / 60) + 'm';
        if (secs >= 60) return Math.floor(secs / 60) + 'm' + Math.round(secs % 60) + 's';
        return Math.round(secs) + 's';
      }

      /** Quota colour: the window being exhausted is the only true error state. */
      function quotaColor(percent, limited) {
        if (limited || (typeof percent === 'number' && percent >= 100)) {
          return 'var(--dsw-alias-state-error-primary)';
        }
        return 'var(--dsw-alias-label-primary)';
      }

      /**
       * Seconds remaining, counted down locally between polls.
       *
       * A negative result means the snapshot is stale (the window reset since the
       * fetch), which is NOT the same as "no data": the caller must clamp to 0
       * and keep showing "已重置" rather than rendering the "—" of a null input.
       */
      function liveRemaining(resetInSecs, fetchedAt, nowMs) {
        if (typeof resetInSecs !== 'number' || !Number.isFinite(resetInSecs)) return null;
        if (!Number.isFinite(fetchedAt)) return null;
        return Math.max(0, resetInSecs - Math.round((nowMs - fetchedAt) / 1000));
      }

      /** The chip label / progress-bar width, given an already-clamped percent. */
      function pctLabel(percent) {
        if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—';
        return Math.round(percent) + '%';
      }

      /** Bar width percent, clamped into [0,100]. */
      function barWidth(percent) {
        if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0;
        return Math.max(0, Math.min(100, percent));
      }

      /**
       * Merge the panel's surface style with the measured anchor position.
       *
       * Extracted because the merge ORDER is the whole bug surface here, and no
       * test renders a portal: `Object.assign({}, surface, anchored, {left:0,
       * top:0})` looks harmless but clobbers the measured coordinates and pins
       * the dialog to the viewport's top-left corner. The off-screen fallback
       * may apply ONLY while the anchoring hook has not measured yet (it returns
       * null), which is what this encodes.
       *
       * @param {object} surface  the static panel surface
       * @param {object|null} anchored  the hook's measured position, or null
       */
      function panelStyle(surface, anchored) {
        return Object.assign({}, surface, anchored ?? { visibility: 'hidden', left: 0, top: 0 });
      }

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
      };

      function StatusPill({ up }) {
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
          up ? '运行中' : '未运行'
        );
      }

      function Row({ label, children }) {
        return h(
          'div',
          { style: S.row },
          h('span', { style: S.key }, label),
          h('span', { style: S.val }, children)
        );
      }

      function Metric({ num, label, color }) {
        return h(
          'div',
          { style: S.metric },
          h('span', { style: { ...S.metricNum, color: color || 'var(--dsw-alias-label-primary)' } }, String(num)),
          h('span', { style: S.metricLabel }, label)
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
          } catch (reason) {
            if (!isCurrent()) return;
            setError(reason && reason.message ? reason.message : String(reason));
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

        return { data, error, updatedAt };
      }

      /**
       * The chip's tooltip text, as a LIST of facts.
       *
       * Split rather than pre-joined so the panel can lay each row out on its
       * own line; the panel joins them itself. `null` entries are dropped, which
       * is what lets a partially-known quota (plan known, expiry not) show the
       * rows it has instead of a ragged sentence with holes in it.
       */
      function quotaFacts(quota, pct, liveSecs) {
        return [
          (quota.plan ? 'CodingPlan ' + quota.plan : 'CodingPlan'),
          [quota.expires, quota.planWindow].filter(Boolean).join(' · '),
          '5 小时窗口已用 ' + pct + '%',
          liveSecs === null ? null : '约 ' + fmtCountdown(liveSecs) + ' 后重置',
        ].filter(Boolean);
      }

      /**
       * The "二进制与配置" card's provider rows, derived from ONE stats snapshot.
       *
       * Two rows, always both, never collapsed into one and never dropped:
       *  - they are TWO DIFFERENT namespaces (ask = daemon model profile, review =
       *    CLI direct entry), and one merged row would read as "same knob, two
       *    names" — the exact confusion 红线 8 exists to prevent;
       *  - a row that disappears when unset is indistinguishable from a host build
       *    that does not report the field at all. So an unpinned knob says so in
       *    words instead of leaving a hole (红线 3: nothing here may fail silently,
       *    and "silently absent" is a failure the user cannot tell from a bug).
       *
       * The fallbacks name the BEHAVIOR, not the absence: "未插手" tells the user
       * AtomCode's own default is authoritative, which is what they would otherwise
       * have to infer from an empty field.
       *
       * @param {object|undefined} cfg  the snapshot's config branch (may predate
       *   these fields entirely — an older host build, or the desktop install copy)
       * @returns {Array<{label:string, value:string, pinned:boolean}>}
       */
      function providerRows(cfg) {
        const src = cfg && typeof cfg === 'object' ? cfg : {};
        const name = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
        const ask = name(src.defaultProvider);
        const review = name(src.reviewDefaultProvider);
        return [
          {
            label: '默认档位（ask）',
            value: ask || '未插手（AtomCode 自己的默认）',
            pinned: ask !== '',
          },
          {
            label: '默认 provider（review）',
            value: review || '未插手（按 config.toml 自动选择）',
            pinned: review !== '',
          },
        ];
      }

      /**
       * Everything the readout renders, derived from ONE stats snapshot.
       *
       * Extracted because both chip variants must agree on what "no quota"
       * means, and the label must be unconstructable while `known` is false:
       * building `'atom · 5小时 ' + pct + '%'` from a `pct` that defaulted to
       * null is what printed `atom · 5小时 null%` for the frame before the first
       * stats response landed. Here `label` simply does not exist unless the
       * quota is known, so the bug cannot be reintroduced by a caller.
       *
       * @param {object|undefined} quota  the snapshot's quota branch
       * @param {number} nowMs            clock for the locally advanced countdown
       */
      function quotaView(quota, nowMs) {
        const known = !!quota && quota.available === true && typeof quota.usagePercent === 'number';
        if (!known) return { known: false };
        const pct = Math.round(quota.usagePercent);
        const limited = quota.limited === true;
        const liveSecs = liveRemaining(quota.resetInSecs, quota.fetchedAt, nowMs);
        return {
          known: true,
          pct,
          limited,
          label: 'atom · 5小时 ' + pct + '%',
          // `quotaColor` answers "is this an alarm?" and returns the PRIMARY
          // label for the normal case — right for the detail page's big metric,
          // wrong here. In the dock the normal state must read as an ambient
          // environment fact beside the session readouts, so the mapping is
          // done here rather than by weakening the shared helper.
          color: limited || quota.usagePercent >= 100
            ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-label-tertiary)',
          facts: quotaFacts(quota, pct, liveSecs),
          barWidth: barWidth(pct),
        };
      }

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
          const id = setInterval(() => setTick((n) => n + 1), 1000);
          return () => clearInterval(id);
        }, [open]);

        // Escape closes, matching the neighbouring popovers.
        useEffect(() => {
          if (!open) return undefined;
          const onKeyDown = (event) => {
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

      function StatusSection(props) {
        // Only render on this plugin's detail page.
        const subject = props && props.subject;
        const name = subject && subject.kind === 'bundle' ? subject.pkg && subject.pkg.name : undefined;
        if (name !== 'dsh-atomcode-bridge') return null;

        const { data, error, updatedAt } = useStats();

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
              h('span', { style: S.live }, '实时'),
              updatedAt
                ? h('span', { style: S.updated }, '更新于 ' + new Date(updatedAt).toLocaleTimeString('zh-CN'))
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
              // CodingPlan 额度（跨两列）
              h(
                'div',
                { style: { ...S.card, ...S.cardFull } },
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
                        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                        h(
                          'div',
                          { style: S.metrics },
                          h(Metric, {
                            num: pctLabel(quotaPct),
                            label: '当前时间窗口用量',
                            color: quotaColor(quotaPct, quota.limited),
                          }),
                          liveResetSecs == null
                            ? null
                            : h(Metric, { num: fmtCountdown(liveResetSecs), label: '距重置' })
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
              ),
              // 启动情况
              h(
                'div',
                { style: S.card },
                h('p', { style: S.cardTitle }, '启动情况'),
                h(
                  'div',
                  { style: { ...S.row, justifyContent: 'flex-start', gap: '10px' } },
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
              // 二进制与配置
              h(
                'div',
                { style: S.card },
                h('p', { style: S.cardTitle }, '二进制与配置'),
                h(Row, { label: '来源' }, bin.source === 'config' ? '配置' : bin.source === 'env' ? '环境变量' : '自动探测'),
                h(Row, { label: '路径' }, binPath),
                h(Row, { label: '审批模式' }, String(cfg.approvalMode)),
                h(Row, { label: '默认工作目录' }, cfg.defaultWorkingDir || '（会话工作目录）'),
                // Two rows, never one merged: these are two DIFFERENT namespaces
                // (see providerRows). Row already wraps children in a primary-color
                // span, so an unpinned value gets one quieter span inside it.
                ...providerRows(cfg).map((r, i) =>
                  h(
                    Row,
                    { key: 'provider-' + i, label: r.label },
                    h('span', { style: r.pinned ? undefined : S.valIdle }, r.value)
                  )
                ),
                h(
                  Row,
                  { label: 'ask 轮数上限' },
                  cfg.askMaxRounds > 0 ? String(cfg.askMaxRounds) + '（有界）' : '不限'
                ),
                h(
                  Row,
                  { label: '评审可用性' },
                  cfg.reviewAvailable
                    ? '可用'
                    : h('span', { style: S.error }, '不可用 — 改用 atomcode_ask')
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
                h(
                  'div',
                  { style: S.metrics },
                  h(Metric, { num: ask.calls, label: 'atomcode_ask 调用' }),
                  h(Metric, { num: ask.ok, label: '成功', color: 'var(--dsw-alias-state-success-primary)' }),
                  h(Metric, { num: ask.err, label: '失败', color: ask.err ? 'var(--dsw-alias-state-error-primary)' : undefined }),
                  h(Metric, { num: review.calls, label: 'atomcode_review 调用' })
                ),
                h(Row, { label: 'ask 累计 tokens' }, String(ask.tokens)),
                h(Row, { label: 'ask 平均耗时' }, fmtDuration(askAvg)),
                h(Row, { label: 'review 平均耗时' }, fmtDuration(reviewAvg))
              )
            )
          );
        }

        return body;
      }

      function apply(ctx) {
        try {
          ctx.slots.inject('plugins.detail.section', function () {
            try {
              return ctx.slots.register(
                {
                  name: 'plugins.detail.section',
                  id: 'atomcode-bridge-status',
                  order: 30,
                },
                StatusSection
              );
            } catch (e) {
              return function () {};
            }
          });
        } catch (e) {
          /* slots service unavailable — degrade silently */
        }

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

  if (typeof window !== 'undefined' && window.__ModuleLoader__) {
    window.__ModuleLoader__.load(REGISTRATION);
  }
})();
