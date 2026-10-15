/**
 * The renderer's smallest building blocks.
 *
 * Moved verbatim from the pre-TypeScript `client.js`; the additions are the type
 * annotations and the `setH` binding.
 *
 * `h` is NOT imported from 'react': the browser world hands the module factory its own
 * `require`, and the Node suites hand it a stand-in, so React must arrive as an ARGUMENT
 * rather than as a static import. `setH` binds it once at factory time, before anything
 * renders, which is why the binding is module-scoped rather than passed down.
 */

import type { ReactElement } from 'react';
import { S } from './styles.ts';

/** Bound once by the module factory; every component below closes over it. */
let h: (...args: unknown[]) => ReactElement = () => {
  throw new Error('react was not bound: setH() must run before rendering');
};

/** Bind the host's `createElement`. Called once, at factory time. */
export function setH(fn: (...args: unknown[]) => ReactElement): void {
  h = fn;
}

export function StatusPill({ up }: { up: boolean }): ReactElement {
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

export function Row({ label, children }: { label: string; children?: unknown }): ReactElement {
  return h(
    'div',
    { style: S.row },
    h('span', { style: S.key }, label),
    h('span', { style: S.val }, children),
  );
}

export function Metric({
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

export function CallStat({
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
