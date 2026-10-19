/**
 * client-render.test.mjs — what the panel RENDERS, not just what it computes.
 *
 * Why this file exists: `client.js` was the one half of this plugin with no
 * render-level gate. `test/client-fns.test.mjs` asserts the pure formatters and
 * `test/client-id.test.mjs` asserts the registration contract, so a field the
 * host stops sending, a branch that divides by nothing, or a row that prints
 * `undefined` could all ship green — the panel is only ever checked by a human
 * looking at it. Coverage said the same thing in numbers: host modules sat at
 * 89–100% of functions, `client.js` at 56%.
 *
 * How it works WITHOUT a browser, a DOM, or a React install:
 * the client half takes React from the loader at FACTORY time
 * (`require('react')` in `src/client/index.ts`, so the app's own instance is
 * used and hooks cannot bind a second copy). That is also the seam this file
 * uses: the factory is handed a RECORDING React whose `createElement` builds a
 * plain descriptor tree and whose `useState` answers from a script. Nothing is
 * mocked that the plugin owns — `StatusSection`, `Row`, `CallStat`,
 * `ProviderSelectRow`, `turnBoundaryRows`, `quotaView` and the styles are all
 * the shipped code paths, executed for real.
 *
 * `useStats` is driven the same way: it is three `useState` calls in a fixed
 * order (`src/client/index.ts`, `function useStats`), and the hook script is a
 * queue consumed in call order across the whole render, so
 * `[snapshot, error, updatedAt]` reaches `data` / `error` / `updatedAt` no
 * matter which component asks first (`StatusSection` or the `summary`
 * one-liner). Effects are recorded and never run — a render must not start a
 * request, which is exactly the browser's behaviour for the first paint too.
 *
 * The invariant that pays for the file is the last `describe`: for a matrix of
 * snapshots (full, empty, sparse, wrong types) the panel must render without
 * throwing and must never print `undefined`, `NaN`, `Infinity` or
 * `[object Object]`. A missing field is a host/plugin version skew — a real
 * state (the desktop install copy and an older host both produce it) — and the
 * panel's answer to it must be a dash or a named reason, never a placeholder
 * that reads like data.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'client.js');
const NOW = 1_700_000_000_000;

// ── a recording React ──────────────────────────────────────────────────────

/**
 * The smallest React that can run these components: `createElement` executes
 * function components EAGERLY (so `Row` / `CallStat` / `ProviderSelectRow` and
 * the `summary` one-liner really run) and returns `{type, props, children}`
 * for host elements. Hooks answer from `script`, a queue shared by the whole
 * render and consumed in call order; an exhausted queue falls back to the
 * initial value, which is what a component that receives no snapshot sees.
 */
