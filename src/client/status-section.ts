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
 * Nothing in here is a behaviour change: the body was moved verbatim (indent
 * re-based, text unchanged). Seats, ordering, wording and the degradation
 * notices are exactly as they were.
 *
 * @module dsh-connect-atomcode/client/status-section
 */
import type { ReactElement } from 'react';
import { S } from './styles.ts';
import {
  barWidth,
  fmtCountdown,
  fmtDuration,
  liveRemaining,
  pctLabel,
  quotaColor,
  windowLabel,
} from './quota.ts';
import { daemonStatusLine, protocolDriftNotice, providerRows, turnBoundaryRows } from './rows.ts';

/** One render prop for `Row` / `Metric` / `CallStat` — see index.ts. */
type NumProps = { num: number; label: string; color?: string };

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
  StatusPill: (props: { up: boolean }) => ReactElement;
  Row: (props: { label: string }, children?: unknown) => ReactElement;
  Metric: (props: NumProps) => ReactElement;
  CallStat: (props: NumProps) => ReactElement;
  /** The model dropdown row (ask + review are two namespaces — 红线 8). */
  ProviderSelectRow: (props: any) => ReactElement;
}

/**
 * Build the status panel component.
 *
 * @param {StatusSectionDeps} deps
 * @returns {(props: any) => ReactElement} the `StatusSection` component.
 */
export function createStatusSection(deps: StatusSectionDeps) {
  const { h, useStats, StatusPill, Row, Metric, CallStat, ProviderSelectRow } = deps;

  /**
   * The bundle card's one-liner (`view: 'summary'`).
   *
   * DEFINED HERE, not injected: it has exactly one caller — the `view: 'summary'`
   * branch of `StatusSection` below — so it travels with the component that
   * renders it. Injecting it would have made the panel's assembly point carry a
   * dependency only one of its two branches ever touches.
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
      daemonStatusLine(d, data.protocol && data.protocol.daemonVersion),
      '端口 ' + (d.port == null ? '—' : d.port),
    ];
    if (cfg.reviewAvailable === false) parts.push('评审不可用');
    return h('span', { style: S.provLabel, title: parts.join(' · ') }, parts.join(' · '));
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
      // Worded once, rendered once: `''` on an ordinary install (the host sends
      // no unknown types), so the notice cannot become furniture.
      const protoNotice = protocolDriftNotice(proto);
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
        // The SSE-vocabulary twin of the notice above: a renamed event type is
        // the same class of silent degradation (see protocolDriftNotice), and
        // it is the one that can disarm the round fuse while every turn keeps
        // reporting success. Shown whenever the daemon has EVER sent one.
        protoNotice ? h('div', { style: S.notice }, protoNotice) : null,
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
            // WHY it is down, only when it is down. A cause is the one thing
            // "未运行" cannot tell you, and the three causes behind it (nothing
            // listening / a different service holding the port / accepting then
            // going silent) have nothing in common but the symptom.
            !d.up && !d.starting
              ? h(Row, { label: '未就绪原因' }, d.downMessage || '未上报（宿主较旧）')
              : null,
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
            h(Row, { label: '运行时长' }, fmtDuration(data.uptimeMs)),
            // Not a constant row: it renders only while the store reports a
            // degradation, and it names the cause. Without it the panel kept
            // showing a tracked count that had quietly stopped growing, which
            // reads as "nothing to see here" — the exact silent failure 红线 3
            // is about.
            data.sessions && data.sessions.error
              ? h('p', { style: S.error }, '会话续接已降级（回复不受影响）：' + data.sessions.error)
              : null
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
                      ? h('p', { style: S.error }, '当前 ' + windowLabel(quota.planWindow) + ' 窗口已用尽，回合会被限流')
                      : null
                  )
          )
        )
      );
    }

    return body;
  };
}
