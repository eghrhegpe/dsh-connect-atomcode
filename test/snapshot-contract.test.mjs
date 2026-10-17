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
import { requireDeadPort, sentinelPort } from './dead-port.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'lib', 'index.js');
const CLIENT = join(ROOT, 'client.js');

/** Sentinel 3 — this fixture IS a refusal, so the suite proves it still is. */
const CLOSED_PORT = await requireDeadPort(sentinelPort(3));
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
    fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
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
 * @param {string|null} panelPick - the stored pick in `provider.json` (null = 未插手)
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
      JSON.stringify({ version: 1, ask: panelPick, updatedAt: Date.now() }),
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
      client,
      model: client.providerSelectModel(res.body.provider, REVIEW_FALLBACK),
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

  it('the pick written by the host is the pick the panel shows', async () => {
    // THE joint. The host writes `provider.json`; the panel reads that pick back
    // out of a snapshot it did not produce. Each half was green while the joint
    // was broken once already (the host wrote `provider.review.endpoints`, the
    // client read `provider.endpoints`), so this asserts the round trip rather
    // than either side against its own fixture.
    //
    // The daemon is down here (CLOSED_PORT), so the control is disabled with a
    // reason — but the value still round-trips from disk.
    const { body, model } = await snapshotThenRender(LOOPBACK_CONFIG, 'far-away');
    assert.equal(body.provider.panel, 'far-away', 'the host must publish the stored pick as `panel`');
    assert.equal(model.value, 'far-away', 'and the panel must show exactly that even when disabled');
    assert.equal(model.disabled, true, 'no catalogue → disabled with a reason');
    assert.notEqual(model.reason, '', 'the reason must be non-empty');
  });

  it('a pick for a profile the daemon does not list is still shown, not silently dropped', async () => {
    // The daemon here answers nothing (CLOSED_PORT), so there is no catalogue to
    // validate against. A panel that blanked an unknown pick would look like the
    // write failed; showing it and letting the next real turn report the error is
    // the honest half of the contract.
    const { model } = await snapshotThenRender(LOOPBACK_CONFIG, 'atomcode-local');
    assert.equal(model.value, 'atomcode-local', 'the pick survives even when the daemon is down');
    assert.equal(model.disabled, true, 'and the control is disabled because there is no catalogue');
  });

  it('an untouched panel says so rather than inventing a target', async () => {
    const { body, model } = await snapshotThenRender(LOOPBACK_CONFIG, null);
    assert.equal(body.provider.panel, null, 'no pick on disk must be published as null, not as a guess');
    assert.equal(model.value, '', 'the control value is empty, not a guess');
    assert.equal(model.options[0].label, REVIEW_FALLBACK, 'the first option is the fallback label');
  });

  it('a sidecar warning is not sent, and the client would ignore it if it were', async () => {
    // The host stops publishing `endpoints`; the client stops reading it. This
    // asserts BOTH halves of that deletion on one real snapshot — a field the
    // client would still act on, or a host still sending one, would be a
    // half-done removal rather than a contract change.
    const { body, client } = await snapshotThenRender(LOOPBACK_CONFIG, 'atomcode-local');
    assert.equal(body.provider.endpoints, undefined, 'the host must publish no endpoint map');
    const branch = { ...body.provider, endpoints: { 'atomcode-local': 'http://127.0.0.1:8899/v1' } };
    assert.equal(
      client.providerSelectModel(branch, REVIEW_FALLBACK).warning,
      '',
      'and the client must ignore one even when handed it',
    );
  });

  it('the protocol drift field is published by the host AND read by the client', async () => {
    // The joint, not either half. Both halves of the deleted `endpoints` warning
    // once had their own passing test while the warning itself was dead — a
    // field the client never reads looks identical to a feature that works, from
    // the inside of each half. Assert that the host publishes the drift list and
    // that the client reads THAT field and stays silent on it.
    const { body, client } = await snapshotThenRender(LOOPBACK_CONFIG, null);
    assert.deepEqual(
      body.protocol.unknownTypes,
      [],
      'the host must publish the SSE drift list, empty when nothing drifted',
    );
    assert.equal(
      client.protocolDriftNotice(body.protocol),
      '',
      'an empty list must come out as silence, not as a scare',
    );
  });

  it('a host with no usable provider still renders a disabled control with a reason', async () => {
    const { model } = await snapshotThenRender(['# no providers at all'], null);
    assert.equal(model.disabled, true);
    assert.notEqual(model.reason, '', 'a disabled dropdown must say why (红线 3)');
  });

  it('the host names WHY the daemon is down, and the panel renders THAT sentence', async () => {
    // The joint this branch was missing. `daemon.up` used to be one bit for four
    // causes — nothing listening, a stranger holding the port, a daemon that went
    // silent, a non-2xx answer — and every reader, panel and tool error alike,
    // was told the same thing: "未监听". True of one of them. The host now names
    // the cause and words the sentence; the renderer's job is to show it, not to
    // translate it into a second version that can drift.
    //
    // This fixture IS a refusal: CLOSED_PORT has nothing on it.
    const { body, client } = await snapshotThenRender(['# no providers at all'], null);
    assert.equal(body.daemon.up, false);
    assert.equal(
      body.daemon.downMessage,
      '没有任何进程在监听',
      'the host must name the refusal it actually observed',
    );
    const line = client.daemonStatusLine(body.daemon, null);
    assert.match(line, /没有任何进程在监听/, "the panel must show the host's sentence");
    assert.doesNotMatch(line, /未监听/, 'and must not restore the blanket cause it replaced');
  });
});
