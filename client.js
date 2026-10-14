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
    id: 'atomcode-bridge',
    factory: function (require) {
      const react = require('react');
      const h = react.createElement;
      const useState = react.useState;
      const useEffect = react.useEffect;
      const useRef = react.useRef;
      const useCallback = react.useCallback;

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
      };

      function fmtDuration(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return '—';
        if (ms < 1000) return Math.round(ms) + ' ms';
        return (ms / 1000).toFixed(1) + ' s';
      }

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
          const ask = data.ask || { calls: 0, ok: 0, err: 0, msTotal: 0, tokens: 0 };
          const review = data.review || { calls: 0, ok: 0, err: 0, msTotal: 0 };
          const askAvg = ask.calls > 0 ? Math.round(ask.msTotal / ask.calls) : 0;
          const reviewAvg = review.calls > 0 ? Math.round(review.msTotal / review.calls) : 0;
          const binPath = bin.configured || bin.env || '自动探测（PATH）';
          const spawnNote = d.spawnTried ? (d.up ? '已自动拉起' : '自动拉起失败') : '未触发自动拉起';

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
            h(
              'div',
              { style: S.grid },
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
                h(Row, { label: '拉起状态' }, spawnNote)
              ),
              // 二进制与配置
              h(
                'div',
                { style: S.card },
                h('p', { style: S.cardTitle }, '二进制与配置'),
                h(Row, { label: '来源' }, bin.source === 'config' ? '配置' : bin.source === 'env' ? '环境变量' : '自动探测'),
                h(Row, { label: '路径' }, binPath),
                h(Row, { label: '审批模式' }, String(cfg.approvalMode)),
                h(Row, { label: '默认工作目录' }, cfg.defaultWorkingDir || '（会话工作目录）')
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
      }

      return { inject: ['slots', 'locale'], apply: apply };
    },
  };

  if (typeof window !== 'undefined' && window.__ModuleLoader__) {
    window.__ModuleLoader__.load(REGISTRATION);
  }
})();