function makeReact(script = [], { collectEffects = false } = {}) {
  const queue = [...script];
  // Effects are recorded (not run) and every setState value lands in
  // `published`, so a test can drive one real lifecycle — mount, request,
  // settle, unmount — without a reconciler: run the effect, wait for the
  // publish, re-render with those values as the script.
  const effects = [];
  const published = [];
  return {
    effects,
    published,
    createElement(type, props, ...kids) {
      const children = kids.length === 0 ? [] : kids.length === 1 ? [kids[0]] : kids;
      if (typeof type === 'function') return type({ ...(props || {}), children });
      return { type: String(type), props: props || {}, children };
    },
    useState: (init) => [
      queue.length > 0 ? queue.shift() : init,
      (value) => {
        published.push(value);
      },
    ],
    useEffect: (fn) => {
      if (collectEffects) effects.push(fn);
    },
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
}

/**
 * Run the recorded effects SYNCHRONOUSLY, DRAIN them, and hand back their
 * cleanups.
 *
 * Synchronous on purpose (and draining on purpose): `useStats`'s effect arms the
 * poll interval and calls `load()` without awaiting it, and `load()` runs to its
 * first `await` synchronously — so the fetch and the deadline timer are already
 * installed when this returns. That is what lets a test swap the timer globals
 * around it, and draining keeps a second render from re-running the first
 * instance's effect.
 */
function runEffects(react) {
  const cleanups = [];
  for (const fn of react.effects.splice(0)) {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * The web boot's seed table, with the two seed modules the panel touches.
 *
 * The primitives are RECORDING stubs, not silent ones: `Tooltip`, the anchoring
 * hook and the dismiss hook are the chip's only blind spot (the real ones live
 * in the host's seed table and cannot be imported here), so what a test wants to
 * see is the ARGUMENTS the chip passed them — is the popover anchored while
 * closed, is outside-dismiss armed, is the tooltip disabled while it is open.
 *
 * `seeds` exists to REMOVE them: a host whose seed table lacks `react-dom` or
 * the primitives package is a real state (that is the entire reason
 * `QuotaChipDegraded` exists), and `null` is how a test reaches it.
 */
function seededRequire(react, seeds = {}) {
  const record = seeds.record || [];
  const reactDom =
    seeds.reactDom === null
      ? null
      : seeds.reactDom || {
          createPortal: (node, container) => ({ type: 'portal', props: { container }, children: [node] }),
        };
  const primitives =
    seeds.primitives === null
      ? null
      : seeds.primitives || {
          Tooltip: (props) => {
            record.push({ hook: 'Tooltip', props });
            return props.children || null;
          },
          useAnchoredPosition: (args) => {
            record.push({ hook: 'anchored', args });
            return { left: 0, top: 0 };
          },
          useDismissOnOutsidePointer: (...args) => {
            record.push({ hook: 'dismiss', args });
          },
        };
  return (name) => {
    if (name === 'react') return react;
    if (name === 'react-dom') return reactDom;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected require(${name})`);
  };
}

async function loadClient(react, seeds = {}) {
  const registered = [];
  const savedWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (reg) => registered.push(reg) } };
  try {
    await import(`${pathToFileURL(CLIENT).href}?render=${Date.now()}_${Math.random()}`);
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
  assert.equal(registered.length, 1, 'client.js must register exactly one module');
  return registered[0].factory(seededRequire(react, seeds));
}

// ── reading a rendered tree ────────────────────────────────────────────────

/** Every visible string in a descriptor tree, in document order. */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const kid of node) textOf(kid, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  textOf(node.children, out);
  return out;
}

const text = (node) => textOf(node).join(' | ');

/** Every node that carried a `title` attribute (the panel's tooltips). */
function titlesOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const kid of node) titlesOf(kid, out);
    return out;
  }
  if (typeof node.props?.title === 'string') out.push(node.props.title);
  titlesOf(node.children, out);
  return out;
}

/**
 * The value cell of a `Row` (a `div` of exactly `[label span, value span]`),
 * as rendered text. Row-scoped assertions are the point: asserting over the
 * whole panel is how a test "proves" something that a neighbour row printed.
 */
function rowValue(node, label) {
  let found = null;
  (function walk(n) {
    if (found !== null || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const kid of n) walk(kid);
      return;
    }
    const kids = n.children;
    if (n.type === 'div' && Array.isArray(kids) && kids.length === 2) {
      const [a, b] = kids;
      if (a && a.type === 'span' && text(a) === label) {
        found = text(b);
        return;
      }
    }
    walk(kids);
  })(node);
  return found;
}

/** Every node matching `pred`, in document order. */
function collect(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const kid of node) collect(kid, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  collect(node.children, pred, out);
  return out;
}

/**
 * The panel's own root, found by the attribution attribute it stamps on itself.
 *
 * The panel prints NO heading of its own — the host page above it already names
 * the plugin, and a second 「运行统计」 above the host's own read as a duplicate —
 * so this attribute is what tells "our panel rendered" apart from "some panel
 * rendered" (and it is also how a human recognizes the panel in DevTools).
 */
const panelRoot = (tree) => collect(tree, (n) => n.props && 'data-dsh-plugin' in n.props)[0] ?? null;

// ── mounting the real registration ─────────────────────────────────────────

/**
 * Run `apply()` against a fake slots service and mount the seats.
 *
 * `inject` is called by `apply` for each seat it wants; the host calls the
 * callback when that seat exists, and the callback calls `register`. The
 * `mounted` latch in `apply` means the FIRST seat that registers wins, so the
 * bundle-config seat takes the panel and the dock seat still gets the chip.
 */
async function mount({ script = [], seats = ['plugins.bundle.config', 'plugins.detail.section', 'conversation.composer.dock'], collectEffects = false, seeds = {} } = {}) {
  const react = makeReact(script, { collectEffects });
  const mod = await loadClient(react, seeds);
  const injections = [];
  const registrations = [];
  const ctx = {
    slots: {
      inject(seat, cb) {
        injections.push({ seat, cb });
      },
      register(options, Component) {
        registrations.push({ seat: options.name, options, Component });
        return () => {};
      },
    },
    locale: { t: (s) => s },
  };
  mod.apply(ctx);
  for (const { seat, cb } of injections) if (seats.includes(seat)) cb();

  const panel =
    registrations.find((r) => r.seat === 'plugins.bundle.config') ??
    registrations.find((r) => r.seat === 'plugins.detail.section');
  const chip = registrations.find((r) => r.seat === 'conversation.composer.dock');
  return { mod, react, injections, registrations, panel: panel && panel.Component, chip: chip && chip.Component };
}

/** Mount the panel with a snapshot already in `useStats`'s state, then render. */
async function renderPanel(snapshot, { view = 'page', subject, error = null, updatedAt = NOW, seats } = {}) {
  const handle = await mount({ script: [snapshot, error, updatedAt], seats });
  return { ...handle, tree: handle.panel({ view, subject }) };
}

// ── snapshots ──────────────────────────────────────────────────────────────

/** A snapshot of the shape a current host sends, with every branch populated. */
const FULL = {
  ok: true,
  name: 'dsh-connect-atomcode',
  displayName: 'AtomCode 桥',
  version: '0.4.3',
  uptimeMs: 3_725_000,
  daemon: {
    up: true,
    port: 13459,
    autoStart: true,
    starting: false,
    spawnTried: true,
    spawnFailures: 0,
    lastCheckedAt: NOW,
    downMessage: '',
  },
  binary: { configured: 'D:\\tools\\atomcode.exe', env: '' },
  config: {
    approvalMode: 'bypass',
    approvalModeRejected: null,
    defaultWorkingDir: 'D:\\repo',
    reviewWorkingDir: '',
    defaultProvider: '',
    reviewDefaultProvider: '',
    askMaxRounds: 25,
    daemonRetrySecs: 0,
    authored: { approvalMode: false, workingDir: true, askMaxRounds: false },
    defaults: { approvalMode: 'bypass', askMaxRounds: 25 },
  },
  // ONE branch, not two namespaces. `panel`/`effective`/`source`/`catalog` sit
  // on the object itself — the host flattened them when the review CLI died, and
  // a fixture that still nests `{ask, review}` would be testing a shape the host
  // no longer sends (and the render would, correctly, show no pick at all).
  provider: {
    storePath: 'C:\\Users\\x\\.dsh\\atomcode-bridge\\provider.json',
    storeError: null,
    foreignVersion: false,
    panel: null,
    config: null,
    effective: 'Fake-A',
    source: 'catalog',
    catalog: ['Fake-A', 'Fake-B'],
    catalogError: null,
  },
  protocol: { daemonVersion: '5.2.3', verifiedGeneration: 3, quotaTextDrift: false, unknownTypes: [] },
  quota: {
    available: true,
    usagePercent: 12,
    plan: 'CodingPlan',
    planWindow: '1d',
    expires: '3d 后',
    resetAt: '18:04',
    resetInSecs: 300,
    // Fresh, so the countdown is the arithmetic under test rather than the
    // stale clamp (that clamp has its own case below).
    fetchedAt: Date.now(),
    limited: false,
    reason: null,
    raw: { usageLine: 'usage 12%', planLine: 'plan CodingPlan' },
  },
  sessions: { tracked: 2, oldestAgeMs: 900_000, error: null },
  // Per-day usage history (the daemon's structured `usage/daily`). Three rows so
  // the "newest first" ordering is a real assertion rather than a coincidence.
  usageTrend: {
    available: true,
    days: 60,
    endDate: '2026-10-19',
    models: ['glm5.3-flash', 'qwen3.8-27b'],
    rows: [
      { date: '2026-10-17', tokens: 2557515, requests: 75 },
      { date: '2026-10-18', tokens: 23851383, requests: 569 },
      { date: '2026-10-19', tokens: 950827, requests: 18 },
    ],
  },
  ask: { calls: 3, ok: 3, err: 0, msTotal: 3_000, tokens: 1_234, inFlight: null },
  review: { calls: 1, ok: 1, err: 0, msTotal: 500 },
};

const IN_FLIGHT = {
  elapsedMs: 12_000,
  rounds: 3,
  completed: 2,
  chars: 400,
  sessionId: 'sess-1',
  lastTool: 'bash',
  tokens: 900,
  workingDir: 'D:\\repo',
  provider: 'Fake-A',
};

// ── the panel ──────────────────────────────────────────────────────────────

describe('client render — the detail panel', () => {
  it('renders every card, every row label and the values behind them', async () => {
    const { tree } = await renderPanel(FULL);
    const t = text(tree);
    assert.ok(panelRoot(tree), 'the panel must mark its own root with data-dsh-plugin');
    for (const heading of ['CodingPlan 额度', '按天用量', '启动情况', '运行环境', '回合边界', '侧边会话', '工具调用统计']) {
      assert.ok(t.includes(heading), `card/section "${heading}" must render`);
    }
    assert.ok(
      !t.includes('运行统计'),
      'the host page above already prints 「运行统计」; the panel must not print a second one',
    );
    for (const label of [
      '套餐',
      '到期',
      '重置于',
      '监听端口',
      '自动启动',
      '拉起状态',
      'daemon 版本',
      'AtomCode',
      '已跟踪会话',
      '最旧一条',
      '运行时长',
      // Both entry points land in these counters (`/atomcode-review` runs through
      // the same `runAsk`), so the label names the SCOPE, not just the tool.
      '经本桥的回合',
      '累计 tokens',
      '平均耗时',
    ]) {
      assert.ok(t.includes(label), `row "${label}" must render`);
    }
    // Values, not just labels: a row that renders its label with an empty or
    // placeholder value is the failure mode this suite exists to catch.
    assert.ok(t.includes('12%'), 'the quota headline must be the percentage');
    assert.ok(t.includes('5m0s 后重置'), `the countdown must be derived locally from the fetch time: ${t}`);
    assert.ok(t.includes('13459'), 'the port must be printed');
    assert.ok(t.includes('5.2.3'), 'the daemon version must be printed');
    assert.ok(t.includes('D:\\tools\\atomcode.exe'), 'the configured binary path must win over PATH');
    assert.equal(rowValue(tree, '运行时长'), '3725.0 s', 'uptime must be formatted, never the raw 3725000 ms');
    assert.ok(t.includes('运行中'), 'the pill must report a live daemon');
    assert.ok(t.includes('已自动拉起'), 'a spawn that answered must not read as "未触发自动拉起"');
  });

  it('clamps a stale countdown to zero instead of printing a negative time', async () => {
    // A snapshot fetched minutes ago (the panel keeps the last one while a
    // reload is failing) must not print "-37s 后重置": the window already reset,
    // so the honest reading is zero.
    const stale = { ...FULL, quota: { ...FULL.quota, fetchedAt: Date.now() - 600_000 } };
    const { tree } = await renderPanel(stale);
    const t = text(tree);
    assert.ok(t.includes('0s 后重置'), `a reset window must clamp to 0s: ${t}`);
    assert.ok(!/-\d+s/.test(t), 'and must never render a negative countdown');
  });

  it('reads the window in real numbers when the structured source supplied them', async () => {
    // Only the daemon's JSON (`/codingplan/usage/summary`) reports how big the
    // window IS; the text source only ever had a percentage. The row appears
    // exactly when those numbers exist — a text reading must not invent them.
    const structured = {
      ...FULL,
      quota: {
        ...FULL.quota,
        source: 'codingplan-json',
        sourceNote: '',
        windowLimit: 200,
        windowUsed: 0,
        windowHours: 5,
        windowMetric: 'calls',
      },
    };
    const { tree } = await renderPanel(structured);
    assert.equal(rowValue(tree, '本窗口'), '0 / 200 次（每 5 小时）');
    const { tree: textOnly } = await renderPanel(FULL);
    assert.equal(rowValue(textOnly, '本窗口'), null, 'a text reading has no window size to print');
  });

  it('says out loud when the reading came from the status text instead', async () => {
    const note = '结构化额度接口不可用（atomcode /codingplan/usage/summary -> HTTP 502），本读数来自 status 文本';
    const { tree } = await renderPanel({
      ...FULL,
      quota: { ...FULL.quota, source: 'status-text', sourceNote: note },
    });
    assert.ok(text(tree).includes(note), text(tree));
    assert.ok(titlesOf(tree).includes(note), 'and the full sentence must be reachable as a tooltip');
    // A reading from the preferred source prints no such apology.
    const { tree: json } = await renderPanel({
      ...FULL,
      quota: { ...FULL.quota, source: 'codingplan-json', sourceNote: '' },
    });
    assert.ok(!text(json).includes('本读数来自 status 文本'));
  });

  it('draws the per-day trend newest first, with an idle day shown as zero', async () => {
    const { tree } = await renderPanel({
      ...FULL,
      usageTrend: {
        ...FULL.usageTrend,
        rows: [
          { date: '2026-10-13', tokens: 0, requests: 0 },
          { date: '2026-10-18', tokens: 23851383, requests: 569 },
        ],
      },
    });
    const t = text(tree);
    assert.equal(rowValue(tree, '10-18'), '23.9M tok · 569 次');
    assert.equal(rowValue(tree, '10-13'), '0 tok · 0 次');
    assert.ok(
      t.indexOf('10-18') < t.indexOf('10-13'),
      'the newest day must be first: the reader opens this card for the latest one',
    );
    assert.ok(t.includes('2026-10-19'), 'the range row must date the data');
  });

  it('names an unavailable trend instead of drawing an empty chart', async () => {
    const { tree } = await renderPanel({
      ...FULL,
      usageTrend: { available: false, reason: '按天用量读取失败：atomcode /codingplan/usage/daily -> HTTP 502' },
    });
    const t = text(tree);
    assert.ok(t.includes('按天用量读取失败'), t);
    assert.ok(t.includes('HTTP 502'), 'the host-worded reason is rendered verbatim, not re-worded');
    // A branch with no rows at all is a different fact from a failed read.
    const { tree: empty } = await renderPanel({ ...FULL, usageTrend: { available: true, rows: [] } });
    assert.ok(text(empty).includes('daemon 没有返回按天记录'), text(empty));
    // And a MISSING branch is a third fact: the host process predates the field.
    // Blaming the daemon here would send the reader to the wrong end of the wire.
    const { tree: absent } = await renderPanel({ ...FULL, usageTrend: undefined });
    const a = text(absent);
    assert.ok(a.includes('宿主未提供按天用量'), a);
    assert.ok(!a.includes('daemon 没有返回按天记录') && !a.includes('按天用量读取失败'), a);
  });

  it('names a refused approval_mode instead of labelling the fallback as the default', async () => {    const snapshot = {
      ...FULL,
      config: { ...FULL.config, approvalMode: 'bypass', approvalModeRejected: 'bypasss', authored: { ...FULL.config.authorhed, approvalMode: false } },
    };
    const { tree } = await renderPanel(snapshot);
    // The "refused" diagnostic is now carried in the panel-settings dropdown's
    // placeholder/title (the read-only row is replaced by the editable control).
    const t = text(tree);
    assert.ok(
      t.includes('bypasss') || t.includes('不覆盖'),
      'the panel must either name the refused spelling or show the editable control with the config value'
    );
  });

  it('reports why the daemon is down, and how many times it was retried', async () => {
    const snapshot = {
      ...FULL,
      daemon: { ...FULL.daemon, up: false, starting: false, spawnTried: true, spawnFailures: 3, downMessage: '本机 13459 没有服务在监听' },
      protocol: { ...FULL.protocol, daemonVersion: null },
      config: { ...FULL.config, daemonRetrySecs: 5 },
    };
    const { tree } = await renderPanel(snapshot);
    const t = text(tree);
    assert.ok(t.includes('未运行'), 'the pill must report a dead daemon');
    assert.ok(t.includes('未就绪原因'), 'a cause is the one thing 未运行 cannot tell the reader');
    assert.ok(t.includes('本机 13459 没有服务在监听'), 'the host\'s own diagnosis must be shown verbatim');
    assert.ok(t.includes('自动拉起失败'), 'a failed pull-up must be named');
    assert.ok(t.includes('失败 3 次（每 5s 重试一次）'), `the retry row must carry the interval: ${t}`);
  });

  it('announces a drifted quota text instead of showing a plausible zero', async () => {
    const snapshot = {
      ...FULL,
      protocol: { ...FULL.protocol, quotaTextDrift: true },
      quota: { ...FULL.quota, available: false, usagePercent: null, reason: '未能从 status 文本中识别出额度' },
    };
    const { tree } = await renderPanel(snapshot);
    const t = text(tree);
    assert.ok(t.includes('额度解析失配'), 'drift is a silent degradation and must be stated');
    assert.ok(t.includes('未能从 status 文本中识别出额度'), 'the parse failure must show its own reason');
    assert.ok(!t.includes('0%'), 'a failed parse must never render as a zero reading');
  });

  it('words a daemon-side upstream failure as the action it needs', async () => {
    // The same drift lamp, a different cause: the daemon itself could not read the
    // quota (an expired CodingPlan answers the gateway with nulls and AtomCode's
    // `status` call degrades to an error string). The old copy told the reader to
    // suspect an AtomCode upgrade — it sent them to check versions when the fix
    // was `/login`. The host words the cause; this pane must word the action.
    const snapshot = {
      ...FULL,
      protocol: { ...FULL.protocol, quotaTextDrift: true },
      quota: {
        ...FULL.quota,
        available: true,
        plan: null,
        usagePercent: null,
        reason: '额度未生效：网关未给出生效窗口（到期时间与剩余天数都是空 —— 本机实测的 CodingPlan 过期形态）（网关报的套餐是 CodingPlan Lite）',
        upstreamFailure: { kind: 'plan-inactive', planName: 'CodingPlan Lite' },
      },
    };
    const { tree } = await renderPanel(snapshot);
    const t = text(tree);
    assert.ok(t.includes('/login'), `the one action that fixes an expired trial must be named: ${t}`);
    assert.ok(t.includes('额度未生效'), 'and the host-worded cause must still be on the page');
    assert.ok(!t.includes('AtomCode 可能已升级'), 'an upstream failure is not a drifted vocabulary');
    const [quotaTab] = collect(tree, (n) => n.props && n.props.role === 'tab' && text(n).includes('用量'));
    assert.match(
      String(quotaTab?.props?.title || ''),
      /\/login/,
      'the tab marker must carry the action too, since the pane is one click away'
    );
  });

  it('keeps the upgrade wording for a genuine vocabulary drift', async () => {
    // Reverse guard: with no upstream failure named, the generic diagnostic stays.
    const snapshot = {
      ...FULL,
      protocol: { ...FULL.protocol, quotaTextDrift: true },
      quota: { ...FULL.quota, available: true, plan: null, usagePercent: null, upstreamFailure: null },
    };
    const { tree } = await renderPanel(snapshot);
    const t = text(tree);
    assert.ok(t.includes('额度解析失配'), 'unknown shapes still get the drift wording');
    assert.ok(!t.includes('/login'), 'and must not be blamed on an expired plan');
  });

  it('rides the freshness cluster on the tab strip\'s own row, with no header bar above', async () => {
    const { tree } = await renderPanel(FULL);
    // `role="tablist"` may only contain tabs, so the cluster has to be a SIBLING
    // of the strip inside a shared flex row — and that row owns the border the
    // active tab's underline sits on. One row, not two: the panel used to spend a
    // whole header bar (title + cluster) on what this row can hold.
    const row = collect(
      tree,
      (n) => Array.isArray(n.children) && n.children.some((kid) => kid && kid.props && kid.props.role === 'tablist'),
    )[0];
    assert.ok(row, 'the strip must live in a row that can also host the freshness cluster');
    const rowText = text(row);
    for (const fact of ['运行', '用量', '会话', '实时', '刷新']) {
      assert.ok(rowText.includes(fact), `"${fact}" must ride that one row: ${rowText}`);
    }
    const page = panelRoot(tree);
    assert.equal(
      page.children.filter(Boolean).length,
      1,
      'the panel root holds ONLY the scrolling body — a header bar of its own is what used to sit here',
    );
    // Nothing drifted in this snapshot, so no tab may wear the marker.
    const tabs = collect(tree, (n) => n.props && n.props.role === 'tab');
    assert.equal(tabs.length, 3, 'one tab per pane');
    for (const tab of tabs) {
      assert.equal(tab.props.title, undefined, 'a clean panel puts no tooltip on its tabs');
      assert.ok(!text(tab).includes('!'), 'and marks none of them');
    }
  });

  it('puts each degradation inside the tab it belongs to, and names it on that tab', async () => {
    const snapshot = {
      ...FULL,
      protocol: { ...FULL.protocol, quotaTextDrift: true, unknownTypes: ['tool_end'] },
    };
    const { tree } = await renderPanel(snapshot);
    const panes = collect(tree, (n) => n.props && n.props.role === 'tabpanel');
    assert.equal(panes.length, 3, 'one pane per tab');
    const [runtime, quota, session] = panes;
    assert.ok(
      text(quota).includes('额度解析失配'),
      'quota drift belongs to the 用量 pane, where the quota card it explains is',
    );
    assert.ok(!text(runtime).includes('额度解析失配'), 'and must not also sit in 运行');
    assert.ok(
      text(runtime).includes('协议漂移'),
      'protocol drift belongs to the 运行 pane, whose 回合边界 counts exactly those events',
    );
    assert.ok(!text(quota).includes('协议漂移'), 'and must not also sit in 用量');
    assert.ok(!text(session).includes('漂移'), 'nor in 会话');
    // Once each: in its own pane, not ALSO as a banner above the strip.
    const whole = text(tree);
    assert.equal(whole.split('额度解析失配').length - 1, 1, 'the quota drift is stated exactly once');
    assert.equal(whole.split('协议漂移').length - 1, 1, 'the protocol drift is stated exactly once');
    // The tab carries the reason, so a degradation inside an unopened tab is
    // still announced from the strip (the guarantee the notices used to buy by
    // living outside the panes).
    const tabs = collect(tree, (n) => n.props && n.props.role === 'tab');
    assert.ok(String(tabs[0].props.title).includes('协议漂移'), 'the 运行 tab names its own anomaly on hover');
    assert.ok(String(tabs[1].props.title).includes('额度解析失配'), 'the 用量 tab does too');
    assert.equal(tabs[2].props.title, undefined, 'a clean tab stays clean');
    assert.ok(text(tabs[1]).includes('!'), 'and the marker is visible without hovering');
    assert.ok(!text(tabs[2]).includes('!'), 'a clean tab carries no marker');
  });

  it('shows the in-flight strip with the poll-lag tooltip while a turn runs', async () => {
    const snapshot = { ...FULL, ask: { ...FULL.ask, inFlight: IN_FLIGHT } };
    const { tree } = await renderPanel(snapshot);
    const t = text(tree);
    assert.ok(t.includes('ask 回合进行中'), 'a running turn must be visible');
    assert.ok(t.includes('bash'), 'the strip must name the most recent tool');
    const strip = titlesOf(tree).find((title) => title.includes('atomcode_ask 回合正在跑'));
    assert.ok(strip, 'the strip must carry its own tooltip');
    assert.ok(strip.includes('最多落后一个轮询周期'), 'the tooltip must state the 5s poll lag');
    assert.ok(strip.includes('最近开始且仍在跑'), 'and that parallel asks show only the newest');
    assert.ok(strip.includes('回复是整轮取回的'), 'and that reply content never appears here');
  });

  it('never renders the in-flight strip when no turn is running', async () => {
    const { tree } = await renderPanel(FULL);
    const t = text(tree);
    assert.ok(!t.includes('ask 回合进行中'), 'an idle bridge must not fabricate a running turn');
    assert.ok(!t.includes('0 次工具调用'), 'and must not render a zero that reads as a stalled turn');
  });

  it('no longer reports a review CLI, because there is no review CLI', async () => {
    // The review route used to be a spawned process that could be "不可用 on
    // this host" for a config reason, and the panel said so in two places. That
    // route died with the CLI: a review is an ask turn over the daemon now, so
    // there is no separate availability fact to report. A stale
    // `reviewAvailable`/`reviewReason` arriving from an older host must be
    // IGNORED rather than rendered — a card claiming a route is unavailable
    // while it demonstrably works is the worst of both.
    const snapshot = {
      ...FULL,
      config: { ...FULL.config, reviewAvailable: false, reviewReason: 'config.toml 里没有直连条目' },
    };
    const { tree } = await renderPanel(snapshot);
    const t = text(tree);
    assert.ok(!t.includes('当前不可用'), `no availability claim may survive: ${t}`);
    assert.ok(!t.includes('评审可用性'), 'and the runtime card must not carry that row');
    assert.ok(!t.includes('config.toml 里没有直连条目'), 'nor echo a reason for a route that no longer reads config.toml');
  });

  it('renders ONE dropdown, DISABLED with a reason, on an older host with no provider branch', async () => {
    const snapshot = { ...FULL, provider: null, config: { ...FULL.config } };
    const { tree } = await renderPanel(snapshot);
    const t = text(tree);
    assert.ok(t.includes('默认对话模型'), `the single control must still be on the panel: ${t}`);
    const selects = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === 'select') selects.push(node);
      walk(node.children);
    })(tree);
    // Three selects now: the model dropdown (disabled when no provider branch),
    // the brief-mode panel-settings dropdown, and the approval-mode dropdown.
    assert.equal(selects.length, 3, 'model dropdown + brief-mode + approval-mode panel-settings dropdowns');
    const modelSelect = selects[0];
    assert.equal(modelSelect.props.disabled, true, 'an empty dropdown is forbidden — it must be disabled');
    assert.ok(typeof modelSelect.props.title === 'string' && modelSelect.props.title.length > 0, 'and it must say why');
  });

  it('says 加载中… with no snapshot, and what failed when the fetch failed', async () => {
    const loading = await renderPanel(null);
    assert.ok(text(loading.tree).includes('加载中…'), 'an empty cache must read as loading, not as zeros');
    const failed = await renderPanel(null, { error: 'HTTP 500' });
    const t = text(failed.tree);
    assert.ok(t.includes('统计信息加载失败：HTTP 500'), 'the failure must be named');
    assert.ok(!t.includes('实时'), 'a fetch that failed must not leave a live badge on the screen');
  });

  it('drops the live badge and dates the data when a reload fails with a snapshot in hand', async () => {
    // The stale-while-error case is the one where the badge has something to be
    // stale ABOUT — the panel keeps showing the last snapshot, so it has to say
    // that the reading is old instead of implying it is live.
    const stale = await renderPanel(FULL, { error: 'HTTP 500' });
    const t = text(stale.tree);
    assert.ok(t.includes('已断开'), `the freshness badge must stop claiming 实时: ${t}`);
    assert.ok(t.includes('最后更新'), 'and must date the reading it is still showing');
    assert.ok(t.includes('统计信息加载失败：HTTP 500'), 'without hiding the failure');
  });

  it('only claims its own bundle on the unkeyed list seat', async () => {
    // The list seat is the FALLBACK for older hosts and it is not keyed, so the
    // component has to prove whose page it is on; a keyed host already proved it.
    // `view: null` is how the list seat is addressed — `renderPanel` defaults to
    // the keyed page view, and `view: undefined` would just re-trigger that default.
    const listSeat = { view: null, seats: ['plugins.detail.section'] };
    const mine = await renderPanel(FULL, { ...listSeat, subject: { kind: 'bundle', pkg: { name: 'dsh-connect-atomcode' } } });
    assert.ok(panelRoot(mine.tree), 'our own bundle is claimed by name');
    const theirs = await renderPanel(FULL, { ...listSeat, subject: { kind: 'bundle', pkg: { name: 'dsh-connect-agnes-token-plan' } } });
    assert.equal(theirs.tree, null, 'another plugin\'s page must render nothing');
    const keyed = await renderPanel(FULL, { view: 'page', subject: { kind: 'bundle', pkg: { name: 'dsh-connect-agnes-token-plan' } }, seats: ['plugins.detail.section'] });
    assert.ok(panelRoot(keyed.tree), 'a keyed seat needs no name claim — the host already addressed us');
  });

  it('gives the summary view one line that reports live state', async () => {
    const { tree } = await renderPanel(FULL, { view: 'summary' });
    const t = text(tree);
    assert.ok(t.includes('端口 13459'), `the summary is the card's one-liner: ${t}`);
    assert.ok(t.includes('5.2.3'), 'it may report the daemon build it speaks to');
    assert.equal(panelRoot(tree), null, 'it must not render the page');
    assert.ok(!t.includes('CodingPlan 额度'), 'and no card may leak into it');
    const unknown = await renderPanel(null, { view: 'summary' });
    assert.ok(text(unknown.tree).includes('状态未知'), 'an unreachable host is the one thing the description cannot say');
  });

  it('registers the composer-dock readout as its own seat', async () => {
    const { chip, registrations } = await mount({ script: [FULL, null, NOW] });
    assert.ok(chip, 'the dock seat must get a component');
    assert.deepEqual(
      registrations.map((r) => r.options.name).sort(),
      ['conversation.composer.dock', 'plugins.bundle.config'],
      'exactly one panel seat and one dock seat — never two panels',
    );
    const tree = chip({});
    const percent = (function find(node) {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) return node.map(find).find(Boolean) || null;
      if (node.props && node.props['data-quota-percent'] !== undefined) return node;
      return find(node.children);
    })(tree);
    assert.ok(percent, 'the chip must carry the percentage as a data attribute');
    assert.ok(text(tree).includes('12%'), `the chip must show the reading: ${text(tree)}`);
  });
});

