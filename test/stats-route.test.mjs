/**
 * stats-route.test.mjs — the read-only detail-page stats route.
 *
 * `/api/atomcode-bridge/stats` is the ONLY surface the renderer half talks to,
 * and it previously had zero coverage: the wiring tests registered the route
 * through a shell `webServer.register` that was never invoked, so the handler
 * body (method gate, same-origin gate, snapshot shape) never ran.
 *
 * Hermetic: the plugin is mounted against a CLOSED loopback port, so the health
 * probe resolves `daemon.up: false` without touching a real daemon.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'lib', 'index.js');
const SESSIONS = join(ROOT, 'lib', 'sessions.js');
const mod = await import(pathToFileURL(BRIDGE).href);
const { createSessionStore } = await import(pathToFileURL(SESSIONS).href);

/** A loopback port nothing listens on, so /health fails fast and hermetically. */
const CLOSED_PORT = 45991;
const STATS_PATH = '/api/atomcode-bridge/stats';

const PROVIDER_PATH = '/api/atomcode-bridge/provider';

/**
 * Mount the plugin and capture EVERY route it registers.
 *
 * `toolSink` is optional and additive: pass an array to also collect the tool
 * definitions the mount registers. The snapshot carries per-tool counters
 * (`ask.*` / `review.*`), and asserting those against a real tool call needs the
 * tool object — reading them only through the route would make every such test
 * silently self-consistent.
 */
