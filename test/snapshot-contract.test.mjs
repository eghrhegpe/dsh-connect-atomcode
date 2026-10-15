/**
 * snapshot-contract.test.mjs — the stats snapshot as ONE contract across both halves.
 *
 * Why this file exists: the host half and the client half each had thorough
 * tests, and both were green while the panel was broken. `stats-route.test.mjs`
 * asserted that the host writes `provider.review.endpoints`;
 * `client-fns.test.mjs` handed `providerSelectModel` a hand-written fixture
 * carrying `endpoints` on the branch ROOT. Neither suite ever fed the host's
 * real output to the client's reader, so the loopback warning — the one that
 * tells a user their review now bills through a process on their own machine —
 * was unreachable in production and "covered" in tests.
 *
 * A snapshot field is a contract between two bundles that ship in one package
 * but are built, tested and reasoned about separately. Testing each side
 * against its own idea of the shape proves nothing about the joint. This suite
 * closes that joint: it mounts the real host, drives the real stats route, and
 * feeds the resulting body to the real client functions.
 *
 * Hermetic, like the suites it joins: a closed loopback port stands in for the
 * daemon, and the AtomCode config is pinned in a temp HOME.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, after } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'lib', 'index.js');
const CLIENT = join(ROOT, 'client.js');

const CLOSED_PORT = 45993;
const STATS_PATH = '/api/atomcode-bridge/stats';
const REVIEW_FALLBACK = '未插手';

const mod = await import(pathToFileURL(BRIDGE).href);

// ── the client half, loaded off its committed artifact ────────────────────

/** A `require` serving the web boot's seed table (see client-fns.test.mjs). */
function seededRequire() {
  return (name) => {
    if (name === 'react') {
      return {
        createElement: () => null,
        useState: () => [null, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null }),
        useCallback: (fn) => fn,
      };
    }
    if (name === 'react-dom') return { createPortal: (node) => ({ portal: node }) };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Tooltip: () => null,
        useAnchoredPosition: () => ({ left: 10, top: 20 }),
        useDismissOnOutsidePointer: () => {},
      };
    }
    throw new Error(`unexpected require(${name})`);
  };
}

async function loadClient() {
  const registered = [];
  const savedWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (reg) => registered.push(reg) } };
  try {
    await import(`${pathToFileURL(CLIENT).href}?contract=${Date.now()}`);
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
  assert.equal(registered.length, 1);
  return registered[0].factory(seededRequire()).__test;
}

// ── the host half, mounted and driven for real ────────────────────────────

function mountRoutes({ statePath, port = CLOSED_PORT, extra = {} }) {
  const routes = [];
  const ctx = {
    get: (name) => {
      if (name === 'tools') return { register: () => () => {} };
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {}; } };
      return undefined;
    },
    logger: { warn() {}, error() {}, info() {} },
    fiber: { entry: { options: { id: 'dsh-atomcode-bridge' } } },
    inject() {},
    effect() {},
    on() {},
  };
  mod.apply(ctx, { auto_start: false, port, state_path: statePath, ...extra });
  return routes;
}

async function callRoute(route, { method = 'GET', headers = {}, body } = {}) {
  const captured = { status: 0, headers: {}, body: null, ended: false };
  const response = {
    writeHead(status, hdrs) {
      captured.status = status;
      captured.headers = hdrs || {};
    },
    end(payload) {
      captured.ended = true;
      if (payload === undefined) return;
      try {
        captured.body = JSON.parse(payload);
      } catch {
        captured.body = null;
      }
    },
  };
  const request = { method, headers };
  if (body !== undefined) {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    request[Symbol.asyncIterator] = async function* () {
      yield payload;
    };
  }
  await route.handler(request, response);
  assert.equal(captured.ended, true, 'the handler must end the response');
  return captured;
}