// ── the invariant ──────────────────────────────────────────────────────────

describe('client render — no shape of snapshot may produce a placeholder', () => {
  const SHAPES = {
    'a full current snapshot': FULL,
    'an entirely empty snapshot': {},
    'branches that are all empty objects': {
      daemon: {},
      binary: {},
      config: {},
      provider: { ask: {}, review: {} },
      protocol: {},
      quota: {},
      sessions: {},
      ask: {},
      review: {},
    },
    'branches that are null': {
      daemon: null,
      binary: null,
      config: null,
      provider: null,
      protocol: null,
      quota: null,
      sessions: null,
      ask: null,
      review: null,
    },
    'a daemon branch with no port': { ...FULL, daemon: { ...FULL.daemon, port: undefined } },
    'strings where numbers belong': {
      ...FULL,
      daemon: { ...FULL.daemon, port: '13459' },
      uptimeMs: 'soon',
      quota: { ...FULL.quota, usagePercent: '12', resetInSecs: '300' },
      ask: { ...FULL.ask, calls: '3', msTotal: '3000' },
      review: { ...FULL.review, calls: '1', msTotal: '500' },
      sessions: { tracked: '2', oldestAgeMs: '900000' },
    },
    'an in-flight turn with nothing but nulls': {
      ...FULL,
      ask: { ...FULL.ask, inFlight: { elapsedMs: null, rounds: null, completed: null, chars: null, sessionId: null, lastTool: null, tokens: null, workingDir: null, provider: null } },
    },
  };

  for (const [name, snapshot] of Object.entries(SHAPES)) {
    it(`renders ${name} without a placeholder or a throw`, async () => {
      const { tree } = await renderPanel(snapshot);
      const t = text(tree);
      for (const placeholder of ['undefined', 'NaN', 'Infinity', '[object Object]']) {
        assert.ok(!t.includes(placeholder), `the panel printed "${placeholder}" for ${name}: ${t}`);
      }
      assert.ok(panelRoot(tree), 'the panel still renders its frame');
    });
  }

  it('renders the same matrix on the summary view and the dock chip', async () => {
    for (const [name, snapshot] of Object.entries(SHAPES)) {
      const summary = await renderPanel(snapshot, { view: 'summary' });
      const st = text(summary.tree);
      assert.ok(st.length > 0, `the summary must say something for ${name}`);
      for (const placeholder of ['undefined', 'NaN', '[object Object]']) {
        assert.ok(!st.includes(placeholder), `the summary printed "${placeholder}" for ${name}: ${st}`);
      }
      const { chip } = await mount({ script: [snapshot, null, NOW] });
      const ct = chip ? text(chip({})) : '';
      for (const placeholder of ['undefined', 'NaN', '[object Object]']) {
        assert.ok(!ct.includes(placeholder), `the chip printed "${placeholder}" for ${name}: ${ct}`);
      }
    }
  });
});

