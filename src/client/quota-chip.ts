/**
 * quota-chip.ts — the composer dock's CodingPlan quota readout.
 *
 * Split out of `src/client/index.ts` (whose `factory()` had grown to a thousand
 * lines). Both chips live in ONE file because they are one feature in two
 * shapes: `QuotaChip` renders the portal popover, `QuotaChipDegraded` renders the
 * same number with a native `title`. They must stay legible as a pair — the
 * reason there are two of them is below, and it is a Rules-of-Hooks argument
 * that only makes sense with both bodies in view.
 *
 * WHY IT IS A `createQuotaChip(deps)` FACTORY AND NOT PLAIN COMPONENTS: the
 * client half gets React from the loader at FACTORY time (`require('react')`)
 * and it must be the app's own instance, so hooks and `h` are INJECTED by the
 * assembly point. The two seed modules (`react-dom`, the primitives package) are
 * injected for the same reason — they are resolved by the factory's `require`,
 * not by an import here. What this file imports directly is only what is
 * React-free: the style object and the pure formatters.
 *
 * Nothing here is a behaviour change: the bodies were moved verbatim (indent
 * re-based, text unchanged).
 *
 * @module dsh-connect-atomcode/client/quota-chip
 */
import type { ReactElement } from 'react';
import { CHIP_STYLE, CHIP_TRIGGER_STYLE, S } from './styles.ts';
import { panelStyle, pctLabel, quotaView } from './quota.ts';
import { inFlightText } from './rows.ts';

/** Everything the chips need that is bound to the app's React instance or to the
 * factory's resolved seeds. Injected, never imported — see the module header. */
export interface QuotaChipDeps {
  h: (type: any, props?: any, ...children: any[]) => ReactElement;
  /** The shared-cache stats hook (one fetch for every mounted instance). */
  useStats: () => { data: any; error: any; updatedAt: number; reload: () => void };
  useState: (initial: any) => [any, (next: any) => void];
  /** The effect may return a cleanup, as the 1s tick and the Escape listener do. */
  useEffect: (effect: () => void | (() => void), deps?: any[]) => void;
  useRef: (initial: any) => { current: any };
  /** `@deepseek-ai/dsh-client-ui-primitives` — Tooltip + anchoring hooks. */
  primitives: any;
  /** `react-dom` — `createPortal`. */
  reactDom: any;
}

/**
 * Build the pair of quota readouts.
 *
 * @param {QuotaChipDeps} deps
 * @returns {{ QuotaChip: () => any, QuotaChipDegraded: () => any }}
 */
export function createQuotaChip(deps: QuotaChipDeps) {
  const { h, useStats, useState, useEffect, useRef, primitives, reactDom } = deps;

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

    const inFlight = data && data.ask ? data.ask.inFlight : null;

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
          label: inFlight ? view.facts.join(' · ') + ' · ' + inFlightText(inFlight) : view.facts.join(' · '),
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
      // In-flight indicator: a pulsing dot + one-line progress, visible only
      // while a turn is running. Lives beside the quota button in the dock so
      // the user sees "it is still working" without navigating to the panel.
      inFlight &&
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginLeft: 6,
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'nowrap',
            },
            title: inFlightText(inFlight),
          },
          h('span', {
            style: {
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'var(--dsw-alias-state-success-primary)',
              flexShrink: 0,
            } as any,
          }),
          inFlightText(inFlight)
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
    const inFlight = data && data.ask ? data.ask.inFlight : null;
    return h(
      'span',
      {
        title: inFlight ? view.facts.join(' · ') + ' · ' + inFlightText(inFlight) : view.facts.join(' · '),
        'data-quota-percent': view.pct,
        style: CHIP_STYLE(view.color),
      },
      view.label,
      inFlight &&
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginLeft: 6,
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'nowrap',
            },
          },
          h('span', {
            style: {
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'var(--dsw-alias-state-success-primary)',
              flexShrink: 0,
            } as any,
          }),
          inFlightText(inFlight)
        )
    );
  }

  return { QuotaChip, QuotaChipDegraded };
}
