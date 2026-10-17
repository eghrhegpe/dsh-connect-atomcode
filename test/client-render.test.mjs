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

/** The web boot's seed table, with the two seed modules the panel touches. */
function seededRequire(react) {
  return (name) => {
    if (name === 'react') return react;
    if (name === 'react-dom') {
      return { createPortal: (node) => ({ type: 'portal', props: {}, children: [node] }) };
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Tooltip: ({ children }) => children || null,
        useAnchoredPosition: () => ({ left: 0, top: 0 }),
        useDismissOnOutsidePointer: () => {},
      };
    }
    throw new Error(`unexpected require(${name})`);
  };
}

async function loadClient(react) {
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
  return registered[0].factory(seededRequire(react));
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

// ── mounting the real registration ─────────────────────────────────────────

/**
 * Run `apply()` against a fake slots service and mount the seats.
 *
 * `inject` is called by `apply` for each seat it wants; the host calls the
 * callback when that seat exists, and the callback calls `register`. The
 * `mounted` latch in `apply` means the FIRST seat that registers wins, so the
 * bundle-config seat takes the panel and the dock seat still gets the chip.
 */
async function mount({ script = [], seats = ['plugins.bundle.config', 'plugins.detail.section', 'conversation.composer.dock'], collectEffects = false } = {}) {
  const react = makeReact(script, { collectEffects });
  const mod = await loadClient(react);
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
    reviewAvailable: true,
    reviewReason: '',
    authored: { approvalMode: false, workingDir: true, askMaxRounds: false },
    defaults: { approvalMode: 'bypass', askMaxRounds: 25 },
  },
  provider: {
    ask: {
      panel: null,
      config: null,
      effective: 'Fake-A',
      source: 'catalog',
      catalog: ['Fake-A', 'Fake-B'],
      catalogError: null,
      endpoints: ['http://127.0.0.1:13459'],
    },
    review: {
      panel: 'atomcode-local',
      config: null,
      effective: 'atomcode-local',
      source: 'panel',
      catalog: ['atomcode-local'],
      catalogError: null,
      endpoints: [],
    },
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
    for (const heading of ['运行统计', 'CodingPlan 额度', '启动情况', '运行环境', '回合边界', '侧边会话', '工具调用统计']) {
      assert.ok(t.includes(heading), `card/section "${heading}" must render`);
    }
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
      'ask 累计 tokens',
      'ask 平均耗时',
      'review 平均耗时',
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

  it('names a refused approval_mode instead of labelling the fallback as the default', async () => {
    const snapshot = {
      ...FULL,
      config: { ...FULL.config, approvalMode: 'bypass', approvalModeRejected: 'bypasss', authored: { ...FULL.config.authorhed, approvalMode: false } },
    };
    const { tree } = await renderPanel(snapshot);
    // Row-scoped: the fallback value is ALSO not the default, and asserting over
    // the whole panel would be satisfied (or broken) by a neighbour row.
    assert.equal(rowValue(tree, '审批模式'), 'bypass（已回落：你写的是 bypasss）', 'the row must name the spelling the user wrote, and never label it the plugin default');
    assert.ok(
      titlesOf(tree).some((title) => title.includes('accept_edits')),
      'the tooltip must list the values the daemon accepts',
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

  it('explains an unavailable review CLI with the host\'s own reason', async () => {
    const snapshot = {
      ...FULL,
      config: { ...FULL.config, reviewAvailable: false, reviewReason: 'config.toml 里没有直连条目' },
    };
    const { tree } = await renderPanel(snapshot);
    const t = text(tree);
    assert.ok(t.includes('代码评审（atomcode_review）当前不可用：config.toml 里没有直连条目'), `the cause is a local config fact, not a transient fault: ${t}`);
    assert.ok(t.includes('侧边咨询（atomcode_ask）不受影响'), 'the reader must know the other tool still works');
    assert.ok(t.includes('评审可用性'), 'and the runtime card must carry the same fact');
  });

  it('renders the two dropdowns DISABLED with a reason on an older host with no provider branch', async () => {
    const snapshot = { ...FULL, provider: null, config: { ...FULL.config } };
    const { tree } = await renderPanel(snapshot);
    const t = text(tree);
    assert.ok(t.includes('atomcode_ask') || t.includes('ask 档位'), `the ask control must still be on the panel: ${t}`);
    assert.ok(t.includes('atomcode_review') || t.includes('review 档位'), 'and so must the review control');
    const selects = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === 'select') selects.push(node);
      walk(node.children);
    })(tree);
    assert.equal(selects.length, 2, 'both namespaces get their own control');
    for (const select of selects) {
      assert.equal(select.props.disabled, true, 'an empty dropdown is forbidden — it must be disabled');
      assert.ok(typeof select.props.title === 'string' && select.props.title.length > 0, 'and it must say why');
    }
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
    assert.ok(text(mine.tree).includes('运行统计'), 'our own bundle is claimed by name');
    const theirs = await renderPanel(FULL, { ...listSeat, subject: { kind: 'bundle', pkg: { name: 'dsh-connect-agnes-token-plan' } } });
    assert.equal(theirs.tree, null, 'another plugin\'s page must render nothing');
    const keyed = await renderPanel(FULL, { view: 'page', subject: { kind: 'bundle', pkg: { name: 'dsh-connect-agnes-token-plan' } }, seats: ['plugins.detail.section'] });
    assert.ok(text(keyed.tree).includes('运行统计'), 'a keyed seat needs no name claim — the host already addressed us');
  });

  it('gives the summary view one line that reports live state', async () => {
    const { tree } = await renderPanel(FULL, { view: 'summary' });
    const t = text(tree);
    assert.ok(t.includes('端口 13459'), `the summary is the card's one-liner: ${t}`);
    assert.ok(t.includes('5.2.3'), 'it may report the daemon build it speaks to');
    assert.ok(!t.includes('运行统计'), 'it must not render the page');
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
      assert.ok(t.includes('运行统计'), 'the panel still renders its frame');
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
  handle.panel({ view: 'page' });
  const leave = runEffects(handle.react);
  armed.push(leave);
  return { handle, published: handle.react.published, leave };
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