// ── the panel's own lifecycle: one shared request, one deadline, one poll ───

const POLL_MS = 5_000; // mirror of src/client/index.ts
const DEADLINE_MS = 4_000; // POLL_MS - 1000, so a hang surfaces before the next tick

/** Poll `cond` until it holds, or fail with the reason the caller named. */
async function waitFor(cond, what, { timeoutMs = 2_000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * Install a `fetch` stub for the duration of `body` and put the real one back
 * however it ends. Every call is recorded WITH its `signal`, because the
 * interesting question is not only "did it fetch" but "did somebody abort a
 * request a peer was still waiting for".
 */
async function withFetch(handler, body) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  try {
    return await body(calls);
  } finally {
    if (saved === undefined) delete globalThis.fetch;
    else globalThis.fetch = saved;
  }
}

const okResponse = (snapshot) => ({ ok: true, status: 200, json: async () => snapshot });

/** A request that only the deadline can end, rejecting the way an abort does. */
const hungFetch = (call) =>
  new Promise((resolve, reject) => {
    call.init.signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    );
  });

/** Run `body` with the timer globals replaced, then restore them. */
async function withTimers(replace, body) {
  const saved = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  Object.assign(globalThis, replace);
  try {
    return await body();
  } finally {
    Object.assign(globalThis, saved);
  }
}

