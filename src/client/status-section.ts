/**
 * status-section.ts — the detail-page status panel.
 *
 * Split out of `src/client/index.ts` (whose `factory()` had grown to a thousand
 * lines with this component — 350 of them — declared inside it). Same discipline
 * the host half already applied to its own God module: a reader should find a
 * concern by its file name instead of scrolling past nine other definitions.
 *
 * WHY IT IS A `createStatusSection(deps)` FACTORY AND NOT A PLAIN COMPONENT:
 * the client half gets React from the loader at FACTORY time (`require('react')`),
 * and it must be the app's own instance — a module that called `require('react')`
 * for itself could bind a second copy and break hooks. So anything built from
 * `h` (the components) or from hooks (`useStats`) is INJECTED by the assembly
 * point rather than imported here. What this file imports directly is only what
 * is React-free: `S`, and the pure formatters in `quota.ts` / `rows.ts`.
 *
 * LAYOUT (2026-10, rewritten to the sibling sensenova panel's language): a TAB
 * ROW at the head of a scrolling body — the strip (运行 / 用量 / 会话) on the left
 * and the freshness cluster on the right of the SAME row, so the rule under the
 * strip is also the rule under the cluster. The row sits inside the scroll region
 * (the sibling panel does too), so a host that gives the panel a fixed height
 * scrolls it away with the body; the cluster is on the row rather than on a line
 * of its own regardless. Content is grouped into collapsible section cards inside
 * those tabs, the active pane laid out as a responsive grid so a wide window
 * reads two columns instead of one long one. The panel prints NO title of its
 * own: the host page above it already names the plugin, and a second 「运行统计」
 * heading above the host's own read as a duplicate. Hierarchy comes from
 * background steps (section on layer-1, metric blocks on layer-2) instead of a
 * border per row. No data was dropped — every heading and every row is still
 * here, each section just owns a fold of its own and a tab of its own.
 *
 * @module dsh-connect-atomcode/client/status-section
 */
import type { ReactElement } from 'react';
import { S } from './styles.ts';
import {
  barWidth,
  fmtCountdown,
  fmtDuration,
  fmtTokens,
  liveRemaining,
  pctLabel,
  quotaColor,
  windowLabel,
} from './quota.ts';
import {
  daemonStatusLine,
  inFlightText,
  protocolDriftNotice,
  providerRows,
  turnBoundaryRows,
} from './rows.ts';

/** One render prop for `Row` / `CallStat` — see index.ts. */
type NumProps = { num: number; label: string; color?: string };

/**
 * A counter that arrived as anything but a finite number is ZERO, never the
 * word "undefined".
 *
 * The host always sends numbers for these, but a branch can arrive as an EMPTY
 * object — `ask: {}`, a partially-built snapshot, an older host mid-upgrade —
 * and `data.ask || {calls: 0}` does not catch that: an empty object is truthy,
 * so every field under it reaches the renderer as `undefined` and
 * `String(undefined)` puts "undefined 调用" on the panel. A placeholder that
 * reads like a reading is the failure 红线 2 forbids for the quota; a count is
 * the same class of fact, so it gets the same treatment.
 */
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * Everything `StatusSection` needs that is bound to the app's React instance or
 * to the factory's closure. Injected, never imported — see the module header.
 */