/**
 * One full round trip: mount the host against a pinned AtomCode config and a
 * pinned panel pick, then hand the REAL snapshot to the REAL client reader.
 *
 * @param {string[]} configLines - ~/.atomcode/config.toml contents
 * @param {string|null} panelPick - the review slot's stored pick (null = 未插手)
 */
async function snapshotThenRender(configLines, panelPick) {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-contract-home-'));
  mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
  writeFileSync(join(fakeHome, '.atomcode', 'config.toml'), configLines.join('\n'), 'utf8');
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  const stateDir = mkdtempSync(join(tmpdir(), 'atomcode-contract-state-'));
  const statePath = join(stateDir, 'sessions.json');
  // provider.json lives next to sessions.json and is read PER CALL, so a pick
  // written before the mount is what the snapshot reports.
  if (panelPick !== null) {
    writeFileSync(
      join(stateDir, 'provider.json'),
      JSON.stringify({ version: 1, ask: null, review: panelPick, updatedAt: Date.now() }),
      'utf8',
    );
  }

  try {
    const route = mountRoutes({ statePath }).find((r) => r.path === STATS_PATH);
    assert.ok(route, `${STATS_PATH} must be registered`);
    const res = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
    assert.equal(res.status, 200);
    const client = await loadClient();
    return {
      body: res.body,
      model: client.providerSelectModel(res.body.provider, 'review', REVIEW_FALLBACK),
    };
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const LOOPBACK_CONFIG = [
  'default_provider = "atomcode-local"',
  '[providers.atomcode-local]',
  'provider = "openai"',
  'base_url = "http://127.0.0.1:8899/v1"  # 本地代理',
  'api_key = "local-proxy-any-string"',
  'model = "deepseek-ai/DeepSeek-V4-Flash"',
  '',
  '[providers.far-away]',
  'base_url = "https://openrouter.example/v1"',
  'api_key = "sk-test"',
];

describe('snapshot contract — host snapshot read by the client reader', () => {
  after(() => {
    /* temp dirs are reclaimed per case */
  });

  it('the host-written endpoints reach the client that warns about them', async () => {
    // THE regression this file exists for. Both halves were green while the
    // warning was dead: the host writes provider.review.endpoints, the client
    // read provider.endpoints. Assert the joint, not either side alone.
    const { body, model } = await snapshotThenRender(LOOPBACK_CONFIG, 'atomcode-local');
    assert.equal(
      body.config.reviewAvailable,
      true,
      'the fixture must describe a host where review is provisioned',
    );
    assert.deepEqual(
      body.provider.review.endpoints['atomcode-local'],
      'http://127.0.0.1:8899/v1',
      'the host must publish the endpoint for the pinned entry',
    );
    assert.equal(model.disabled, false, 'the control still works — this is a dependency, not a refusal');
    assert.match(
      model.warning,
      /本地端点 http:\/\/127\.0\.0\.1:8899\/v1/,
      'a loopback pick must name the local process the review now depends on',
    );
  });

  it('a remote pick carries no warning down the same joint', async () => {
    // The counter-case: a blanket warning is how a real one gets trained out,
    // so the joint must distinguish the two, not merely fire.
    const { model } = await snapshotThenRender(LOOPBACK_CONFIG, 'far-away');
    assert.equal(model.warning, '');
  });

  it('an unpinned review slot says nothing rather than inventing a target', async () => {
    // No pick on disk: `target` falls back to `effective`, and an empty one must
    // not be looked up in the endpoint map — `endpoints['']` is undefined, and
    // isLoopbackEndpoint('') is false, so this is a silence, not a guess.
    const { model } = await snapshotThenRender(LOOPBACK_CONFIG, null);
    assert.equal(model.warning, '');
  });

  it('a host with no usable provider still renders a disabled control with a reason', async () => {
    const { model } = await snapshotThenRender(['# no providers at all'], null);
    assert.equal(model.disabled, true);
    assert.notEqual(model.reason, '', 'a disabled dropdown must say why (红线 3)');
  });
});