/**
 * Render ONE MORE instance of the panel on an existing `handle`, with its effect
 * running, and hand back a `leave()`.
 *
 * It must be the same `handle`: `mount()` loads `client.js` afresh under a
 * cache-busting URL, so two `mount()` calls are two module instances and would
 * each get their own `statsCache` — the very sharing these tests exist to check.
 *
 * Every instance is ALSO registered for the `afterEach` sweep: the effect arms a
 * real `setInterval`, and a live interval outlives the tests — the runner waits
 * on a node that never exits and the failure you were trying to read never gets
 * printed. (That is what happened when the first version forgot to unmount.)
 */
const armed = [];
function mountLive(handle) {
  const tree = handle.panel({ view: 'page' });
  const leave = runEffects(handle.react);
  armed.push(leave);
  return { handle, tree, published: handle.react.published, leave };
}

afterEach(() => {
  for (const leave of armed.splice(0)) leave();
});

describe('client render — the shared poll, the hard deadline and the unmount', () => {
  it('two instances share ONE request, and the second one reads the cache instead of fetching', async () => {
    await withFetch(
      async () => okResponse(FULL),
      async (calls) => {
        const handle = await mount({ collectEffects: true });

        const a = mountLive(handle);
        await waitFor(() => a.published.length >= 3, 'A to publish the snapshot');
        assert.equal(calls.length, 1, 'mounting must issue exactly one request');
        assert.equal(a.published[0], FULL, 'and publish the body as data');
        assert.equal(a.published[1], null, 'with no error');

        const b = mountLive(handle); // well inside POLL_MS
        assert.equal(calls.length, 1, 'a fresh cache entry must NOT be fetched a second time');
        assert.equal(b.published.length, 6, 'B published its three state values too');
        assert.equal(b.published[3], FULL, 'B must get the same body from the cache');
        assert.equal(b.published[4], null, 'and the same (absent) error');
      }
    );
  });

  it('an unmount must not abort a request its peer may still be waiting for', async () => {
    let settle;
    await withFetch(
      (call) =>
        new Promise((resolve, reject) => {
          settle = resolve;
          call.init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      async (calls) => {
        const handle = await mount({ collectEffects: true });

        const a = mountLive(handle); // A starts the shared request
        a.leave(); // …and goes away while it is still in flight
        assert.equal(calls[0].init.signal.aborted, false, 'an unmount must not abort a request owned by nobody');

        const b = mountLive(handle);
        assert.equal(calls.length, 1, 'B must adopt the in-flight promise, not start a second request');

        settle(okResponse(FULL));
        await waitFor(() => b.published.length >= 3, 'B to publish the adopted answer');
        assert.equal(b.published[0], FULL, 'the survivor must still get the data');
        assert.equal(b.published[1], null, 'and no error flash for the peer that left');
        assert.equal(b.published.length, 3, 'the unmounted instance must publish NOTHING');
      }
    );
  });

  it('a hung request is reported as the panel deadline, not as a bare AbortError', async () => {
    const timers = [];
    let live;
    await withFetch(hungFetch, async () => {
      const handle = await mount({ collectEffects: true });
      await withTimers({ setTimeout: (fn, ms) => timers.push({ fn, ms }) }, () => {
        live = mountLive(handle); // arms the deadline synchronously
      });
      assert.equal(timers.length, 1, 'exactly one deadline timer per request');
      assert.equal(timers[0].ms, DEADLINE_MS, 'the deadline must fire before the next poll replaces the request');
      timers[0].fn(); // the daemon never answers
    });
    await waitFor(() => live.published.length >= 3, 'the timeout to reach the panel');
    assert.equal(
      live.published[1],
      '面板数据 4s 未返回（daemon 可能卡住）',
      'a wedged daemon must be NAMED; the panel cannot report an AbortError from inside itself'
    );
    assert.equal(live.published[0], null, 'and it must not keep showing a body it never received');
  });

  it('arms the poll at POLL_MS and clears it on unmount', async () => {
    const intervals = [];
    const cleared = [];
    await withFetch(async () => okResponse(FULL), async () => {
      const handle = await mount({ collectEffects: true });
      await withTimers(
        {
          setInterval: (fn, ms) => {
            intervals.push({ fn, ms });
            return intervals.length;
          },
          clearInterval: (id) => cleared.push(id),
        },
        () => {
          const live = mountLive(handle);
          assert.equal(intervals.length, 1, 'mounting arms exactly one poll');
          assert.equal(intervals[0].ms, POLL_MS, 'the poll interval must be POLL_MS');
          assert.deepEqual(cleared, [], 'nothing is cleared while the panel is up');
          live.leave();
        }
      );
      assert.deepEqual(cleared, [1], 'unmounting must clear its own poll, or every card leaks one');
    });
  });

  it('names an HTTP failure, and treats a body without ok as no data — never a throw', async () => {
    await withFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }), async () => {
      const live = mountLive(await mount({ collectEffects: true }));
      await waitFor(() => live.published.length >= 3, 'the HTTP failure to reach the panel');
      assert.equal(live.published[1], 'HTTP 503', 'the status must be named');
      assert.equal(live.published[0], null, 'a failed poll must not present the body as data');
    });

    await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }), async () => {
      const live = mountLive(await mount({ collectEffects: true }));
      await waitFor(() => live.published.length >= 3, 'the body to be rejected');
      assert.equal(live.published[0], null, 'a body without ok is not a snapshot');
      assert.equal(live.published[1], null, 'and it is not an error either — the host said no');
    });
  });
});

