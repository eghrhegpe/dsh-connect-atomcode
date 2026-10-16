/**
 * The renderer's entire style table, moved verbatim out of the factory closure.
 *
 * These are plain CSS-in-JS objects (no theme indirection, no CSS file): every value is
 * either a literal or a `--dsw-alias-*` custom property the host defines, which is what
 * lets the panel inherit the active theme without knowing it exists.
 */

import type { CSSProperties } from 'react';

export const S = {
  wrap: {
    // NO fixed maxWidth. This used to be `760px`, which (a) left long empty
    // margins on a wide window and (b) stopped the two-column card grid from
    // ever using the room it was given. The host's page already constrains the
    // reading measure; we only need a sane upper bound for very wide monitors,
    // and a floor so the grid does not collapse into unreadable slivers.
    width: '100%',
    maxWidth: '1180px',
    minWidth: 0,
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
  // The freshness badge's failure state: same pill, error colour, so a stale
  // readout is visible from across the room instead of being implied by a
  // timestamp nobody watches.
  liveStale: {
    color: 'var(--dsw-alias-state-error-primary)',
    borderColor: 'var(--dsw-alias-state-error-primary)',
  },
  staleReason: { color: 'var(--dsw-alias-state-error-primary)', maxWidth: '40ch' },
  // `auto-fit` + `minmax` is what makes the cards MERGE INTO A ROW on a wide
  // window instead of marching down one per line: columns are packed until the
  // track would fall below 320px, then they wrap. The old rule was a hardcoded
  // `1fr 1fr`, which forced exactly two columns at every width — so a narrow
  // seat squeezed and a wide one wasted (the user's "宽面下卡片没有自动合并行数").
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: '10px',
    alignItems: 'start',
  },
  card: {
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    borderRadius: '8px',
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    // Was 8px with no line-height discipline, so a card whose rows wrapped got
    // visibly taller than its neighbour and the grid rows stopped matching.
    gap: '6px',
    minWidth: 0,
  },
  cardTitle: { margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
  // `minHeight` + a fixed `lineHeight` give every row the SAME height whether its
  // value wraps or not, so two cards side by side keep matching row rhythm
  // instead of drifting apart (the "卡片没有最小行距" complaint).
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    fontSize: '12.5px',
    lineHeight: '18px',
    minHeight: '18px',
  },
  key: { color: 'var(--dsw-alias-label-tertiary)' },
  val: { color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word', textAlign: 'right' },
  // An UNPINNED knob is a fact about what the bridge is NOT doing, so it is
  // deliberately quieter than a pinned name (which is a live setting the user
  // chose). Same row shape, one step down the label ladder.
  valIdle: { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word', textAlign: 'right' },
  // An ANOMALY, not a second flavour of idle: the effective value is not what
  // this control shows, or the control cannot be used. It gets the warning
  // colour because it is the one thing in these cards worth noticing.
  valWarn: { color: 'var(--dsw-alias-state-warning-primary)', wordBreak: 'break-word', textAlign: 'right' },
  // The two model controls share ONE line, two cells — the same readout row
  // split in half, so a label can sit above its dropdown without the card
  // growing a row per knob.
  provGrid: { display: 'flex', gap: '10px', fontSize: '12.5px' },
  provCell: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 0', minWidth: 0 },
  provLabel: { color: 'var(--dsw-alias-label-tertiary)' },
  // The dropdown lives in a readout row, so it borrows the row's type scale
  // and stays visually quiet — this is a setting, not a button.
  select: {
    font: 'inherit',
    fontSize: '12.5px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'transparent',
    border: '1px solid rgba(128, 128, 128, 0.35)',
    borderRadius: '5px',
    padding: '2px 6px',
    maxWidth: '100%',
    width: '100%',
  },
  selectOff: { opacity: 0.55 },
  // Sits INLINE in a card title now, so it is sized to be an annotation on that
  // title rather than a standalone badge.
  pill: {
    fontSize: '11px',
    fontWeight: 600,
    padding: '1px 8px',
    borderRadius: '5px',
    lineHeight: '16px',
  },
  metrics: { display: 'flex', gap: '14px', flexWrap: 'wrap' },
  metric: { display: 'flex', flexDirection: 'column', gap: '2px' },
  metricNum: { fontSize: '18px', fontWeight: 700, lineHeight: '22px' },
  metricLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
  // Two labelled groups with a hairline between them: `成功/失败` are ask's
  // OUTCOME and must not read as siblings of review's call count.
  //
  // `alignItems: 'baseline'` on the row keeps the group label on the SAME line as
  // the big numbers — with `flex-start` the 11px label floated at the top while
  // each Metric stacked its own number over its own caption, so the captions
  // landed at the bottom and the row read as scattered text.
  callGroups: { display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'baseline' },
  callGroup: {
    display: 'flex',
    gap: '12px',
    alignItems: 'baseline',
    paddingRight: '16px',
    borderRight: '1px solid var(--dsw-alias-border-l1)',
  },
  callGroupLabel: {
    fontSize: '11px',
    color: 'var(--dsw-alias-label-tertiary)',
    whiteSpace: 'nowrap',
  },
  // An inline counter: number, then its caption a step quieter on the SAME line.
  callStat: { fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap' },
  callStatLabel: { marginLeft: '3px', fontSize: '11px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },
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
  // Fact rows are the panel's CONTENT, not an ambient strip: they read at
  // `label-secondary` (the host ContextMeter panel body color). `tertiary` is
  // reserved for the dock chip, which really is ambient — using it here too
  // made the smallest text the dimmest text, which is what "字体有点暗" was.
  // The lead row differs from the rest by position alone, not by weight.
  panelFact: { margin: '0 0 2px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  panelFactLead: { margin: '0 0 2px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
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
    // `label-primary`, matching the shell's own `body` color: the panel is a
    // surface that REPLACES a tooltip, so it must not be dimmer than the text
    // around it.
    color: 'var(--dsw-alias-label-primary)',
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
export function CHIP_STYLE(color: string): CSSProperties {
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
export const CHIP_TRIGGER_STYLE = {
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
