/**
 * The renderer's entire style table, moved verbatim out of the factory closure.
 *
 * These are plain CSS-in-JS objects (no theme indirection, no CSS file): every value is
 * either a literal or a `--dsw-alias-*` custom property the host defines, which is what
 * lets the panel inherit the active theme without knowing it exists.
 *
 * The detail-page half was rewritten (2026-10) to the visual language of the
 * sibling `dsh-connect-sensenova-token-plan` panel — the one the user pointed
 * at as "the good-looking one": a PINNED page header over a scrolling body,
 * content grouped into collapsible section cards, and hierarchy carried by
 * BACKGROUND STEPS (layer-1 outer frame, layer-2 inner block) instead of a
 * border per row. Everything that changed is below the "detail page" marker;
 * the composer chip / popover styles are untouched.
 */

import type { CSSProperties } from 'react';

// The accent token is not hoisted here: `--dsw-alias-accent` (with a `#6C5CE7`
// fallback for a shell that defines none) is written inline at each use, and
// tsc's noUnusedLocals rejects a const nobody reads.

/** The shared small button skin (刷新 / 折叠头). */
const BUTTON: CSSProperties = {
  height: 28,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  cursor: 'pointer',
  appearance: 'none',
  fontFamily: 'inherit',
};

export const S = {
  // ── 详情页面板：pinned 页头 + 可滚动 body ──────────────────────────────
  // The card lives in the `plugins.bundle.config` slot of the Plugins page, so
  // the HOST page already owns the outer margins and the reading measure. This
  // root only supplies the flex chain: the pinned header stays `flex: none`,
  // the body takes the overflow, and the card never grows past its container.
  // Without this a long panel grows the page instead of scrolling inside its
  // own frame, and every card below the fold silently disappears.
  page: {
    flex: '1 1 auto',
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 13,
    lineHeight: '20px',
  } as CSSProperties,
  headerBar: { flex: 'none', position: 'relative', zIndex: 1 },
  header: { display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0 10px' },
  // The page's own name. 18px rather than the card's 13: it is the ONLY thing
  // here that is not data, and one larger line gives the panel a readable
  // anchor instead of six equal headings marching down the page.
  title: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '24px', letterSpacing: '-0.01em' },
  // The freshness cluster, pinned to the header's right so it stays put while
  // the body scrolls. `inline-flex` + `flexWrap` lets it shrink instead of
  // pushing the title off a narrow panel.
  cluster: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    marginLeft: 'auto',
  },
  live: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 999,
    color: 'var(--dsw-alias-state-success-primary)',
    border: '1px solid var(--dsw-alias-state-success-primary)',
  },
  liveStale: {
    color: 'var(--dsw-alias-state-error-primary)',
    borderColor: 'var(--dsw-alias-state-error-primary)',
  },
  updated: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  staleReason: { color: 'var(--dsw-alias-state-error-primary)', maxWidth: '40ch', fontSize: 11 },
  refresh: BUTTON,
  scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden' },
  content: { padding: '2px 0 24px', display: 'flex', flexDirection: 'column', gap: 12 },
  // A live strip for a turn that is running RIGHT NOW — the one fact on the
  // page that changes while the user reads it, so it leads the body rather
  // than hiding in the tool-usage card it used to live in.
  inFlight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    borderRadius: 10,
    padding: '8px 12px',
    fontSize: 12.5,
    lineHeight: '18px',
  },
  inFlightDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)', flexShrink: 0 },
  inFlightLabel: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' },
  inFlightText: { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' },
  notice: {
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    borderRadius: 10,
    padding: '12px 14px',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12.5,
  },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12.5 },

  // ── section cards（折叠，默认展开） ────────────────────────────────────
  // One frame per LEVEL, not per row: the section card owns the only border,
  // and the metric blocks inside read by background step (layer-2) instead of
  // drawing a second rectangle. This is the hierarchy that makes six cards
  // read as one page instead of six equal grey boxes.
  // ── 详情页 tab 栏 ────────────────────────────────────────────────────────
  // The panel groups its six sections by theme (运行 / 用量 / 会话) so a wide
  // window reads as a set of cards instead of one long column, and a reader who
  // only wants the quota doesn't scroll past the environment rows to get it.
  // Same shape as the sibling sensenova panel: a borderless button per tab, the
  // active one getting the accent underline. Non-active panes are HIDDEN, not
  // unmounted, so the headings a test or a reader greps for stay in the tree.
  tabs: { display: 'flex', flexDirection: 'column', gap: 12 },
  tabBar: {
    display: 'flex',
    gap: 4,
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
    overflowX: 'auto',
  },
  tab: {
    appearance: 'none',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    padding: '8px 12px',
    fontSize: 13,
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    outline: 'none',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  },
  tabActive: {
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: 600,
    borderBottom: '2px solid var(--dsw-alias-accent, #6C5CE7)',
  },
  tabPane: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
    gap: 12,
    alignItems: 'start',
  },
  section: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1)',
    overflow: 'hidden',
  },
  // The whole header is the toggle (title + rotating chevron). `appearance:
  // none` because the shell stamps its own focus ring on clicked buttons; the
  // weight + chevron below IS the open/closed state.
  sectionHead: {
    appearance: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '10px 14px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  sectionTitle: { margin: 0, flex: '1 1 auto', minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  chevron: { display: 'inline-flex', flex: 'none', transition: 'transform 0.15s ease', color: 'var(--dsw-alias-label-secondary)' },
  chevronOpen: { transform: 'rotate(180deg)' },
  sectionBody: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '0 14px', padding: '10px 0 12px' },

  // ── 数据行（每张卡内共享） ─────────────────────────────────────────────
  // A label-value row keeps the SAME height whether the value wraps or not, so
  // sections beside each other keep a matching rhythm.
  row: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    fontSize: 12.5,
    lineHeight: '18px',
    minHeight: '18px',
  },
  key: { color: 'var(--dsw-alias-label-tertiary)', flexShrink: 0 },
  val: { color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word', textAlign: 'right' },
  // The small status pill (运行中/未运行). The component overrides `background`
  // and `border` with the state color, so this only supplies the shape.
  pill: { display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, lineHeight: '18px', whiteSpace: 'nowrap' },
  // An UNPINNED knob is a fact about what the bridge is NOT doing, so it is
  // deliberately quieter than a pinned name.
  valIdle: { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word', textAlign: 'right' },
  // An ANOMALY — it gets the warning colour because it is the one thing in the
  // card worth noticing. `warn` is the SHIPPED token name; `warning-primary`
  // silently falls back and dims the whole line, which is the incident the
  // sibling plugin burned on.
  valWarn: { color: 'var(--dsw-alias-state-warn-primary)', wordBreak: 'break-word', textAlign: 'right' },
  provGrid: { display: 'flex', gap: 12, fontSize: 12.5 },
  provCell: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 0', minWidth: 0 },
  provLabel: { color: 'var(--dsw-alias-label-tertiary)' },
  select: {
    font: 'inherit',
    fontSize: 12.5,
    color: 'var(--dsw-alias-label-primary)',
    background: 'transparent',
    border: '1px solid rgba(128, 128, 128, 0.35)',
    borderRadius: 5,
    padding: '2px 6px',
    maxWidth: '100%',
    width: '100%',
  },
  selectOff: { opacity: 0.55 },

  // ── 指标块（layer-2，靠背景层次分层） ──────────────────────────────────
  metric: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 12px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)' },
  metricNum: { fontSize: 20, fontWeight: 650, lineHeight: '24px', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' },
  metricLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
  bar: { height: 6, borderRadius: 3, background: 'var(--dsw-alias-bg-layer-1)', overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l1)' },
  barFill: { height: '100%', borderRadius: 3 },

  // ── 工具调用计数（atomcode_ask） ───────────────────────────────────────
  callGroups: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' },
  callGroup: { display: 'flex', gap: 12, alignItems: 'baseline', paddingRight: 16, borderRight: '1px solid var(--dsw-alias-border-l1)' },
  callGroupLabel: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
  callStat: { fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  callStatLabel: { marginLeft: 3, fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },

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
  panelFact: { margin: '0 0 2px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  panelFactLead: { margin: '0 0 2px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
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
 * Deliberately weaker than a control: no pill background, no border.
 * Its neighbours (`1 轮 1 步`, `19.1K tok`) are session-scoped products;
 * this one is an account-scoped environment fact that happens to be
 * visible here. The `tertiary` token alone carries that distinction.
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
  WebkitAppearance: 'none',
};


/**
 * The 锐评 entry in an assistant message's own action row. One state only: the
 * button pre-fills a slash command and returns, so it has no busy state to show
 * (the turn it starts belongs to the composer, not to this row).
 */
export const MESSAGE_ACTION_STYLE: CSSProperties = {
  font: 'inherit',
  fontSize: '11px',
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
  background: 'transparent',
  border: 'none',
  borderRadius: '4px',
  padding: '2px 4px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  WebkitAppearance: 'none',
};