// ── the composer chip: the one surface that is always on screen ─────────────

const STATS_PATH = '/api/atomcode-bridge/stats';
const PROVIDER_PATH = '/api/atomcode-bridge/provider';

/** First descriptor in the tree matching `pred` (`null` when there is none). */
function find(node, pred) {
  let hit = null;
  (function walk(n) {
    if (hit !== null || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const kid of n) walk(kid);
      return;
    }
    if (pred(n)) {
      hit = n;
      return;
    }
    walk(n.children);
  })(node);
  return hit;
}

/**
 * A `document` just real enough for the chip's two browser touches.
 *
 * The chip is the ONLY place in the client half that reaches for a browser
 * global — `createPortal(node, document.body)` and `document.addEventListener`
 * for Escape — and every case above renders it CLOSED, so the portal, the
 * open flag and the dismissal had never executed under test at all.
 */
async function withDocument(body) {
  const saved = globalThis.document;
  const listeners = [];
  const bodyEl = { nodeName: 'BODY' };
  globalThis.document = {
    body: bodyEl,
    addEventListener(type, fn) {
      listeners.push({ type, fn, removed: false });
    },
    removeEventListener(type, fn) {
      const found = listeners.find((l) => l.type === type && l.fn === fn);
      if (found) found.removed = true;
    },
  };
  try {
    return await body({ bodyEl, listeners, live: () => listeners.filter((l) => !l.removed) });
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  }
}