export interface StatusSectionDeps {
  h: (type: any, props?: any, ...children: any[]) => ReactElement;
  /** The shared-cache stats hook (one fetch for every mounted instance). */
  useStats: () => {
    data: any;
    error: any;
    updatedAt: number;
    reload: () => void;
  };
  /**
   * The collapse-state hook, consumed by `Section` (each section owns its own
   * fold). `StatusSection` itself takes NO hook for the layout, so the hook
   * order asserted by `test/client-render.test.mjs` (`useStats` then
   * `ProviderSelectRow`) is unchanged by the collapsible skin.
   */
  useState: <T>(initial: T) => [T, (value: T | ((prev: T) => T)) => void];
  StatusPill: (props: { up: boolean }) => ReactElement;
  Row: (props: { label: string }, children?: unknown) => ReactElement;
  CallStat: (props: NumProps) => ReactElement;
  /**
   * The model dropdown row. ONE row: the `atomcode_ask` tool and the
   * `/atomcode-review` command resolve through the same daemon profile ladder,
   * so there is one knob to show (the second namespace died with the review CLI).
   */
  ProviderSelectRow: (props: any) => ReactElement;
  /**
   * The panel-settings controls: brief-mode dropdown + working-dir input.
   * These override the patch fields at execution time (panel-settings.json),
   * so a click takes effect on the very next turn.
   */
  PanelSettingsControls?: (props: { cfg: any; reload?: () => void }) => ReactElement;
  /**
   * The plugin's registered id, stamped on the panel root as `data-dsh-plugin`.
   * Injected rather than imported: the id has ONE definition (the registration
   * in ./index.ts, itself checked against package.json by
   * `test/client-id.test.mjs`), and a second literal here could drift from it.
   * The attribute is what lets a test tell "our panel rendered" from "some panel
   * rendered" while the panel no longer prints a heading of its own.
   */
  panelId: string;
}

/**
 * Build the status panel component.
 *
 * @param {StatusSectionDeps} deps
 * @returns {(props: any) => ReactElement} the `StatusSection` component.
 */
