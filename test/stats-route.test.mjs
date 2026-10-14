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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Mount the plugin and return the captured stats route. */
function mountRoute({ statePath, port = CLOSED_PORT, extra = {} }) {
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
  assert.equal(routes.length, 1, 'exactly one route must be registered');
  return routes[0];
}

/** Drive the handler the way the panel polls it. */
async function callRoute(route, { method = 'GET', headers = {} } = {}) {
  const captured = { status: 0, headers: {}, body: null, raw: undefined, ended: false };
  const response = {
    writeHead(status, hdrs) {
      captured.status = status;
      captured.headers = hdrs || {};
    },
    end(body) {
      captured.ended = true;
      if (body === undefined) return;
      captured.raw = body;
      try {
        captured.body = JSON.parse(body);
      } catch {
        captured.body = null;
      }
    },
  };
  await route.handler({ method, headers }, response);
  assert.equal(captured.ended, true, 'the handler must end the response');
  return captured;
}

const pick = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

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
    assert.equal(r.body.name, 'dsh-atomcode-bridge');
  });

  it('HEAD is allowed like GET', async () => {
    const r = await callRoute(route, { method: 'HEAD', headers: { host: '127.0.0.1:3080' } });
    assert.equal(r.status, 200);
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
      'config.defaultWorkingDir',
      'config.reviewAvailable',
      'config.reviewReason',
      'sessions.tracked',
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
    // client.js: `bin.configured || bin.env || '自动探测（PATH）'`
    assert.equal(body.binary.configured, false);
    assert.equal(body.binary.env, undefined, 'no ATOMCODE_BIN in this process');
    assert.equal(body.binary.source, 'auto');
    assert.ok(
      body.binary.configured || body.binary.env || '自动探测（PATH）',
      'the fallback chain must always yield a label',
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

describe('stats route — binary source reporting', () => {  it('reports the env source when ATOMCODE_BIN is set at mount time', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-stats-')), 'sessions.json');
    const saved = process.env.ATOMCODE_BIN;
    process.env.ATOMCODE_BIN = 'C:\\tools\\atomcode.exe';
    try {
      const route = mountRoute({ statePath });
      const r = await callRoute(route, { headers: { host: '127.0.0.1:3080' } });
      assert.equal(r.body.binary.env, 'C:\\tools\\atomcode.exe');
      assert.equal(r.body.binary.source, 'env', 'the panel labels this row from `source`');
      assert.equal(r.body.binary.configured, false, 'config.binary is unset here');
    } finally {
      if (saved === undefined) delete process.env.ATOMCODE_BIN;
      else process.env.ATOMCODE_BIN = saved;
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
      assert.match(body.quota.reason, /未运行/);
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
      assert.match(body.quota.reason, /daemon 未运行/);
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
      // Let the in-flight start settle (its 1s budget), then poll again.
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const second = (await callRoute(route, { headers: { host: '127.0.0.1:3080' } })).body;
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
      await new Promise((resolve) => setTimeout(resolve, 1600));
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
      fiber: { entry: { options: { id: 'dsh-atomcode-bridge' } } },
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
      assert.equal(typeof body.daemon.spawnAttempts, 'number');
      assert.ok(body.config.askMaxRounds > 0, 'the ask round ceiling must be visible');
      assert.equal(typeof body.config.reviewWorkingDir, 'object', 'a missing repo dir is null, not absent');
    } finally {
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });
});