/** Render the dock chip with a given `open` flag: `useStats`(3) then [open, tick]. */
async function renderChip(snapshot, open, extra = {}) {
  const handle = await mount({ script: [snapshot, null, NOW, open, 0], ...extra });
  return { ...handle, tree: handle.chip({}) };
}

describe('client render — the composer dock chip', () => {
  it('a closed chip shows the reading and arms nothing', async () => {
    const record = [];
    const { tree, react, mod } = await renderChip(FULL, false, { seeds: { record } });
    const view = mod.__test.quotaView(FULL.quota, Date.now());
    assert.ok(view.known, 'the fixture must produce a readable quota');
    assert.ok(text(tree).includes(view.label), `the chip must show the reading: ${text(tree)}`);
    assert.equal(react.published.length, 0, 'a paint may not publish state');
    const trigger = find(tree, (n) => n.type === 'button');
    assert.ok(trigger, 'the chip must be a real button, not a span that only looks clickable');
    assert.equal(trigger.props['aria-haspopup'], 'dialog');
    assert.equal(trigger.props['aria-expanded'], false);
    assert.equal(find(tree, (n) => n.type === 'portal'), null, 'a closed chip must not render the popover');
    assert.deepEqual(
      record.map((r) => r.hook),
      ['anchored', 'dismiss', 'Tooltip'],
      'the two primitive hooks are a fixed tail, called before the tree is built',
    );
    assert.equal(record[0].args.open, false, 'a closed popover must not be anchored');
    assert.equal(record[0].args.side, 'top');
    assert.equal(record[0].args.gap, 8, 'the gap/margin pair came from the ContextMeter shape');
    assert.equal(record[0].args.margin, 12);
    assert.equal(record[1].args[1], false, 'outside-dismiss must be disarmed while closed');
    assert.equal(record[2].props.disabled, false, 'the tooltip is live while the popover is not');
  });

  it('an open chip renders the portal dialog, sized from the number it prints', async () => {
    const record = [];
    await withDocument(async ({ bodyEl }) => {
      const { tree, mod } = await renderChip(FULL, true, { seeds: { record } });
      const view = mod.__test.quotaView(FULL.quota, Date.now());
      const portal = find(tree, (n) => n.type === 'portal');
      assert.ok(portal, 'the open chip must render through createPortal');
      assert.equal(portal.props.container, bodyEl, 'and it must land on document.body');
      const dialog = find(portal, (n) => n.type === 'div' && n.props.role === 'dialog');
      assert.ok(dialog, 'the popover must be a dialog');
      assert.equal(dialog.props['aria-label'], 'CodingPlan 额度');
      const t = text(dialog);
      assert.ok(t.includes('CodingPlan 额度'), t);
      assert.ok(t.includes(view.pctLabel ?? ''), `the percentage must be in the popover: ${t}`);
      const bar = find(
        dialog,
        (n) => n.type === 'div' && typeof n.props.style?.width === 'string' && n.props.style.width.endsWith('%'),
      );
      assert.ok(bar, 'the popover must draw the same bar the popover style owns');
      assert.equal(bar.props.style.height, '100%', 'the fill is the track child, not the frame');
      assert.equal(bar.props.style.background, view.color, 'and it is coloured from the same reading');
      assert.equal(bar.props.style.width, view.barWidth + '%', 'the bar width and the printed number must be one fact');
      const facts = [];
      (function collect(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const kid of n) collect(kid);
          return;
        }
        if (n.type === 'p') facts.push(n);
        collect(n.children);
      })(dialog);
      assert.equal(facts.length, view.facts.length, 'every fact must render, and nothing else may claim to be one');
      for (const fact of view.facts) assert.ok(t.includes(fact), `the fact "${fact}" must be visible: ${t}`);
      assert.equal(record[0].args.open, true, 'an open popover must be anchored');
      assert.equal(record[1].args[1], true, 'outside-dismiss must be armed while open');
      assert.equal(record[2].props.disabled, true, 'the native tooltip must stand down while the popover replaces it');
      assert.equal(record[2].props.label, view.facts.join(' · '), 'and it carries the facts the popover would show');
    });
  });

  it('Escape closes an open chip, and the listener dies with it — a closed chip never listens', async () => {
    await withDocument(async ({ listeners, live }) => {
      const closed = await renderChip(FULL, false, { collectEffects: true });
      const closedLeave = runEffects(closed.react);
      assert.equal(live().length, 0, 'a closed chip must not hold a keydown listener');
      closedLeave();

      const open = await renderChip(FULL, true, { collectEffects: true });
      await withTimers(
        { setInterval: () => 1, clearInterval: () => {} },
        async () => {
          const leave = runEffects(open.react);
          assert.equal(live().length, 1, 'an open chip listens for Escape');
          assert.equal(live()[0].type, 'keydown');
          live()[0].fn({ key: 'Escape' });
          assert.deepEqual(open.react.published, [false], 'Escape must close the popover');
          leave();
          assert.equal(live().length, 0, 'the cleanup must remove it, or every chip leaks a listener');
        },
      );
      assert.equal(listeners.filter((l) => l.removed).length, 1, 'exactly the open chip registered one');
    });
  });

  it('a host with no primitives seed gets the native-title chip, not a crash', async () => {
    const record = [];
    const { tree, mod, react } = await renderChip(FULL, false, {
      seeds: { primitives: null, reactDom: null, record },
    });
    const view = mod.__test.quotaView(FULL.quota, Date.now());
    assert.equal(record.length, 0, 'the degraded chip must call no primitive hook at all (Rules of Hooks)');
    assert.equal(find(tree, (n) => n.type === 'portal'), null, 'it must not try to portal either');
    assert.equal(tree.props.title, view.facts.join(' · '), 'the facts survive as a native title');
    assert.equal(tree.props['data-quota-percent'], view.pct);
    assert.ok(text(tree).includes(view.label));
    assert.equal(react.published.length, 0, 'and it is still stateless: a chip has nothing to click');
  });

  it('renders nothing at all when the quota is unreadable — an empty dock beats a fabricated 0%', async () => {
    const unreadable = { ...FULL, quota: { ...FULL.quota, available: false, usagePercent: null, reason: 'no status text' } };
    for (const seeds of [{}, { primitives: null, reactDom: null }]) {
      const { tree } = await renderChip(unreadable, false, { seeds });
      assert.equal(tree, null, `the chip must be absent, not a zero: ${text(tree)}`);
    }
  });
});