export function createStatusSection(deps: StatusSectionDeps) {
  const { h, useStats, useState, StatusPill, Row, CallStat, ProviderSelectRow, PanelSettingsControls, panelId } = deps;

  /**
   * The bundle card's one-liner (`view: 'summary'`).
   *
   * DEFINED HERE, not injected: it has exactly one caller — the `view: 'summary'`
   * branch of `StatusSection` below — so it travels with the component that
   * renders it.
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
    const parts = [
      daemonStatusLine(d, data.protocol && data.protocol.daemonVersion),
      '端口 ' + (d.port == null ? '—' : d.port),
    ];
    return h('span', { style: S.provLabel, title: parts.join(' · ') }, parts.join(' · '));
  }

  /**
   * One collapsible section: a full-width toggle head (title + chevron) over the
   * body, inside a single layer-1 card.
   *
   * A SEPARATE COMPONENT, on purpose — not a helper rendered inline by
   * `StatusSection`. Each section owns its own collapse state, and React tracks
   * hooks PER COMPONENT. If `StatusSection` called `useState` once up front and
   * passed `open` down, it would add one hook to `StatusSection`'s sequence; the
   * panel also renders `ProviderSelectRow` (the model dropdown), whose own
   * `[note, pending]` pair is asserted by position in `test/client-render.test.mjs`
   * — a comment there warns the script moves if a row gains state. Keeping the
   * fold inside this component means `StatusSection`'s hook order is unchanged
   * by the collapsible layout.
   *
   * The heading is the SAME string a test or a reader greps for, and it stays in
   * the DOM whether the section is open or not (it lives in the toggle button),
   * so nothing that names a section disappears with a click. Sections START
   * open: a panel that greets the reader with six collapsed folds would hide the
   * very facts it exists to show.
   */
  function Section(props: { title: string; titleRight?: any; children?: any }): any {
    const [open, setOpen] = useState(true);
    return h(
      'div',
      { style: S.section },
      h(
        'button',
        {
          style: S.sectionHead,
          onClick: () => setOpen((current) => !current),
          'aria-expanded': open,
          type: 'button',
        },
        h('span', { style: S.sectionTitle }, props.title),
        props.titleRight || null,
        h('span', { style: { ...S.chevron, ...(open ? S.chevronOpen : {}) }, 'aria-hidden': true }, '▾')
      ),
      open ? h('div', { style: S.sectionBody }, props.children) : null
    );
  }

  /**
   * The tab row and its panes. Same rule as `Section` above: it is a separate
   * component so its `useState` never shifts the hook order that
   * `test/client-render.test.mjs` asserts for `StatusSection`.
   *
   * The strip and the freshness cluster share ONE row (`S.tabRow`), whose bottom
   * border is what the active tab's underline sits on. The cluster must stay
   * OUTSIDE `role="tablist"` — a tablist may only contain tabs — so the row
   * splits them with a spacer rather than giving the cluster a header bar of its
   * own above (which is what the panel used to do: a whole row for one badge).
   *
   * Every pane STAYS RENDERED — the inactive ones are `display: none`, not
   * unmounted. Two reasons: the headings a reader (and a test) greps for must
   * not vanish with a click, and a degradation that belongs to a pane must stay
   * findable from the strip. That second one used to be bought by keeping the
   * notices ABOVE the tabs ("a silent degradation must never hide behind a
   * tab"); they now live in the pane they belong to, and such a tab carries
   * `alert` — a visible `!` next to its label plus the reason as its hover title
   * — so the signal is on the strip whichever tab is open. The cost is
   * negligible: the whole panel is a handful of rows.
   *
   * @param {{status?: any, tabs: Array<{label: string, pane: any, alert?: string}>}} props
   *   `status` is the tab-independent freshness cluster; `alert` is non-empty
   *   only on a tab whose pane is carrying a degradation.
   */
  function Tabbed(props: { status?: any; tabs: Array<{ label: string; pane: any; alert?: string }> }): any {
    const [active, setActive] = useState(0);
    return h(
      'div',
      { style: S.tabs },
      h(
        'div',
        { style: S.tabRow },
        h(
          'div',
          { style: S.tabBar, role: 'tablist' },
          props.tabs.map((tab, index) =>
            h(
              'button',
              {
                key: tab.label,
                style: index === active ? { ...S.tab, ...S.tabActive } : S.tab,
                onClick: () => setActive(index),
                'aria-selected': index === active,
                // Only an affected tab gets a title: an unconditional one would
                // put a tooltip on the clean tabs too, where it says nothing.
                ...(tab.alert ? { title: tab.alert } : {}),
                role: 'tab',
                type: 'button',
              },
              tab.label,
              tab.alert ? h('span', { style: S.tabAlert, 'aria-hidden': true }, '!') : null
            )
          )
        ),
        h('span', { style: S.spacer }),
        props.status || null
      ),
      props.tabs.map((tab, index) =>
        h(
          'div',
          {
            key: tab.label,
            style: { ...S.tabPane, display: index === active ? 'grid' : 'none' },
            role: 'tabpanel',
          },
          tab.pane
        )
      )
    );
  }

  return function StatusSection(props: any): any {
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
      if (name !== 'dsh-connect-atomcode') return null;
    }
    if (view === 'summary') {
      return h(SummaryLine, null);
    }

    const { data, error, updatedAt, reload } = useStats();

    let body;
    // Worded ONCE for both places this failure can appear — the bare notice
    // (nothing to show yet) and the strip beside a stale panel — so the same
    // fact never gets two phrasings.
    const failureNote = error ? '统计信息加载失败：' + error : '';
    // `error && !data`, not plain `error`: a failed poll must not throw away the
    // last snapshot. The panel below reports the failure three ways already —
    // the badge turns 已断开, `最后更新 <time>` dates the reading, and the raw
    // notice names the error — so keeping the previous numbers on screen is what
    // a reader wants, not another blank.
    if (error && !data) {
      body = h('div', { style: S.notice }, h('p', { style: S.error }, failureNote));
    } else if (!data) {
      body = h('div', { style: S.notice }, '加载中…');
    } else {
      const d = data.daemon || {};
      const bin = data.binary || {};
      const cfg = data.config || {};
      const quota = data.quota || {};
      // Normalized field by field, not `data.ask || {…}`: an EMPTY branch is
      // truthy, so the fields under it reach the renderer as `undefined`
      // (see `count` above) — `data.ask || {calls: 0}` would only catch `null`.
      const rawAsk = data.ask || {};
      const ask = {
        calls: count(rawAsk.calls),
        ok: count(rawAsk.ok),
        err: count(rawAsk.err),
        msTotal: count(rawAsk.msTotal),
        tokens: count(rawAsk.tokens),
        inFlight: rawAsk.inFlight ?? null,
      };
      const proto = data.protocol || {};
      const protoNotice = protocolDriftNotice(proto);
      // Per-day usage history. Its OWN branch rather than more `quota` rows: it
      // answers a different question (where the tokens went, not what is left),
      // and it can be missing while the quota reading is fine.
      // The branch itself is ABSENT on a host that predates it (this page and the
      // host process are normally the same build, so that is a reload waiting to
      // happen) — say which of the two it is, because "daemon 没有返回" would
      // blame the daemon for a stale host.
      const trendBranch = data.usageTrend;
      const trend = trendBranch || {};
      const trendRows = Array.isArray(trend.rows) ? trend.rows : [];
      const prov = data.provider || null;
      const retryNote = cfg.daemonRetrySecs > 0 ? cfg.daemonRetrySecs + 's' : '每次轮询';
      // Countdown is derived locally from the snapshot's own fetch time, so it
      // never claims to be fresher than the panel that shows it.
      const liveResetSecs = liveRemaining(quota.resetInSecs, quota.fetchedAt, Date.now());
      const quotaPct = typeof quota.usagePercent === 'number' ? quota.usagePercent : null;
      const quotaExpiry = [quota.expires, quota.planWindow].filter(Boolean).join(' · ');
      const askAvg = ask.calls > 0 ? Math.round(ask.msTotal / ask.calls) : 0;
      const binPath = bin.configured || bin.env || '自动探测（PATH）';
      const spawnNote = d.up
        ? d.spawnTried
          ? '已自动拉起'
          : '运行中'
        : d.starting
          ? '正在拉起…'
          : d.spawnTried
            ? '自动拉起失败'
            : '未触发自动拉起';

      // 额度 headline: ONE number plus one clarifying clause — not two peer
      // gauges. `0%` is a RATIO and `1h26m` is a DURATION; rendering both at
      // 18px/700 side by side asked the reader to compare two different
      // quantities as if they were the same kind of fact.
      const quotaCard = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        !quota.available
          ? h('p', { style: S.error }, quota.reason || '额度不可用（daemon 未运行或命令不可用）')
          : quotaPct == null && !quota.plan
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('p', { style: S.key }, quota.reason || '未能从 status 文本中识别出额度'),
                quota.raw && quota.raw.usageLine ? h('p', { style: S.key }, quota.raw.usageLine) : null,
                quota.raw && quota.raw.planLine ? h('p', { style: S.key }, quota.raw.planLine) : null
              )
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
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
                      ),
                      h(
                        'div',
                        { style: S.bar },
                        h('div', {
                          style: {
                            width: barWidth(quotaPct) + '%',
                            background: quotaColor(quotaPct, quota.limited),
                          },
                        })
                      )
                    ),
                h(Row, { label: '套餐' }, quota.plan || '—'),
                h(Row, { label: '到期' }, quotaExpiry || '—'),
                h(Row, { label: '重置于' }, quota.resetAt || '—'),
                // Only the structured source reports the window in real numbers,
                // so this row appears exactly when they exist — the percentage
                // above says how full the window is, this says how big it is.
                quota.windowLimit != null
                  ? h(
                      Row,
                      { label: '本窗口' },
                      `${count(quota.windowUsed)} / ${count(quota.windowLimit)} ${
                        quota.windowMetric === 'calls' ? '次' : quota.windowMetric || ''
                      }${quota.windowHours == null ? '' : `（每 ${quota.windowHours} 小时）`}`
                    )
                  : null,
                quota.limited
                  ? h('p', { style: S.error }, '当前 ' + windowLabel(quota.planWindow) + ' 窗口已用尽，回合会被限流')
                  : null,
                // A reading taken from the status TEXT says so, next to itself.
                // Silence here means the numbers came from the daemon's JSON.
                quota.sourceNote
                  ? h('p', { style: S.key, title: quota.sourceNote }, quota.sourceNote)
                  : null
              )
      );

      // 按天用量 — the daemon's structured history. Seven rows read without
      // scrolling; the host keeps fourteen, so showing more is a client change
      // alone. A day with no usage is a REAL row (the endpoint lists every day in
      // its range), which is what makes an idle stretch visible as such.
      const trendCard = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        trendBranch === undefined
          ? h(
              'p',
              { style: S.key },
              '宿主未提供按天用量（本页连的 host 进程早于该字段，重启 DSH 后出现）'
            )
          : trend.available === false
          ? h('p', { style: S.error }, trend.reason || '按天用量不可用')
          : trendRows.length === 0
            ? h('p', { style: S.key }, 'daemon 没有返回按天记录')
            : [
                ...trendRows
                  .slice(-7)
                  .reverse()
                  .map((row: { date: string; tokens: number; requests: number }) =>
                    h(
                      Row,
                      { key: 'trend-' + row.date, label: String(row.date).slice(5) },
                      fmtTokens(row.tokens) + ' tok · ' + count(row.requests) + ' 次'
                    )
                  ),
                h(
                  Row,
                  { label: '区间' },
                  '最近 ' +
                    Math.min(7, trendRows.length) +
                    ' 天' +
                    (trend.endDate ? ' · 数据到 ' + trend.endDate : '')
                ),
              ]
      );

      // 启动情况
      const startupCard = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(Row, { label: '监听端口' }, d.port == null ? '—' : String(d.port)),
        h(Row, { label: '自动启动' }, d.autoStart ? '开启' : '关闭'),
        h(Row, { label: '拉起状态' }, spawnNote),
        !d.up && !d.starting ? h(Row, { label: '未就绪原因' }, d.downMessage || '未上报（宿主较旧）') : null,
        h(Row, { label: 'daemon 版本' }, proto.daemonVersion || (d.up ? '未知' : '—')),
        !d.up && d.spawnFailures > 1
          ? h(Row, { label: '拉起重试' }, `失败 ${d.spawnFailures} 次（每 ${retryNote} 重试一次）`)
          : null
      );

      // 运行环境
      const envCard = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(Row, { label: 'AtomCode' }, binPath),
        h(
          'div',
          { style: S.provGrid },
          providerRows(cfg).map((row) =>
            h(ProviderSelectRow, {
              key: 'provider-' + row.label,
              label: row.label,
              provider: prov,
              fallbackLabel: row.fallback,
              title: row.title,
              reload,
            })
          )
        )
      );

      // 回合边界
      // The ask control is deliberately NOT on this page: the plugin owns no ask
      // control any more. A review is the `/atomcode-review` command, and a
      // free-form question is the model's `atomcode_ask` tool — both official,
      // neither on a detail page that has no session to run a turn in (see
      // ./review-handoff.ts).
      // Split out of the card above because these are not "runtime": they
      // are the SAFETY POSTURE and SCOPE of a bridged turn.
      // "审批模式" and "ask 轮数上限" remain patch-only (no panel edit);
      // "brief 注入" and "工作目录" are now panel-editable (panel-settings.json),
      // so they render as inline editable controls instead of a read-only row
      // + a duplicate section below.
      const allBoundaryRows = turnBoundaryRows(cfg);
      // All four boundary rows are now panel-editable (approval_mode, ask_max_rounds,
      // brief_mode, working_dir). When PanelSettingsControls is available, the
      // editable controls REPLACE the read-only rows (no duplication). When it is
      // absent (older host without the panel-settings route), fall back to the
      // read-only rendering so the panel still shows the values.
      const boundaryCard = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        PanelSettingsControls
          ? null
          : allBoundaryRows.map((row) =>
              h(Row, { key: 'bound-' + row.label, label: row.label }, h('span', { title: row.title }, row.text))
            ),
        PanelSettingsControls
          ? h(PanelSettingsControls, { cfg, reload })
          : null
      );

      // 侧边会话
      const sessionCard = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(CallStat, { num: count(data.sessions && data.sessions.tracked), label: '已跟踪会话' }),
        data.sessions && typeof data.sessions.oldestAgeMs === 'number'
          ? h(
              Row,
              { label: '最旧一条' },
              h(
                'span',
                {
                  title:
                    '这些会话键里最老一条的存活时长。超过插件设定的存活期的键会被丢弃，之后的 continue 会开一条新线（不会静默复用一条死会话）',
                },
                fmtDuration(data.sessions.oldestAgeMs),
              ),
            )
          : null,
        h(Row, { label: '运行时长' }, fmtDuration(data.uptimeMs)),
        data.sessions && data.sessions.error
          ? h('p', { style: S.error }, '会话续接已降级（回复不受影响）：' + data.sessions.error)
          : null
      );

      // 工具使用
      const toolCard = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(
          'div',
          { style: S.callGroups },
          h(
            'div',
            { style: { ...S.callGroup, borderRight: 'none', paddingRight: 0 } },
            // The scope is BOTH entry points, not just the tool: `/atomcode-review`
            // runs through the same `runAsk`, so it lands in these same counters.
            // Labelling this "atomcode_ask" made a review-only workflow read as
            // "nothing ever ran", which is exactly how the card was being read.
            h(
              'span',
              {
                style: S.callGroupLabel,
                title:
                  '含 atomcode_ask 工具与 /atomcode-review 命令：两者走同一条 daemon /chat 通道，共用这一份计数、熔断与耗时',
              },
              '经本桥的回合'
            ),
            h(CallStat, { num: ask.calls, label: '调用' }),
            h(CallStat, { num: ask.ok, label: '成功', color: ask.ok ? 'var(--dsw-alias-state-success-primary)' : undefined }),
            h(CallStat, { num: ask.err, label: '失败', color: ask.err ? 'var(--dsw-alias-state-error-primary)' : undefined })
          )
        ),
        h(Row, { label: '累计 tokens' }, String(ask.tokens)),
        h(Row, { label: '平均耗时' }, fmtDuration(askAvg))
      );

      // The freshness cluster: the reading's state, its age, and the one verb
      // that refreshes it. It rides the tab row (see `Tabbed`) — there is no
      // header bar of its own any more, and this panel prints no title: the host
      // page above already names the plugin.
      const statusCluster = h(
        'span',
        { style: S.cluster },
        h('span', { style: error ? { ...S.live, ...S.liveStale } : S.live }, error ? '已断开' : '实时'),
        updatedAt
          ? h(
              'span',
              { style: S.updated, title: error || '' },
              (error ? '最后更新 ' : '更新于 ') + new Date(updatedAt).toLocaleTimeString('zh-CN')
            )
          : null,
        error ? h('span', { style: S.staleReason, title: error }, failureNote) : null,
        h('button', { style: S.refresh, onClick: reload, type: 'button' }, '刷新')
      );

      // 静默降级的显式信号：额度读不出来时必须说出来，而不是让面板看起来像"额度为 0"。
      // 它属于「用量」pane —— 配额的读者就在那张卡上；同一段文本还挂在该 tab 的 `alert`
      // 上（可见 '!' + hover 原因），所以「降级藏在 tab 后面」这个顾虑由 tab 自己承担，
      // 不再需要一条跨 tab 的横幅。
      //
      // 三句话，因为读者要做的事不同：**上游坏了**（daemon 自己没读到额度）要给出那个
      // 唯一的动作 —— 在 AtomCode 里 `/login` 续领；**词汇漂移**（AtomCode 升级改了文案）
      // 是要人去核对文本形状。把前者说成"可能已升级"是当年那条通知最误导的地方：它把
      // 用户支去查版本，而真正的答案是套餐过期。原因由 host 写在 `quota.reason` 里，
      // 这里只说动作，两处不重复同一句。
      const upstreamKind = quota.upstreamFailure ? quota.upstreamFailure.kind : null;
      const quotaDrift = proto.quotaTextDrift
        ? upstreamKind === 'plan-inactive'
          ? '额度未生效：AtomCode 自己没读到 CodingPlan 状态，网关那条响应里没有生效窗口（到期时间与剩余天数都是空）。' +
            '在 AtomCode 里运行 /login 续领后刷新本页。下面显示的是 daemon 的原文而非解析结果；' +
            '可手工核对 /api/atomcode-bridge/stats 的 quota.raw。'
          : upstreamKind === 'upstream-parse'
            ? '额度不可用：AtomCode 解析网关的 status-v2 响应失败（原文见下）—— 这不是本面板的解析问题，' +
              '上游恢复后会自动读回。可手工核对 /api/atomcode-bridge/stats 的 quota.raw。'
            : '额度解析失配：daemon 的 status 文本已不符合已知形状（AtomCode 可能已升级），' +
              '下面显示的是原始文本而非解析结果。可手工核对 /api/atomcode-bridge/stats 的 quota.raw。'
        : '';

      const content = h(
        'div',
        { style: S.content },
        h(Tabbed, {
          status: statusCluster,
          tabs: [
            {
              label: '运行',
              // 协议漂移讲的是 daemon 发来的事件类型 —— 这个 pane 里的「回合边界」正是
              // 靠计数那些事件，所以它属于这里，而不是某个 tab 之外的一行页脚。
              alert: protoNotice || undefined,
              pane: [
                // Live strip for a turn running RIGHT NOW — the only fact on this
                // page that changes while the user reads it, so it leads the pane.
                // `paneBanner`: a pane is a grid, so without it the strip would
                // render inside a single 340px column.
                ask.inFlight
                  ? h(
                      'div',
                      { style: { ...S.inFlight, ...S.paneBanner } },
                      h('span', { style: S.inFlightDot }),
                      h(
                        'span',
                        {
                          style: S.inFlightLabel,
                          title:
                            '有一条 atomcode_ask 回合正在跑。数字来自详情页每 5 秒一次的轮询，最多落后一个轮询周期；只报计数与耗时、不含回复内容（回复是整轮取回的）。回合结束后本行消失。' +
                            '模型并行发多条 ask 时这里只报「最近开始且仍在跑」的那一条（面板装不下第二条）；更早的那条跑完或最新那条先跑完，本行都会改报还活着的那条',
                        },
                        'ask 回合进行中',
                      ),
                      h('span', { style: S.inFlightText }, inFlightText(ask.inFlight))
                    )
                  : null,
                protoNotice ? h('div', { style: { ...S.notice, ...S.paneBanner } }, protoNotice) : null,
                h(Section, { title: '启动情况', titleRight: h(StatusPill, { up: !!d.up }) }, startupCard),
                h(Section, { title: '运行环境' }, envCard),
                h(Section, { title: '回合边界' }, boundaryCard),
              ],
            },
            {
              label: '用量',
              alert: quotaDrift || undefined,
              pane: [
                quotaDrift ? h('div', { style: { ...S.notice, ...S.paneBanner } }, quotaDrift) : null,
                h(Section, { title: 'CodingPlan 额度' }, quotaCard),
                h(Section, { title: '按天用量' }, trendCard),
                h(Section, { title: '工具调用统计' }, toolCard),
              ],
            },
            {
              label: '会话',
              pane: [h(Section, { title: '侧边会话' }, sessionCard)],
            },
          ],
        })
      );

      // `data-dsh-plugin` is this panel's own name tag. The host page above prints
      // the plugin's name, so this panel deliberately prints no heading of its own
      // — which would leave a reader (or a test) nothing to recognize it by.
      body = h(
        'div',
        { style: S.page, 'data-dsh-plugin': panelId },
        h('div', { style: S.scroll }, content)
      );
    }

    return body;
  };
}