function captureRoutes({ statePath, port = CLOSED_PORT, extra = {}, toolSink }) {
  const routes = [];
  const ctx = {
    get: (name) => {
      if (name === 'tools') {
        return {
          register: (def) => {
            if (toolSink) toolSink.push(def);
            return () => {};
          },
        };
      }
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
  assert.deepEqual(
    routes.map((r) => r.path).sort(),
    [PROVIDER_PATH, STATS_PATH].sort(),
    'both the stats route and the provider write route must be registered',
  );
  return routes;
}

/**
 * Mount the plugin and return ONE captured route.
 *
 * Two routes are registered now — the read-only snapshot and the panel's own
 * provider write — so the harness selects by path instead of assuming there is
 * only one. Asserting the exact set stays here on purpose: a route silently
 * dropped by a mount change is otherwise invisible until a user clicks a button
 * that does nothing.
 */
function mountRoute({ statePath, port = CLOSED_PORT, extra = {}, path = STATS_PATH }) {
  const found = captureRoutes({ statePath, port, extra }).find((r) => r.path === path);
  assert.ok(found, `route ${path} must be registered`);
  return found;
}

/**
 * Drive a handler the way the panel does.
 *
 * `body` is delivered as an async-iterable request because the provider route
 * reads it with `for await` — the same contract the real Node IncomingMessage
 * gives it. A plain object there would silently take the "could not read the
 * request body" branch and the write path would never be exercised.
 */
async function callRoute(route, { method = 'GET', headers = {}, body } = {}) {
  const captured = { status: 0, headers: {}, body: null, raw: undefined, ended: false };
  const response = {
    writeHead(status, hdrs) {
      captured.status = status;
      captured.headers = hdrs || {};
    },
    end(payload) {
      captured.ended = true;
      if (payload === undefined) return;
      captured.raw = payload;
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

const pick = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

/**
 * Poll a REAL observable until it holds, instead of sleeping past a deadline and
 * hoping. The auto-start tests below used a fixed 1600ms against a 1s start
 * budget — a 600ms margin that a loaded CI runner can eat, turning a real
 * regression and a slow machine into the same red. `callRoute` is the observable
 * here: it reports `daemon.starting`/`daemon.spawnAttempts` as the host sees them.
 */
async function waitFor(cond, what, { timeoutMs = 10_000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cond();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * Cap the host's REAL deadlines for the duration of one case.
 *
 * Four cases below exercise a deadline by pointing the host at a fake server
 * that accepts the connection and never answers — so the test waits out the
 * whole budget: the 5s health/models probe, the 3.5s `/command status` call and
 * the 2s sidecar probe, ~21s of this suite's ~25s. Every one of those budgets
 * reaches its socket through `AbortSignal.timeout(...)`, so capping that call
 * keeps each observable the assertions actually look at (the host's own named
 * reason, the null catalogue plus its reason, the booked milliseconds) while
 * costing ~120ms instead of seconds.
 *
 * This is a clock stand-in, not a mock of the code under test: the same abort
 * lands on the same fetch and takes the same branch — the reason strings still
 * name the production budgets, because the code interpolates its constant, not
 * the elapsed time. Kept per-case (not suite-wide) so no healthy path that
 * legitimately needs a budget is shortened behind another test's back.
 */
const DEADLINE_CAP_MS = 120;

async function withShortDeadlines(capMs, body) {
  const real = AbortSignal.timeout;
  AbortSignal.timeout = function shortTimeout(ms) {
    return real.call(AbortSignal, Math.min(ms, capMs));
  };
  try {
    return await body();
  } finally {
    AbortSignal.timeout = real;
  }
}

describe('stats route — registration and gates', () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-stats-')), 'sessions.json');
  let route;
  let savedProfile;

  before(() => {
    // Neutralize ambient profile detection so the tracked-session count and the
    // store this test pre-populates agree on the key space.
    savedProfile = process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE;
    route = mountRoute({ statePath });
  });
  after(() => {
    if (savedProfile !== undefined) process.env.DSH_PROFILE = savedProfile;
    rmSync(dirname(statePath), { recursive: true, force: true });
  });

  it('registers an exact route at the documented path', () => {
    assert.equal(route.path, STATS_PATH);
    assert.equal(route.kind, 'exact');
    assert.equal(typeof route.handler, 'function');
  });

  it('GET returns the no-store JSON snapshot', async () => {
    const r = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.name, 'dsh-connect-atomcode');
  });

  it('HEAD is allowed like GET, and carries no body', async () => {
    const r = await callRoute(route, { method: 'HEAD', headers: { host: '127.0.0.1:3080' } });
    assert.equal(r.status, 200);
    // The status alone used to be all this asserted, which is why the provider
    // route could answer HEAD with a full snapshot and stay "tested". A body on
    // HEAD violates HTTP semantics — say it, on both routes.
    assert.equal(r.raw, undefined, 'HEAD must end the response with no payload');
  });

  it('a write method is rejected with 405 and an Allow header', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await callRoute(route, { method, headers: { host: '127.0.0.1:3080' } });
      assert.equal(r.status, 405, `${method} must be rejected`);
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
  });

  it('a cross-origin read is refused with 403', async () => {
    const r = await callRoute(route, {
      headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(r.raw, 'forbidden');
  });

  it('a same-origin read is allowed', async () => {
    const r = await callRoute(route, {
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it('a request without an Origin header is allowed (non-browser / same-origin fetch)', async () => {
    const r = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
    assert.equal(r.status, 200);
  });
});

describe('stats route — snapshot shape the panel depends on', () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-stats-')), 'sessions.json');
  let route;
  let savedProfile;
  let savedHome;
  let savedUserProfile;
  /** @type {Record<string, unknown>} */
  let body;

  before(async () => {
    savedProfile = process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE;
    // Hermetic: point HOME at a config that provably has NO usable direct
    // provider. Without this the suite asserted a property of the DEVELOPER'S
    // real ~/.atomcode/config.toml — it went green on a machine whose config
    // happened to lack a direct provider and red the moment one was added.
    // (Review availability is a local-config fact; a config test must pin the
    // config, not inherit the host's.)
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-stats-home-'));
    mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.atomcode', 'config.toml'),
      [
        'default_provider = "AtomGit-qwen3.8-27b"',
        '',
        '[provider_accounts.AtomGit]',
        'provider = "openai"',
        'base_url = "https://llm-api.atomgit.com/v1"',
        '',
        '[models."AtomGit-qwen3.8-27b"]',
        'account = "AtomGit"',
        'model = "qwen3.8-27b"',
      ].join('\n'),
      'utf8',
    );
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    // Pre-populate the store the route reads, so `sessions.tracked` is observable.
    createSessionStore(statePath, '').set('C:\\repo', 'sid-1');
    route = mountRoute({ statePath });
    body = (await callRoute(route, { headers: { host: '127.0.0.1:3080' } })).body;
  });
  after(() => {
    if (savedProfile !== undefined) process.env.DSH_PROFILE = savedProfile;
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(dirname(statePath), { recursive: true, force: true });
  });

  it('carries every field the renderer dereferences', () => {
    // Mirrors client.js: a missing field renders as blank/undefined in the panel,
    // so the contract is asserted explicitly rather than left to a manual check.
    // NOTE: `binary.env` is deliberately NOT required — it is `undefined` when
    // ATOMCODE_BIN is unset, and JSON.stringify drops undefined keys. The panel
    // handles that with a `configured || env || fallback` chain, which the next
    // test pins down.
    const required = [
      'daemon.up',
      'daemon.port',
      'daemon.autoStart',
      'daemon.spawnTried',
      'binary.configured',
      'binary.source',
      'config.approvalMode',
      'config.approvalModeRejected',
      'config.defaultWorkingDir',
      // Both provider knobs. `providerRows()` in the card dereferences them, and
      // an UNSET knob must arrive as an explicit null — a missing key would make
      // "the user pinned nothing" indistinguishable from "this host build does not
      // report the field at all", which is exactly the ambiguity the rows exist to
      // remove from the screen.
      'config.defaultProvider',
      'config.reviewDefaultProvider',
      'config.reviewAvailable',
      'config.reviewReason',
      'sessions.tracked',
      // The provider dropdowns dereference every one of these. They are listed per
      // slot on purpose: a snapshot that grew the branch for `ask` but not `review`
      // would render one live control and one that silently never works.
      'provider.storePath',
      'provider.storeError',
      'provider.foreignVersion',
      'provider.ask.panel',
      'provider.ask.config',
      'provider.ask.effective',
      'provider.ask.source',
      'provider.ask.catalog',
      'provider.ask.catalogError',
      'provider.review.panel',
      'provider.review.config',
      'provider.review.effective',
      'provider.review.source',
      'provider.review.catalog',
      // name -> base_url per usable review entry: the panel's loopback warning
      // reads it, and a snapshot without it shows a local proxy as if it were
      // any other provider.
      'provider.review.endpoints',
      'uptimeMs',
      'ask.calls',
      'ask.ok',
      'ask.err',
      'ask.msTotal',
      'ask.tokens',
      'review.calls',
      'review.ok',
      'review.err',
      'review.msTotal',
    ];
    for (const path of required) {
      assert.notEqual(pick(body, path), undefined, `the snapshot is missing ${path}`);
    }
  });

  it('satisfies the panel binary row fallback chain when no binary is configured', () => {
    // client.js: `bin.configured || bin.env || '自动探测（PATH）'`. Assert the VALUE
    // the row prints, not merely that the chain is truthy: the configured-binary
    // case (the sibling suite) satisfied a truthiness check while producing `true`,
    // which React renders as nothing at all.
    assert.equal(body.binary.configured, null);
    assert.equal(body.binary.env, undefined, 'no ATOMCODE_BIN in this process');
    assert.equal(body.binary.source, 'auto');
    assert.equal(
      body.binary.configured || body.binary.env || '自动探测（PATH）',
      '自动探测（PATH）',
      'the fallback chain must yield the panel’s label text',
    );
  });

  it('reports the review capability honestly as typed booleans/strings', () => {
    assert.equal(typeof body.config.reviewAvailable, 'boolean');
    assert.equal(typeof body.config.reviewReason, 'string');
    // The mount-time probe ran against the gateway-only config pinned in
    // `before()`, so the panel must be able to say why.
    assert.equal(body.config.reviewAvailable, false);
    assert.match(body.config.reviewReason, /providers/);
  });

  it('reflects daemon health for the configured (closed) port', () => {
    assert.equal(body.daemon.up, false, 'nothing listens on the test port');
    assert.equal(body.daemon.port, CLOSED_PORT);
    assert.equal(body.daemon.autoStart, false);
    assert.equal(body.daemon.spawnTried, false);
  });

  it('reflects the live tracked-session count read from disk', () => {
    assert.equal(body.sessions.tracked, 1, 'the pre-populated session must be counted');
    // And it is read per request, not frozen at mount.
    createSessionStore(statePath, '').set('C:\\other', 'sid-2');
    return callRoute(route, { headers: { host: '127.0.0.1:3080' } }).then((r) => {
      assert.equal(r.body.sessions.tracked, 2, 'the count must be re-read on each poll');
    });
  });

  it('starts the in-process counters at zero', () => {
    assert.equal(body.ask.calls, 0);
    assert.equal(body.review.calls, 0);
    assert.equal(typeof body.uptimeMs, 'number');
    assert.ok(body.uptimeMs >= 0);
  });
});

describe('stats route — review endpoints (what the pick DEPENDS on)', () => {
  // Hermetic by construction: the probe reads ~/.atomcode/config.toml, so the
  // config is pinned in a temp HOME. A loopback direct provider is the shape
  // the panel must be able to NAME — picking it silently would hide that the
  // review now depends on a local process (红线 3: a dependency must be stated,
  // not discovered when it dies).
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const dirs = [];

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function mountWithConfig(lines) {
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-endpoints-home-'));
    dirs.push(fakeHome);
    mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
    writeFileSync(join(fakeHome, '.atomcode', 'config.toml'), lines.join('\n'), 'utf8');
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-endpoints-')), 'sessions.json');
    const route = mountRoute({ statePath });
    return callRoute(route, { headers: { host: '127.0.0.1:3080' } });
  }

  it('maps every usable review entry to its base_url', async () => {
    const r = await mountWithConfig([
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
    ]);
    assert.equal(r.body.config.reviewAvailable, true);
    assert.deepEqual(
      r.body.provider.review.endpoints,
      { 'atomcode-local': 'http://127.0.0.1:8899/v1', 'far-away': 'https://openrouter.example/v1' },
      'the inline comment must not ride along into the endpoint the panel warns about',
    );
  });

  it('reads a direct provider whose config line carries an inline comment', async () => {
    // The kv regex used to swallow everything to end-of-line, so
    // `base_url = "http://127.0.0.1:8899/v1"  # 本地代理` parsed as a URL with
    // the quote and the comment glued on. The CLI parses config.toml correctly
    // itself, so the two parsers would disagree — and the corrupted value is
    // what THIS plugin's loopback detection runs on.
    const r = await mountWithConfig([
      'default_provider = "atomcode-local"',
      '[providers.atomcode-local]',
      'provider = "openai"',
      'base_url = "http://127.0.0.1:8899/v1"  # 本地代理',
      'api_key = "local-proxy-any-string"',
      'model = "deepseek-ai/DeepSeek-V4-Flash"',
    ]);
    assert.deepEqual(r.body.provider.review.catalog, ['atomcode-local']);
    assert.deepEqual(
      r.body.provider.review.endpoints,
      { 'atomcode-local': 'http://127.0.0.1:8899/v1' },
      'the comment must not ride along into the endpoint the panel warns about',
    );
  });

  it('lists a remote direct provider too, so the warning is not a blanket warning', async () => {
    const r = await mountWithConfig([
      '[providers.far-away]',
      'base_url = "https://openrouter.example/v1"',
      'api_key = "sk-test"',
    ]);
    assert.equal(r.body.config.reviewAvailable, true);
    assert.deepEqual(r.body.provider.review.endpoints, { 'far-away': 'https://openrouter.example/v1' });
  });
});

describe('stats route — binary source reporting', () => {
  it('reports the env source when ATOMCODE_BIN is set at mount time', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-stats-')), 'sessions.json');
    const saved = process.env.ATOMCODE_BIN;
    process.env.ATOMCODE_BIN = 'C:\\tools\\atomcode.exe';
    try {
      const route = mountRoute({ statePath });
      const r = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(r.body.binary.env, 'C:\\tools\\atomcode.exe');
      assert.equal(r.body.binary.source, 'env', 'the panel labels this row from `source`');
      assert.equal(r.body.binary.configured, null, 'config.binary is unset here');
    } finally {
      if (saved === undefined) delete process.env.ATOMCODE_BIN;
      else process.env.ATOMCODE_BIN = saved;
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  /**
   * The branch the "no binary configured" test above cannot reach — and the one
   * that was silently broken.
   *
   * `config.binary` used to arrive as `true`, while the panel's row evaluates
   * `configured || env || '自动探测（PATH）'` and renders the winner. The chain
   * therefore produced the BOOLEAN `true`, and React renders a boolean child as
   * NOTHING: the 运行环境 card showed an "AtomCode" row with an empty value
   * exactly when the user had set `binary` in the patch row, and `env` was masked
   * by the `true` that short-circuited it. The other three artefacts — this
   * route's own required-key list, `BinaryBranch.configured` in src/shared, and
   * the fallback-chain test above — all describe a PATH, so the host was the one
   * that had drifted.
   */
  it('gives the panel a real path when config.binary IS set', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-stats-bin-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, extra: { binary: 'C:\\tools\\atomcode.exe' } });
      const r = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(r.body.binary.source, 'config');
      assert.equal(r.body.binary.configured, 'C:\\tools\\atomcode.exe');
      // The panel's own expression, evaluated here: a `true` in `configured` used
      // to satisfy `||` while being unrenderable, so a truthiness assertion alone
      // would have passed on the broken build. Assert the VALUE the row prints.
      const binPath = r.body.binary.configured || r.body.binary.env || '自动探测（PATH）';
      assert.equal(binPath, 'C:\\tools\\atomcode.exe', 'the row must show a path the user can read');
      assert.equal(typeof binPath, 'string', 'a boolean here renders as a blank cell, not as text');
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });
});

/** Captured verbatim from a real daemon, 5.2.3. */
const STATUS_TEXT = [  '  登录：  gcw_8biBqEYF',
  '  模型：    qwen3.8-27b',
  '  CodingPlan：CodingPlan Lite-体验版  ·  到期 2026-10-19（5d / 共 7d）',
  '  用量：当前时间窗口用量约 77%  ·  重置于 20:32（29m 13s 后）',
].join('\n');

/**
 * The fake daemon's request handler. It takes the request-log array as a
 * parameter rather than closing over a suite-local `let`: a module-scoped
 * function cannot see a block-scoped binding, and the resulting
 * `ReferenceError` inside a request callback surfaces as a 15s test timeout
 * (an unanswered request), not as a clean failure.
 */
function fakeQuotaHandler(commandBodies, statusText = STATUS_TEXT) {
  return (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = req.url || '';
      if (url.startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '5.2.3', service: 'atomcode-daemon' }));
        return;
      }
      if (url.startsWith('/command')) {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
        commandBodies.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        // Mirror the daemon: command failures arrive as HTTP 200 + kind:error.
        if (!body.working_dir) {
          res.end(JSON.stringify({ kind: 'error', message: 'working_dir required' }));
          return;
        }
        if (body.command !== 'status') {
          res.end(JSON.stringify({ kind: 'error', message: `unknown command: ${body.command}` }));
          return;
        }
        res.end(JSON.stringify({ kind: 'status', logged_in: true, text: statusText }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  };
}

describe('stats route — CodingPlan quota', () => {
  /** @type {import('node:http').Server} */
  let server;
  let port;
  let commandBodies;

  before(async () => {
    commandBodies = [];
    server = createServer(fakeQuotaHandler(commandBodies));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(() => server.close());

  it('surfaces the parsed CodingPlan quota from the status command', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-quota-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, port });
      const { body } = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(body.quota.available, true);
      assert.equal(body.quota.plan, 'Lite-体验版');
      assert.equal(body.quota.expires, '2026-10-19');
      assert.equal(body.quota.planWindow, '5d / 共 7d');
      assert.equal(body.quota.usagePercent, 77);
      assert.equal(body.quota.resetAt, '20:32');
      assert.equal(body.quota.resetInSecs, 29 * 60 + 13);
      assert.equal(typeof body.quota.fetchedAt, 'number');
      // The raw lines ride along so the panel can degrade honestly.
      assert.match(body.quota.raw.usageLine, /77%/);
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('always sends a working_dir, because the daemon rejects the command without one', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-quota-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, port });
      await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      const last = commandBodies.at(-1);
      assert.equal(last.command, 'status', 'the command name must NOT carry a leading slash');
      assert.ok(last.working_dir, 'working_dir is mandatory for every /command call');
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('caches across polls so the 5s panel poll is not a 5s daemon call', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-quota-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, port });
      const before = commandBodies.length;
      await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(commandBodies.length - before, 1, 'three polls within the TTL must hit /command once');
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('quota_refresh_secs: 0 disables the extra daemon call entirely', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-quota-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, port, extra: { quota_refresh_secs: 0 } });
      const before = commandBodies.length;
      const { body } = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(commandBodies.length, before, 'no /command call may be made when disabled');
      assert.equal(body.quota.available, false);
      assert.match(body.quota.reason, /关闭/);
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('reports unavailable (not a fabricated number) when the daemon is down', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-quota-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, port: CLOSED_PORT });
      const { body } = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(body.quota.available, false);
      assert.equal(body.quota.usagePercent, undefined);
      assert.match(body.quota.reason, /没有任何进程在监听/);
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('does not spawn a duplicate when a daemon already answers', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-quota-')), 'sessions.json');
    try {
      // `port` here is the live fake daemon. Health-first means there is nothing
      // to start, so an `auto_start: true` mount must NOT report a spawn.
      const route = mountRoute({ statePath, port, extra: { auto_start: true } });
      const { body } = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(body.daemon.up, true);
      assert.equal(body.daemon.spawnTried, false, 'an already-running daemon must not be spawned again');
      assert.equal(body.daemon.starting, false);
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });
});

describe('stats route — protocol drift signals', () => {
  /** @type {import('node:http').Server} */
  let server;
  let port;
  let statusText;

  before(async () => {
    // A daemon whose status text the parser does NOT recognize — the shape an
    // AtomCode upgrade would produce after rewording the status output.
    statusText = ['  登录：  someone', '  模型：  qwen', '  用量：稍后统计'].join('\n');
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const url = req.url || '';
        if (url.startsWith('/health')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ service: 'atomcode-daemon', version: '5.2.3' }));
          return;
        }
        if (url.startsWith('/command')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ kind: 'status', logged_in: true, text: statusText }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(() => server.close());

  it('reports the daemon version and raises quotaTextDrift on unparseable text', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-drift-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, port });
      const { body } = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(body.protocol.daemonVersion, '5.2.3', 'the panel shows which build we speak to');
      assert.equal(
        body.protocol.quotaTextDrift,
        true,
        'a status text with no recognisable quota line must raise the drift flag',
      );
      assert.equal(body.quota.available, true, 'the command itself worked');
      assert.equal(body.quota.usagePercent, null, 'and no number is invented');
      assert.match(body.quota.reason, /no recognisable quota line/);
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('clears the drift flag once the text parses again', async () => {
    try {
      const stateA = join(mkdtempSync(join(tmpdir(), 'atomcode-drift2a-')), 'sessions.json');
      const routeA = mountRoute({ statePath: stateA, port });
      assert.equal((await callRoute(routeA)).body.protocol.quotaTextDrift, true);
      rmSync(dirname(stateA), { recursive: true, force: true });

      statusText = STATUS_TEXT; // the user reverted / a later build fixed the wording

      // A FRESH mount, because the quota value (and therefore the drift flag) is
      // cached for `quota_refresh_secs`: within the TTL the panel is meant to
      // keep showing the last snapshot, so this test would be asserting cache
      // behaviour, not drift re-evaluation.
      const stateB = join(mkdtempSync(join(tmpdir(), 'atomcode-drift2b-')), 'sessions.json');
      const routeB = mountRoute({ statePath: stateB, port });
      assert.equal(
        (await callRoute(routeB, { headers: { host: '127.0.0.1:3080' } })).body.protocol.quotaTextDrift,
        false,
        'drift must be re-evaluated, not latched',
      );
      rmSync(dirname(stateB), { recursive: true, force: true });
    } finally {
      statusText = ['  登录：  someone', '  模型：  qwen', '  用量：稍后统计'].join('\n');
    }
  });
});

describe('stats route — a refused review is still accounted for', () => {
  // The four review refusals used to book `calls`/`err` by hand and return
  // `duration_ms: 0`, so `msTotal` counted only the calls that reached a spawn
  // while `calls` counted every attempt — the panel's average duration was low
  // by construction, and a fifth refusal added later would have inherited the
  // hole. They now exit through one `refuse()`. This drives the one refusal
  // path that genuinely SPENDS time (a local sidecar that accepts the connection
  // and never answers), because that is the only shape where the assertion can
  // tell "booked" from "left at zero". The 2s sidecar probe budget is capped to
  // DEADLINE_CAP_MS for this case, so the booking assertion is scaled to match;
  // the wait is paid once because the second candidate URL fails instantly.
  let server;
  let sidecarPort = 0;

  before(async () => {
    server = createServer((req) => {
      // /health: accept and never answer, so the loopback probe burns its budget.
      // Anything else (the /models fallback candidate): fail at once, so the
      // test pays for ONE probe budget rather than two.
      if (req.url !== '/health') req.socket.destroy();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    sidecarPort = server.address().port;
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  it('a refusal that waited is counted in calls, err and msTotal', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-acc-')), 'sessions.json');
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-acc-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'atomcode-acc-repo-'));
    mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.atomcode', 'config.toml'),
      [
        '[providers.hanging]',
        `base_url = "http://127.0.0.1:${sidecarPort}/v1"`,
        'api_key = "sk-test"',
      ].join('\n'),
      'utf8',
    );
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const tools = [];
      const routes = captureRoutes({ statePath, toolSink: tools });
      const statsRoute = routes.find((r) => r.path === STATS_PATH);
      const review = tools.find((t) => t.name === 'atomcode_review');
      assert.ok(review, 'the review tool must be registered');
      const r = await withShortDeadlines(DEADLINE_CAP_MS, () => review.execute({ working_dir: repo }, {}));
      assert.equal(r.ok, false);
      assert.match(r.error, /is not responding/, 'the dead-sidecar refusal is the path under test');
      assert.ok(
        r.duration_ms >= 100,
        'a refusal must report the time it really spent, not a hardcoded 0',
      );
      const { body } = await callRoute(statsRoute);
      assert.equal(body.review.calls, 1);
      assert.equal(body.review.err, 1);
      assert.ok(
        body.review.msTotal >= 100,
        'a refusal that waited must not leave msTotal at 0 — the average duration would be low by construction',
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      rmSync(dirname(statePath), { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('stats route — auto-start on observation', () => {
  // A closed port + an unusable binary: the spawn is attempted (observably) and
  // fails, and a 1s start budget keeps the background poll short.
  const failingStart = {
    auto_start: true,
    binary: 'definitely-not-a-real-binary-xyz-123',
    daemon_start_timeout_secs: 1,
  };

  it('brings the daemon up when the panel is merely looked at (no tool call)', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-autostart-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, port: CLOSED_PORT, extra: failingStart });
      const startedAt = Date.now();
      const { body } = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      const elapsed = Date.now() - startedAt;

      // The regression this guards: `auto_start` used to mean "the first
      // atomcode_ask will start it", so the panel sat on "daemon 未运行" until
      // the model happened to call a tool.
      assert.equal(body.daemon.spawnTried, true, 'observing the panel must trigger the start');
      assert.equal(body.daemon.starting, true, 'the in-flight start must be reported, not a bare failure');
      assert.match(body.quota.reason, /正在拉起/, 'the quota branch must say it is starting');
      // …and it must never block the poll on the ~30s start budget.
      assert.ok(elapsed < 1000, `the route must answer promptly, took ${elapsed}ms`);
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('starts nothing when auto_start is off', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-autostart-')), 'sessions.json');
    try {
      const route = mountRoute({
        statePath,
        port: CLOSED_PORT,
        extra: { auto_start: false, daemon_start_timeout_secs: 1 },
      });
      const { body } = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(body.daemon.spawnTried, false, 'auto_start:false must keep the plugin lazy');
      assert.equal(body.daemon.starting, false);
      assert.match(body.quota.reason, /没有任何进程在监听/);
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('kicks off only one start across repeated polls', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-autostart-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, port: CLOSED_PORT, extra: failingStart });
      await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      const first = (await callRoute(route, { headers: { host: '127.0.0.1:3080' } })).body;
      const second = (await callRoute(route, { headers: { host: '127.0.0.1:3080' } })).body;
      // `spawnTried` is the observable proof that the shared start promise is
      // reused rather than a daemon being spawned per poll.
      assert.equal(first.daemon.spawnTried, true);
      assert.equal(second.daemon.spawnTried, true);
      assert.equal(second.daemon.starting, true, 'the single shared start is still the one in flight');
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('a failed auto-start is retried after the cooldown, not dead for the mount', async () => {
    // v0.3: `spawnTried` latched true forever and the start promise was cached,
    // so the FIRST failure (binary not yet installed) silenced auto-start for
    // the whole mount — installing AtomCode later changed nothing until a host
    // restart. The cooldown makes the failure recoverable.
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-retry-')), 'sessions.json');
    try {
      const route = mountRoute({
        statePath,
        port: CLOSED_PORT,
        extra: { ...failingStart, daemon_retry_secs: 0 }, // 0 = retry on the next poll
      });
      const first = (await callRoute(route, { headers: { host: '127.0.0.1:3080' } })).body;
      assert.equal(first.daemon.spawnTried, true);
      // Poll until the SECOND attempt has happened, i.e. until the first failure
      // settled and the next poll retried. The call that discovers `>= 2` is the
      // one that triggered attempt 2, so asserting EXACTLY 2 right after it still
      // proves there is no spawn storm.
      const second = await waitFor(
        async () => {
          const body = (await callRoute(route, { headers: { host: '127.0.0.1:3080' } })).body;
          return body.daemon.spawnAttempts >= 2 ? body : null;
        },
        'the settled failure to be retried (spawnAttempts >= 2)',
      );
      assert.equal(
        second.daemon.spawnAttempts,
        2,
        'a settled failure must not permanently disable auto-start',
      );
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('within the cooldown, repeated polls do NOT re-spawn', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-retry2-')), 'sessions.json');
    try {
      const route = mountRoute({
        statePath,
        port: CLOSED_PORT,
        extra: { ...failingStart, daemon_retry_secs: 3600 },
      });
      await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      // Wait for the in-flight start to SETTLE (its 1s budget), then poll again:
      // the point is that the cooldown suppresses a second spawn even once
      // nothing is in flight any more.
      await waitFor(async () => {
        const body = (await callRoute(route, { headers: { host: '127.0.0.1:3080' } })).body;
        return body.daemon.starting === false ? body : null;
      }, 'the in-flight start to settle');
      const body = (await callRoute(route, { headers: { host: '127.0.0.1:3080' } })).body;
      assert.equal(body.daemon.spawnAttempts, 1, 'the cooldown must suppress a spawn storm');
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('an in-flight start is never orphaned, so concurrent ASKS cannot double-spawn', async () => {
    // The v0.4-first-cut bug: a `daemonStartSettled` flag latched true forever,
    // and `ensureDaemon`'s "drop the stale successful start" path keyed on it —
    // so it also discarded a start that was still IN FLIGHT. With
    // `daemon_retry_secs: 0` a second caller then spawned a SECOND daemon
    // against the same port, breaking the shared-promise invariant.
    //
    // This must be driven through `atomcode_ask` (→ ensureDaemon), NOT through
    // the stats route: the route calls `ensureDaemonStarted` directly and never
    // reaches the dropping branch, so a poll-driven test passes with the bug
    // still in place — which is exactly what the first attempt at this test did.
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-inflight2-')), 'sessions.json');
    const tools = [];
    const routes = [];
    const ctx = {
      get: (name) => {
        if (name === 'tools') return { register: (d) => { tools.push(d); return () => {}; } };
        if (name === 'webServer') return { register: (r) => { routes.push(r); return () => {}; } };
        return undefined;
      },
      logger: { warn() {}, error() {}, info() {} },
      fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
      inject() {},
      effect() {},
      on() {},
    };
    const savedProfile = process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE;
    try {
      mod.apply(ctx, {
        state_path: statePath,
        port: CLOSED_PORT,
        auto_start: true,
        binary: 'definitely-not-a-real-binary-xyz-123',
        daemon_start_timeout_secs: 10,
        daemon_retry_secs: 0, // no cooldown: only the in-flight guard can stop this
      });
      const ask = tools.find((t) => t.name === 'atomcode_ask');
      assert.ok(ask, 'atomcode_ask must be registered');
      // A long start budget keeps P1 provably IN FLIGHT for the whole window, so
      // the counter read below is taken before it can settle and legitimately
      // permit another attempt.
      const asks = Promise.all([
        ask.execute({ message: 'one' }, {}),
        ask.execute({ message: 'two' }, {}),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const mid = (await callRoute(routes[0], { headers: { host: '127.0.0.1:3080' } })).body;
      assert.equal(mid.daemon.starting, true, 'precondition: P1 is still polling');
      assert.equal(
        mid.daemon.spawnAttempts,
        1,
        'two concurrent asks must share ONE start, not each spawn their own daemon',
      );
      await asks;
    } finally {
      if (savedProfile !== undefined) process.env.DSH_PROFILE = savedProfile;
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('the snapshot exposes the daemon version and the drift signals', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-proto-')), 'sessions.json');
    try {
      const route = mountRoute({ statePath, port: CLOSED_PORT });
      const { body } = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      // These are the v0.4 drift pins. Their absence in the snapshot is exactly
      // the silent-degradation hole that made an AtomCode upgrade invisible.
      assert.equal(typeof body.protocol, 'object');
      assert.equal(typeof body.protocol.daemonVersion, 'string');
      assert.equal(typeof body.protocol.quotaTextDrift, 'boolean');
      // The SSE half of the same family, and the sharper instance of it: a
      // renamed `tool_start` leaves every turn reporting success while the round
      // fuse counts nothing. Always an ARRAY, so the client can iterate it
      // unguarded and an older host is the only case that yields `undefined`.
      assert.ok(
        Array.isArray(body.protocol.unknownTypes),
        'the SSE drift list must always be an array, never absent',
      );
      assert.deepEqual(
        body.protocol.unknownTypes,
        [],
        'a mount that has run no turn has seen no drift — [] means "checked, nothing", not "unknown"',
      );
      assert.equal(typeof body.daemon.spawnAttempts, 'number');
      assert.ok(body.config.askMaxRounds > 0, 'the ask round ceiling must be visible');
      assert.equal(typeof body.config.reviewWorkingDir, 'object', 'a missing repo dir is null, not absent');
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('exposes which provider each path defaults to (null = the bridge pins nothing)', async () => {
    // `default_provider` (ask) and `review_default_provider` (review) decide which
    // MODEL / which BILLING CHANNEL every bridged turn uses, so the route must
    // tell the two states apart: pinning a name, and pinning nothing. A knob that
    // silently never applied is exactly the failure this read-only route exists to
    // make visible (红线 3). They are separate fields because the two paths do not
    // share a provider namespace (红线 8).
    const pinned = join(mkdtempSync(join(tmpdir(), 'atomcode-dp-stats-')), 'sessions.json');
    const unset = join(mkdtempSync(join(tmpdir(), 'atomcode-dp-stats2-')), 'sessions.json');
    try {
      const on = mountRoute({
        statePath: pinned,
        port: CLOSED_PORT,
        extra: { default_provider: 'AtomGit-glm5.3-flash', review_default_provider: 'atomcode-local' },
      });
      const a = (await callRoute(on, { headers: { host: '127.0.0.1:3080' } })).body;
      assert.equal(a.config.defaultProvider, 'AtomGit-glm5.3-flash');
      assert.equal(a.config.reviewDefaultProvider, 'atomcode-local');
      const off = mountRoute({ statePath: unset, port: CLOSED_PORT });
      const b = (await callRoute(off, { headers: { host: '127.0.0.1:3080' } })).body;
      assert.equal(b.config.defaultProvider, null, 'unset must be an explicit null, not a missing key');
      assert.equal(b.config.reviewDefaultProvider, null, 'unset must be an explicit null, not a missing key');
    } finally {
      rmSync(dirname(pinned), { recursive: true, force: true });
      rmSync(dirname(unset), { recursive: true, force: true });
    }
  });

  it('reports which patch-only knobs DEPART from the shipped default', async () => {
    // The panel's "（已改）/（插件默认）" tag needs evidence it cannot obtain itself: a
    // renderer only sees the resolved value, so it cannot tell a deliberate
    // `approval_mode: bypass` from our own fallback. So the route reports it.
    //
    // What it must NOT mean is "the config object contained the key": the shipped
    // cordis.patch.yml writes EVERY key (it is the field documentation of record),
    // so key-presence is true on every install — measured live, a stock patch claimed
    // authored=true for approval_mode / ask_max_rounds that nobody had touched, and
    // the tag fired on every row. The useful question is departure from the default.
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-authored-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'atomcode-authored2-'));
    try {
      const untouched = mountRoute({ statePath: join(dir, 'sessions.json'), port: CLOSED_PORT });
      const a = (await callRoute(untouched, { headers: { host: '127.0.0.1:3080' } })).body;
      assert.deepEqual(
        a.config.authored,
        { approvalMode: false, workingDir: false, askMaxRounds: false },
        'a mount using the shipped values must report NOTHING as changed'
      );
      assert.equal(a.config.defaults.approvalMode, 'bypass');
      assert.equal(a.config.defaults.askMaxRounds, 25);
      assert.equal(a.config.askMaxRounds, 25, 'the resolved value still reports the fallback it used');

      // Writing the SAME value the default has explicitly is still not a change —
      // that is the whole point, and it is the case the live host was actually in.
      const same = mountRoute({
        statePath: join(dir2, 'sessions.json'),
        port: CLOSED_PORT,
        extra: { approval_mode: 'bypass', ask_max_rounds: 25 },
      });
      const b = (await callRoute(same, { headers: { host: '127.0.0.1:3080' } })).body;
      assert.deepEqual(
        b.config.authored,
        { approvalMode: false, workingDir: false, askMaxRounds: false },
        'restating the default is not departing from it'
      );

      // A real departure IS reported. `accept_edits` is a LEGAL non-default value
      // (the closed enum is build | accept_edits | bypass | plan); this used to
      // say `ask`, which the daemon 422s — the test was configuring a value the
      // plugin would have forwarded straight into a failed turn.
      const dir3 = mkdtempSync(join(tmpdir(), 'atomcode-authored3-'));
      try {
        const changed = mountRoute({
          statePath: join(dir3, 'sessions.json'),
          port: CLOSED_PORT,
          extra: { approval_mode: 'accept_edits', ask_max_rounds: 40, working_dir: 'D:\\repo' },
        });
        const c = (await callRoute(changed, { headers: { host: '127.0.0.1:3080' } })).body;
        assert.deepEqual(c.config.authored, { approvalMode: true, workingDir: true, askMaxRounds: true });
        assert.equal(c.config.approvalMode, 'accept_edits');
        assert.equal(c.config.approvalModeRejected, null, 'a legal value is not a rejection');
        assert.equal(c.config.askMaxRounds, 40);
        assert.equal(c.config.defaultWorkingDir, 'D:\\repo');
      } finally {
        rmSync(dir3, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('refuses an off-enum approval_mode at boot and names the value it refused', async () => {
    // `approval_mode` is a CLOSED enum at the daemon (`build | accept_edits |
    // bypass | plan`, measured through the 422 parameter gate — see
    // `scripts/probes/approval-mode.mjs`). The plugin used to check only "is a
    // non-empty string", so a typo travelled untouched from the patch file to
    // every `/chat` and the first symptom was each turn failing with a daemon
    // error. Now the value is refused here and the refused spelling rides along
    // on the snapshot, because the panel must not label the fallback as the
    // user's choice — and `authored` alone cannot carry that (it is derived from
    // the RESOLVED value, which equals the default).
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-approval-'));
    try {
      const mounted = mountRoute({
        statePath: join(dir, 'sessions.json'),
        port: CLOSED_PORT,
        extra: { approval_mode: 'accept-edits' },
      });
      const body = (await callRoute(mounted, { headers: { host: '127.0.0.1:3080' } })).body;
      assert.equal(body.config.approvalMode, 'bypass', 'the fallback is what the code honours');
      assert.equal(
        body.config.approvalModeRejected,
        'accept-edits',
        'the refused spelling must reach the panel instead of vanishing',
      );
      assert.equal(
        body.config.authored.approvalMode,
        false,
        'authored stays false (the resolved value IS the default) — which is exactly why the separate field is needed',
      );

      // A legal value reports no rejection, so the panel's "（已改）" path is unchanged.
      const dir2 = mkdtempSync(join(tmpdir(), 'atomcode-approval2-'));
      try {
        const legal = mountRoute({
          statePath: join(dir2, 'sessions.json'),
          port: CLOSED_PORT,
          extra: { approval_mode: 'accept_edits' },
        });
        const ok = (await callRoute(legal, { headers: { host: '127.0.0.1:3080' } })).body;
        assert.equal(ok.config.approvalMode, 'accept_edits');
        assert.equal(ok.config.approvalModeRejected, null);
        assert.equal(ok.config.authored.approvalMode, true);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers promptly with a named reason when the daemon is wedged half-open', async () => {
    // A daemon that accepts the TCP connection but never answers is the
    // likeliest wedged state. The start-poll budget assumes "each probe fails
    // fast" — a half-open socket violates that by definition, so the health
    // probe itself needs a deadline or the route hangs forever and
    // `daemon_start_timeout_secs` silently stops meaning anything.
    const wedged = createServer(() => { /* accept, never respond */ });
    const sockets = new Set();
    wedged.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise((resolve) => wedged.listen(0, '127.0.0.1', resolve));
    try {
      const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wedged-')), 'sessions.json');
      const route = mountRoute({ statePath, port: wedged.address().port, extra: { auto_start: false } });
      const startedAt = Date.now();
      const { body } = await withShortDeadlines(DEADLINE_CAP_MS, () =>
        callRoute(route, { headers: { host: '127.0.0.1:3080' } }),
      );
      const elapsed = Date.now() - startedAt;
      assert.equal(body.daemon.up, false, 'a wedged daemon is not up');
      assert.equal(body.quota.available, false);
      assert.match(body.quota.reason, /有进程在监听/, 'and the reason names the state');
      // The 5s probe deadline is capped by withShortDeadlines above; allow CI
      // slack and still fail on a hang, which is the regression this case exists
      // for. The reason string below still names the production budget, because
      // the code interpolates its constant rather than the elapsed time.
      assert.ok(elapsed < 2000, `the route must answer within the probe deadline, took ${elapsed}ms`);
      rmSync(dirname(statePath), { recursive: true, force: true });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => wedged.close(resolve));
    }
  });

  it('answers promptly when /health is fine but /models hangs', async () => {
    // The metadata probe had no deadline either: a daemon that is alive but
    // stalled on /models would hang the route (and the ask dropdown) forever.
    const half = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'atomcode-daemon', version: '5.2.2-test' }));
        return;
      }
      if (req.url === '/command') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ kind: 'status', text: '' }));
        return;
      }
      // /models: accept, never respond.
    });
    const sockets = new Set();
    half.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise((resolve) => half.listen(0, '127.0.0.1', resolve));
    try {
      const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wedged-models-')), 'sessions.json');
      const route = mountRoute({ statePath, port: half.address().port, extra: { auto_start: false } });
      const startedAt = Date.now();
      const { body } = await withShortDeadlines(DEADLINE_CAP_MS, () =>
        callRoute(route, { headers: { host: '127.0.0.1:3080' } }),
      );
      const elapsed = Date.now() - startedAt;
      assert.equal(body.daemon.up, true, 'the daemon IS up — only /models is wedged');
      assert.equal(body.provider.ask.catalog, null, 'the catalogue is reported unavailable, not empty');
      assert.ok(
        body.provider.ask.catalogError.length > 0,
        'and the dropdown gets a named reason instead of a bare empty list',
      );
      assert.ok(elapsed < 2000, `the route must answer within the probe deadline, took ${elapsed}ms`);
      rmSync(dirname(statePath), { recursive: true, force: true });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => half.close(resolve));
    }
  });

  it('answers the QUOTA call within the panel\'s patience, with the host\'s own reason', async () => {
    // /health is the daemon's cheapest endpoint; the quota call is the one that
    // runs on the PANEL's schedule and the one most likely to wedge (it drives
    // the full status render inside the binary). Its budget is deliberately
    // UNDER the panel's client deadline (POLL_MS - 1000): answer first and the
    // panel shows the HOST's named reason, shared by the card and the chip,
    // instead of a client-side abort string plus a handler that outlives it.
    const half = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'atomcode-daemon', version: '5.2.2-test' }));
        return;
      }
      // /command (and /models): accept, never respond.
    });
    const sockets = new Set();
    half.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise((resolve) => half.listen(0, '127.0.0.1', resolve));
    try {
      const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wedged-quota-')), 'sessions.json');
      const route = mountRoute({ statePath, port: half.address().port, extra: { auto_start: false } });
      const startedAt = Date.now();
      const { body } = await withShortDeadlines(DEADLINE_CAP_MS, () =>
        callRoute(route, { headers: { host: '127.0.0.1:3080' } }),
      );
      const elapsed = Date.now() - startedAt;
      assert.equal(body.daemon.up, true, 'the daemon IS up — only the quota command is wedged');
      assert.equal(body.quota.available, false);
      assert.match(
        body.quota.reason,
        /daemon 未在 .*ms 内应答 \/command status/,
        'the reason must be the host\'s own wording, not Node\'s "The operation was aborted"',
      );
      assert.ok(elapsed < 2000, `the route must answer within the client's patience, took ${elapsed}ms`);
      rmSync(dirname(statePath), { recursive: true, force: true });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => half.close(resolve));
    }
  });
});

/**
 * The provider write route — the panel's own model choice.
 *
 * What this pins down, beyond "the endpoint works":
 *  - the value lands in the PLUGIN's state file and is reported back as the
 *    effective choice with `source: 'panel'`, so a click is verifiable on screen;
 *  - every refusal is loud (400/403/405/409 with a reason), never a silent no-op;
 *  - 红线 8's boundary: writing a pick must NOT touch ~/.atomcode/config.toml.
 *    That assertion is the whole reason this feature is allowed to exist — the
 *    moment a future change starts writing another application's configuration,
 *    this test is what fails first.
 */
describe("provider route — the panel's own model choice", () => {
  const HOME_HDRS = { host: '127.0.0.1:3080' };
  const dirs = [];

  function mountBoth(extra = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-prov-'));
    dirs.push(dir);
    const routes = captureRoutes({ statePath: join(dir, 'sessions.json'), port: CLOSED_PORT, extra });
    return {
      dir,
      state: join(dir, 'provider.json'),
      stats: routes.find((r) => r.path === STATS_PATH),
      provider: routes.find((r) => r.path === PROVIDER_PATH),
    };
  }

  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('a saved pick is reported as the effective choice, sourced from the panel', async () => {
    const m = mountBoth();
    const w = await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'ask', provider: 'AtomGit-glm5.3-flash' } });
    assert.equal(w.status, 200);
    assert.equal(w.body.ok, true);
    assert.equal(w.body.ask.panel, 'AtomGit-glm5.3-flash');
    assert.equal(w.body.ask.effective, 'AtomGit-glm5.3-flash');
    assert.equal(w.body.ask.source, 'panel');
    // And it is on disk where the plugin reads it — next to sessions.json.
    assert.ok(existsSync(m.state), 'the plugin state file must exist after a write');
    const poll = await callRoute(m.stats, { headers: HOME_HDRS });
    assert.equal(poll.body.provider.ask.source, 'panel', 'the next poll must agree with the write');
  });

  it('GET reads the same state without writing it', async () => {
    const m = mountBoth({ default_provider: 'AtomGit-qwen3.8-27b' });
    const g = await callRoute(m.provider, { headers: HOME_HDRS });
    assert.equal(g.status, 200);
    assert.equal(g.body.ok, true);
    assert.equal(g.body.ask.panel, null);
    assert.equal(g.body.ask.effective, 'AtomGit-qwen3.8-27b');
    assert.equal(g.body.ask.source, 'config');
    assert.equal(existsSync(m.state), false, 'a read must not create the state file');
  });

  it('HEAD is allowed but carries no body, exactly like the stats route', async () => {
    // The method gate lets HEAD through deliberately, so the handler must honor
    // it. It used to fall through to the same writeJson as GET, answering a HEAD
    // with the whole provider branch — HTTP semantics broken on the route that
    // was added second, which is the shape this class of bug always takes.
    const m = mountBoth();
    const r = await callRoute(m.provider, { method: 'HEAD', headers: HOME_HDRS });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.raw, undefined, 'HEAD must end the response with no payload');
    assert.equal(existsSync(m.state), false, 'a HEAD must not create the state file either');
  });

  it('a null clears the pick and the ladder falls back', async () => {
    const m = mountBoth({ default_provider: 'AtomGit-qwen3.8-27b' });
    await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'ask', provider: 'X' } });
    const cleared = await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'ask', provider: null } });
    assert.equal(cleared.body.ask.panel, null);
    assert.equal(cleared.body.ask.effective, 'AtomGit-qwen3.8-27b', 'clearing returns to the configured default');
    assert.equal(cleared.body.ask.source, 'config');
  });

  it('the two slots stay separate namespaces on disk', async () => {
    const m = mountBoth();
    await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'ask', provider: 'AtomGit-glm5.3-flash' } });
    const r = await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'review', provider: 'atomcode-local' } });
    assert.equal(r.body.ask.panel, 'AtomGit-glm5.3-flash', 'writing review must not clobber ask');
    assert.equal(r.body.review.panel, 'atomcode-local');
    // The review slot never pretends to be a model profile, and vice versa.
    assert.equal(r.body.review.source, 'panel');
    assert.equal(r.body.ask.source, 'panel');
  });

  it('refuses an unknown slot, a non-string name, and control characters — all 400, all unwritten', async () => {
    const m = mountBoth();
    const bad = [
      { slot: 'model', provider: 'x' },
      { slot: 'ask', provider: 42 },
      { slot: 'ask', provider: 'bad\u0000name' },
      { slot: 'ask', provider: 'x'.repeat(300) },
      // The value is forwarded VERBATIM as one CLI argv element. A leading dash
      // would be read by the CLI's argv parser as an OPTION, not as this
      // option's value — refuse it HERE, while the panel can still show why.
      { slot: 'ask', provider: '--no-web' },
      { slot: 'ask', provider: '-x' },
    ];
    for (const body of bad) {
      const r = await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body });
      assert.equal(r.status, 400, `must refuse ${JSON.stringify(body).slice(0, 40)} (got ${r.status}: ${r.body && r.body.error})`);
      assert.equal(r.body.ok, false);
      assert.ok(r.body.error.length > 0, 'a refusal must name itself');
    }
    assert.equal(existsSync(m.state), false, 'no rejection may create the state file');
  });

  it('a MISSING provider field is not a CLEAR', async () => {
    // `normalizeProviderName(undefined)` reads null as "clear the pick" — which
    // is how the wire spells 未插手, but it also made a body WITHOUT the field
    // silently erase the user's selection (an older client, a hand-typed curl).
    const m = mountBoth();
    await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'ask', provider: 'AtomGit-glm5.3-flash' } });
    const r = await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'ask' } });
    assert.equal(r.status, 400, `a body without the provider field must be refused (got ${r.status})`);
    assert.match(r.body.error, /provider field is missing/, 'and say that clearing must be explicit');
    assert.equal(r.body.ok, false);
    // The surviving pick is still on disk — read it back through the stats route,
    // the same way the panel would learn it.
    const poll = await callRoute(m.stats, { headers: HOME_HDRS });
    assert.equal(poll.body.provider.ask.panel, 'AtomGit-glm5.3-flash', 'a refused write must not erase the pick');
    // Clearing stays an OBSERVABLE act: field present, value null.
    const cleared = await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'ask', provider: null } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.ask.panel, null);
  });

  it('refuses a body that is not a JSON object', async () => {
    const m = mountBoth();
    const cases = ['not json at all', '[]', 'null', ''];
    for (const raw of cases) {
      const r = await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: raw });
      assert.equal(r.status, 400, `must refuse ${JSON.stringify(raw)} (got ${r.status})`);
      assert.equal(r.body.ok, false);
    }
  });

  it('refuses an oversized body instead of buffering it', async () => {
    const m = mountBoth();
    const r = await callRoute(m.provider, {
      method: 'POST',
      headers: HOME_HDRS,
      body: '{"slot":"ask","provider":"' + 'y'.repeat(9000) + '"}',
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /larger than \d+ bytes/, 'the refusal must name the limit it enforced');
  });

  it('a disallowed method is refused with 405 and an Allow header', async () => {
    const m = mountBoth();
    const r = await callRoute(m.provider, { method: 'DELETE', headers: HOME_HDRS });
    assert.equal(r.status, 405);
    assert.match(String(r.headers.allow || ''), /GET/);
    assert.match(String(r.headers.allow || ''), /POST/);
  });

  it('a cross-origin write is refused with 403', async () => {
    const m = mountBoth();
    const r = await callRoute(m.provider, {
      method: 'POST',
      headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
      body: { slot: 'ask', provider: 'AtomGit-glm5.3-flash' },
    });
    assert.equal(r.status, 403);
    assert.equal(existsSync(m.state), false, 'a refused origin must not write anything');
  });

  it('a state file from a NEWER build is read as no-pick and refused for write (409)', async () => {
    // Write-side version guard: a downgraded plugin must not clobber a newer shape
    // and make the user's pick vanish on the next upgrade.
    const m = mountBoth();
    writeFileSync(m.state, JSON.stringify({ version: 99, ask: 'Future-Profile', review: null }), 'utf8');
    const g = await callRoute(m.provider, { headers: HOME_HDRS });
    assert.equal(g.body.ask.panel, null, 'a foreign version reads as no pick');
    assert.equal(g.body.foreignVersion, true);
    const w = await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'ask', provider: 'X' } });
    assert.equal(w.status, 409, 'and the write is refused, not silently accepted');
    assert.match(w.body.error, /newer build/i);
    assert.match(readFileSync(m.state, 'utf8'), /Future-Profile/, 'the newer file is left intact');
  });

  it('a corrupt state file is preserved aside and reads as no-pick with a reason', async () => {
    const m = mountBoth();
    writeFileSync(m.state, '{ this is not json', 'utf8');
    const r = await callRoute(m.provider, { headers: HOME_HDRS });
    assert.equal(r.status, 200, 'a broken preference must not take the panel down');
    assert.equal(r.body.ask.panel, null);
    assert.ok(r.body.storeError.length > 0, 'and it must say what happened');
    const leftovers = readdirSync(m.dir).filter((n) => n.startsWith('provider.json.corrupt-'));
    assert.equal(leftovers.length, 1, 'the unreadable file is preserved aside, never erased');
  });

  it('writing a pick never touches ~/.atomcode/config.toml (红线 8 boundary)', async () => {
    // The load-bearing assertion for this whole feature: the panel chooses a model
    // by writing the PLUGIN's own state, while AtomCode's configuration stays
    // read-only for us. If anyone later "makes the dropdown change the default for
    // AtomCode too", this is the test that fails — here, not on the user's machine.
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-prov-home-'));
    mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
    const cfgPath = join(fakeHome, '.atomcode', 'config.toml');
    const original = ['default_provider = "AtomGit-qwen3.8-27b"', '', '[providers.atomcode-local]', 'base_url = "http://127.0.0.1:8899/v1"', 'api_key = "local"'].join('\n');
    writeFileSync(cfgPath, original, 'utf8');
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const m = mountBoth();
      const w = await callRoute(m.provider, { method: 'POST', headers: HOME_HDRS, body: { slot: 'ask', provider: 'AtomGit-glm5.3-flash' } });
      assert.equal(w.status, 200);
      assert.equal(readFileSync(cfgPath, 'utf8'), original, 'config.toml must be byte-identical after a pick');
      // And the pick lives where it should — the plugin state dir, nowhere else.
      assert.ok(existsSync(m.state));
      const strays = readdirSync(join(fakeHome, '.atomcode')).filter((n) => /provider/i.test(n));
      assert.deepEqual(strays, [], 'no provider state may be written under ~/.atomcode');
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile;
      else delete process.env.USERPROFILE;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

/**
 * The session store's degradation channel.
 *
 * Session glue is an optimisation — a state file that cannot be read or written
 * costs one fresh side conversation, and must never cost a turn. This suite
 * pins the two ways that promise was broken:
 *
 *  - a `state_path` pointing at a DIRECTORY made the raw write throw EISDIR,
 *    and a throw from `set()` propagated out of `execute()` AFTER the turn had
 *    already succeeded, handing a complete answer back as a tool error;
 *  - degrading silently is not an option either — the panel kept showing a
 *    tracked count that had simply stopped growing (红线 3).
 */
describe('stats route — a degraded session store is named, not hidden', () => {
  const HEADERS = { host: '127.0.0.1:3080' };
  const dirs = [];

  /** @returns {object} the stats route, mounted over `statePath` (file OR directory). */
  function mountWithStatePath(statePath) {
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-sessions-'));
    dirs.push(dir);
    return captureRoutes({ statePath, port: CLOSED_PORT }).find((r) => r.path === STATS_PATH);
  }

  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('a state file that does not exist yet reports no error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-sessions-'));
    dirs.push(dir);
    const route = mountWithStatePath(join(dir, 'sessions.json'));
    const r = await callRoute(route, { headers: HEADERS });
    assert.equal(r.status, 200);
    assert.equal(r.body.sessions.tracked, 0);
    assert.equal(r.body.sessions.error, '', 'a first run has nothing to report');
  });

  it('state_path pointing at a DIRECTORY is named, and the directory is left intact', async () => {
    // The directory IS the state path — the misconfiguration that made the write
    // throw. `mountWithStatePath` still creates its own temp dir for mounting.
    const victim = mkdtempSync(join(tmpdir(), 'atomcode-victim-'));
    dirs.push(victim);
    const route = mountWithStatePath(victim);
    const r = await callRoute(route, { headers: HEADERS });
    assert.equal(r.status, 200, 'a broken state path must not break the stats route');
    assert.equal(r.body.sessions.tracked, 0);
    assert.ok(r.body.sessions.error, 'the degradation must be named, not swallowed');
    assert.match(r.body.sessions.error, /directory/, 'the cause must be the directory, not a generic failure');
    // EISDIR is a CONFIGURATION mistake, not a corrupt file: quarantining it
    // would mean renaming the user's directory to `<dir>.corrupt-<ts>`.
    assert.ok(existsSync(victim), 'the directory must still exist');
    assert.deepEqual(
      readdirSync(victim).filter((name) => name.includes('.corrupt-')),
      [],
      'a directory must never be quarantined',
    );
  });

  it('the store itself degrades on an unwritable path instead of throwing', async () => {
    // Unit-level, through the same module the host mounts: `set()` used to be a
    // bare `writeJsonFile` call, so this line threw and took the turn with it.
    const victim = mkdtempSync(join(tmpdir(), 'atomcode-unwritable-'));
    dirs.push(victim);
    const seen = [];
    const store = createSessionStore(victim, '', { onError: (error) => seen.push(error) });
    assert.equal(store.set('C:\\repo', 'sess-1'), false, 'the write degraded, so nothing was recorded');
    assert.equal(store.get('C:\\repo'), undefined);
    assert.ok(seen.length > 0, 'the degradation must reach the observer');
    // Deduplicated: a panel poll re-reads a broken path every time, and must not
    // report the same failure once per poll.
    const before = seen.length;
    store.get('C:\\repo');
    store.count();
    assert.equal(seen.length, before, 'the same failure must not be reported twice');
  });
});