describe('client render — the provider dropdown write path', () => {
  // ONE control now: the branch is flat and there is a single ladder behind it
  // (`atomcode_ask` and `/atomcode-review` both resolve through it). The label
  // below is what the render actually puts on the select.
  const CONTROL_LABEL = '默认对话模型';
  /** The snapshot every case starts from: `FULL`'s flat provider branch. */
  const FLAT = FULL;
  const selectOf = (tree, label) => find(tree, (n) => n.type === 'select' && n.props['aria-label'] === label);

  /** What the route answers after a successful pick: `{ok, ...providerBranch}`. */
  const writeAnswer = (panel) => ({
    ok: true,
    panel,
    effective: panel,
    source: 'panel',
    catalog: FLAT.provider.catalog,
    catalogError: null,
  });

  it('a pick POSTs the slot and the name, and the answer is ADOPTED instead of waiting for a poll', async () => {
    await withFetch(
      async (call) => (call.url === PROVIDER_PATH ? okResponse(writeAnswer('Fake-B')) : okResponse(FLAT)),
      async (calls) => {
        const handle = await mount({ script: [FLAT, null, NOW], collectEffects: true });
        // Render FIRST (that is what records `useStats`'s effect), then run it:
        // `mount()` only calls `apply()`, and the panel's data comes from the
        // script, so this tree already carries the dropdown.
        const tree = handle.panel({ view: 'page' });
        const leave = runEffects(handle.react);
        try {
          await waitFor(() => handle.react.published.length >= 3, 'the first poll to land');
          const select = selectOf(tree, CONTROL_LABEL);
          assert.ok(select, 'the dropdown must render once the host sends a provider branch');
          assert.equal(select.props.value, '', 'the fixture pins nothing, so the fallback option is selected');

          await select.props.onChange({ target: { value: 'Fake-B' } });

          assert.equal(calls.length, 2, `one write, then a cache commit — no extra poll: ${calls.map((c) => c.url)}`);
          assert.equal(calls[0].url, STATS_PATH);
          assert.equal(calls[1].url, PROVIDER_PATH, 'the pick goes to the plugin route, never to AtomCode config');
          assert.equal(calls[1].init.method, 'POST');
          assert.deepEqual(
            JSON.parse(calls[1].init.body),
            { slot: 'ask', provider: 'Fake-B' },
            'the wire still names the slot, even though there is only one ladder left',
          );
          const adopted = handle.react.published.find((v) => v && v.provider && v.provider.panel === 'Fake-B');
          assert.ok(adopted, 'without adoption the controlled select re-renders from the stale cache and bounces back');
          assert.ok(
            !handle.react.published.some((v) => typeof v === 'string' && v.includes('保存失败')),
            'a success must not print a failure note',
          );
          const after = await renderPanel(adopted);
          assert.equal(selectOf(after.tree, CONTROL_LABEL).props.value, 'Fake-B', 'the dropdown must show the new pick');
          assert.deepEqual(
            adopted.provider.catalog,
            FULL.provider.catalog,
            'and the catalogue must survive the adoption — losing it would blank the dropdown on the next render',
          );
        } finally {
          leave();
        }
      },
    );
  });

  it('a refused write keeps the reason on screen and adopts nothing', async () => {
    await withFetch(
      async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: '状态文件由更新版本的插件写入，本版本不覆盖它' }) }),
      async (calls) => {
        const handle = await mount({ script: [FLAT, null, NOW] });
        const select = selectOf(handle.panel({ view: 'page' }), CONTROL_LABEL);
        await select.props.onChange({ target: { value: 'Fake-B' } });
        assert.equal(calls.length, 1, 'a refused write must not trigger a reload');
        assert.equal(calls[0].url, PROVIDER_PATH);
        const note = handle.react.published.find((v) => typeof v === 'string' && v.startsWith('保存失败：'));
        assert.equal(note, '保存失败：状态文件由更新版本的插件写入，本版本不覆盖它', 'the host reason must reach the user verbatim');
        assert.ok(
          handle.react.published.every((v) => typeof v === 'string' || typeof v === 'boolean'),
          'nothing may be adopted from a refusal',
        );
      },
    );
  });

  it('a write in flight disables the control', async () => {
    // Hook order for a page render: `useStats`(3), then the one
    // `ProviderSelectRow` in `providerRows` order, which takes `[note, pending]`
    // — note first, exactly as the component declares them. If a row ever gains
    // state, this script moves with it.
    const handle = await mount({ script: [FLAT, null, NOW, '', true] });
    const tree = handle.panel({ view: 'page' });
    assert.equal(selectOf(tree, CONTROL_LABEL).props.disabled, true, 'the pending write must lock the control');
  });

  it('names an empty catalogue instead of showing an empty dropdown', async () => {
    const bare = { ...FLAT, provider: { ...FLAT.provider, catalog: [], catalogError: null, panel: null } };
    const { tree } = await renderPanel(bare);
    const select = selectOf(tree, CONTROL_LABEL);
    assert.equal(select.props.disabled, true, 'no catalogue means no control (红线 3)');
    assert.ok(text(tree).includes('daemon 未列出档位'), `the reason must be on screen: ${text(tree)}`);
  });
});
