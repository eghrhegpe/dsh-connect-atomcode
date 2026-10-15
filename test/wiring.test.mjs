/**
 * wiring.test.mjs — tools-only plugin wiring under a fake Cordis context.
 *
 * v0.3 ships no LlmAdapter: the bridge registers exactly two model tools
 * (`atomcode_ask`, `atomcode_review`) and nothing on the `llm` service.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, after } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(__dirname, '..', 'lib', 'index.js');
const REVIEW = join(__dirname, '..', 'lib', 'review.js');
const SESSIONS = join(__dirname, '..', 'lib', 'sessions.js');

function fileUrl(p) {
  if (p.startsWith('/')) return `file://${p}`;
  return `file:///${p.replace(/\\/g, '/')}`;
}

function fakeCtx() {
  const calls = { tools: [], effects: 0 };
  const tools = {
    register(def) {
      calls.tools.push(def);
      return () => {};
    },
  };
  const ctx = {
    get: (name) => (name === 'tools' ? tools : undefined),
    logger: { warn() {}, error() {}, info() {} },
    fiber: { entry: { options: { id: 'dsh-atomcode-bridge' } } },
    inject() {},
    effect(fn) {
      calls.effects += 1;
      fn(); // invoke to capture the cleanup return
      return () => {};
    },
    on() {},
    webServer: { register() { return () => {}; } },
  };
  return { ctx, calls };
}

describe('lib/index.js — tools-only wiring (v0.3)', () => {
  it('exports name/inject/apply; inject is ["tools", "webServer"], no host LLM import', async () => {
    const mod = await import(fileUrl(BRIDGE));
    assert.equal(mod.name, 'atomcode-bridge');
    assert.ok(mod.inject.includes('tools'));
    assert.ok(mod.inject.includes('webServer'));
    assert.equal(typeof mod.apply, 'function');
    const source = readFileSync(BRIDGE, 'utf8');
    assert.ok(!source.includes('@deepseek-ai/dsh-llm'), 'v0.3 must not import the LLM service');
    assert.ok(!source.includes('registerAdapter'), 'no adapter registration');
    assert.ok(!source.includes('registerConfigurableProviders'), 'no provider directory registration');
  });

  it('registers exactly two tools: atomcode_ask + atomcode_review', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wiring-')), 'sessions.json');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    mod.apply(ctx, { state_path: statePath, auto_start: false });
    assert.deepEqual(calls.tools.map((t) => t.name).sort(), ['atomcode_ask', 'atomcode_review']);
    assert.equal(calls.effects, 1, 'one effect registers both disposers');
    for (const def of calls.tools) {
      assert.equal(typeof def.execute, 'function');
      assert.ok(def.output.schema, 'every tool declares an output schema');
      assert.equal(typeof def.output.render, 'function');
      assert.equal(def.output.schema.additionalProperties, false);
    }
  });

  it('every tool declares timeoutMs', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wiring-')), 'sessions.json');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    mod.apply(ctx, { state_path: statePath, auto_start: false });
    for (const def of calls.tools) {
      assert.ok(Number.isFinite(def.timeoutMs) && def.timeoutMs > 0, `tool ${def.name} must declare timeoutMs`);
    }
  });

  it('atomcode_ask schema carries the side-conversation knobs (incl. max_rounds)', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wiring-')), 'sessions.json');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    mod.apply(ctx, { state_path: statePath });
    const ask = calls.tools.find((t) => t.name === 'atomcode_ask');
    for (const key of ['message', 'continue', 'session_id', 'provider', 'working_dir', 'timeout_secs', 'max_rounds']) {
      assert.ok(ask.parameters.properties[key], `missing param ${key}`);
    }
    assert.deepEqual(ask.parameters.required, ['message']);
    for (const key of ['ok', 'reply', 'session_id', 'continued', 'tokens', 'tool_calls', 'round_count', 'tools', 'stop_reason', 'provider', 'error']) {
      assert.ok(ask.output.schema.properties[key], `missing output field ${key}`);
    }
  });

  it('atomcode_review schema carries the diff selection + fuses', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wiring-')), 'sessions.json');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    mod.apply(ctx, { state_path: statePath });
    const review = calls.tools.find((t) => t.name === 'atomcode_review');
    for (const key of ['working_dir', 'task', 'base', 'staged', 'pr', 'diff_text', 'provider', 'max_rounds', 'max_duration_secs', 'enable_web']) {
      assert.ok(review.parameters.properties[key], `missing param ${key}`);
    }
    assert.deepEqual(review.parameters.required, [], 'review has no required params (working_dir has a config fallback)');
    for (const key of ['ok', 'report', 'error', 'exit_code', 'duration_ms']) {
      assert.ok(review.output.schema.properties[key], `missing output field ${key}`);
    }
  });

  it('config {get()} boxes are unwrapped and malformed values degrade', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wiring-')), 'sessions.json');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    const box = (v) => ({ get: () => v });
    mod.apply(ctx, { port: box(99999999), auto_start: box(true), state_path: statePath });
    assert.equal(calls.tools.length, 2, 'mount survives garbage config');
  });

  it('missing tools service leaves the mount quiet', async () => {
    const ctx = {
      get: () => undefined,
      logger: { warn() {}, error() {} },
      fiber: { entry: { options: { id: 'x' } } },
      inject() {},
      effect() {},
      on() {},
    };
    const mod = await import(fileUrl(BRIDGE));
    mod.apply(ctx, {}); // must not throw
  });

  it('atomcode_review description reflects checkReviewProvision (no direct provider = warning prefix)', async () => {
    // Create a config.toml with only account-resolved models (no [providers.<name>] with base_url)
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-prov-'));
    const cfgDir = join(fakeHome, '.atomcode');
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, 'config.toml');
    writeFileSync(cfgPath, [
      'default_provider = "AtomGit-qwen3.8-27b"',
      '',
      '[provider_accounts.AtomGit]',
      'provider = "openai"',
      'base_url = "https://llm-api.atomgit.com/v1"',
      '',
      '[models."AtomGit-qwen3.8-27b"]',
      'account = "AtomGit"',
      'model = "qwen3.8-27b"',
    ].join('\n'), 'utf8');

    // Override homedir temporarily.
    const origHome = process.env.HOME || homedir();
    try {
      process.env.HOME = fakeHome;
      // Re-import review module (has cached checkReviewProvision import, but the probe reads fresh each call).
      const { checkReviewProvision } = await import(fileUrl(REVIEW));
      const prov = checkReviewProvision(join(fakeHome, '.atomcode'));
      assert.equal(prov.available, false);
      assert.ok(prov.reason.length > 0);
    } finally {
      process.env.HOME = origHome;
      const { rmSync } = await import('node:fs');
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('atomcode_review REFUSES rather than falling back to the host process cwd', async () => {
    // The v0.3 hole: with neither `working_dir` on the call nor the plugin
    // config, the review spawned with cwd = process.cwd() — the DSH launch
    // directory — so `git diff` reviewed the wrong tree (or nothing) while the
    // tool reported whatever the CLI said. A wrong-repo review that looks
    // successful is worse than a refusal.
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wd-')), 'sessions.json');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    // NOTE: no working_dir / review_working_dir in this config.
    mod.apply(ctx, { state_path: statePath, auto_start: false });
    const review = calls.tools.find((t) => t.name === 'atomcode_review');
    const r = await review.execute({ base: 'main' }, {});
    assert.equal(r.ok, false);
    assert.match(r.error, /needs a repository/, 'the refusal must name what is missing');
    assert.match(r.error, /working_dir/);
    assert.equal(r.exit_code, -1);
  });

  it('a configured review_working_dir is used instead of the host cwd', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wd2-')), 'sessions.json');
    const repo = mkdtempSync(join(tmpdir(), 'atomcode-repo-'));
    // Inject a config the probe accepts, so the repo requirement is what decides
    // the outcome (on this host the real config has only the gateway).
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-wd2-home-'));
    mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
    writeFileSync(join(fakeHome, '.atomcode', 'config.toml'), [
      'default_provider = "direct"',
      '[providers.direct]',
      'base_url = "https://some-llm.test/v1"',
      'api_key = "sk-test"',
    ].join('\n'), 'utf8');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      mod.apply(ctx, { state_path: statePath, auto_start: false, review_working_dir: repo });
      const review = calls.tools.find((t) => t.name === 'atomcode_review');
      // No such binary → the run fails, but the failure must NOT be the "needs a
      // repository" refusal: the config satisfied the repo requirement.
      const r = await review.execute({ base: 'main' }, {});
      assert.doesNotMatch(r.error, /needs a repository/, 'the configured repo must satisfy the requirement');
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
      const { rmSync } = await import('node:fs');
      rmSync(repo, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('review refuses with a config diagnostic when no usable provider exists', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wd3-')), 'sessions.json');
    const repo = mkdtempSync(join(tmpdir(), 'atomcode-repo-'));
    // A gateway-only config: the repo is fine, the PROVIDER is not. This is the
    // case the re-read probe exists for.
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-wd3-home-'));
    mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
    writeFileSync(join(fakeHome, '.atomcode', 'config.toml'), [
      'default_provider = "gw"',
      '[providers.gw]',
      'base_url = "https://llm-api.atomgit.com/v1"',
    ].join('\n'), 'utf8');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      mod.apply(ctx, { state_path: statePath, auto_start: false });
      const review = calls.tools.find((t) => t.name === 'atomcode_review');
      const r = await review.execute({ working_dir: repo, base: 'main' }, {});
      assert.equal(r.ok, false);
      assert.match(r.error, /unavailable on this host/);
      assert.match(r.error, /atomcode_ask/, 'the diagnostic must name the working alternative');
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
      const { rmSync } = await import('node:fs');
      rmSync(repo, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('lib/index.js — ask safety defaults', () => {
  it('the ask round budget defaults to a bounded value, not unlimited', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-safe-')), 'sessions.json');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    mod.apply(ctx, { state_path: statePath, auto_start: false, port: 45996 });
    const ask = calls.tools.find((t) => t.name === 'atomcode_ask');
    // v0.3 defaulted to 0 (unlimited) alongside approval_mode: bypass, i.e.
    // "unattended autonomous agent with no ceiling" was the SHIPPED default.
    assert.doesNotMatch(ask.parameters.properties.max_rounds.description, /默认不限/);
    assert.match(ask.parameters.properties.max_rounds.description, /25/, 'the bounded default must be documented');
    assert.ok(ask.parameters.properties.reset_session, 'the stale-session escape hatch must be exposed');
    assert.ok(ask.output.schema.properties.truncated, 'truncation must be a declared output field');
  });
});

describe('lib/sessions.js — key prefixing', () => {
  it('prefix isolates keys', async () => {
    const f = mkdtempSync(join(tmpdir(), 'atomcode-sess-'));
    const p = join(f, 's.json');
    const { createSessionStore } = await import(fileUrl(SESSIONS));
    const storeA = createSessionStore(p, 'web');
    const storeB = createSessionStore(p, 'desktop');
    storeA.set('workdir', 'sid-1');
    assert.equal(storeA.get('workdir'), 'sid-1');
    assert.equal(storeB.get('workdir'), undefined, 'desktop prefix should not see web stored session');
    storeB.set('workdir', 'sid-2');
    assert.equal(storeA.get('workdir'), 'sid-1', 'web prefix should still see its own');
    assert.equal(storeB.get('workdir'), 'sid-2', 'desktop prefix should see its own');
    // drop only one prefix
    storeA.drop('workdir');
    assert.equal(storeA.get('workdir'), undefined, 'web dropped');
    assert.equal(storeB.get('workdir'), 'sid-2', 'desktop unaffected');
    const { rmSync } = await import('node:fs');
    rmSync(f, { recursive: true, force: true });
  });

  it('empty prefix behaves as before', async () => {
    const f = mkdtempSync(join(tmpdir(), 'atomcode-sess-'));
    const p = join(f, 's.json');
    const { createSessionStore } = await import(fileUrl(SESSIONS));
    const store = createSessionStore(p, '');
    store.set('key1', 'sid-1');
    const store2 = createSessionStore(p, '');
    assert.equal(store2.get('key1'), 'sid-1', 'same empty prefix sees each other');
    const store3 = createSessionStore(p, 'other');
    assert.equal(store3.get('key1'), undefined, 'different prefix does not see');
    const { rmSync } = await import('node:fs');
    rmSync(f, { recursive: true, force: true });
  });

  it('count() is prefix-scoped, so the panel does not inflate with a sibling profile', async () => {
    // v0.3 counted EVERY key in the shared file, so a desktop profile's tracked
    // sessions showed up in the web panel's "已跟踪会话" count.
    const f = mkdtempSync(join(tmpdir(), 'atomcode-count-'));
    const p = join(f, 's.json');
    const { createSessionStore } = await import(fileUrl(SESSIONS));
    const web = createSessionStore(p, 'web');
    const desktop = createSessionStore(p, 'desktop');
    web.set('a', 's1');
    web.set('b', 's2');
    desktop.set('c', 's3');
    desktop.set('d', 's4');
    desktop.set('e', 's5');
    assert.equal(web.count(), 2, "the web panel must show web's own 2 sessions");
    assert.equal(desktop.count(), 3, "the desktop panel must show its own 3");
    const unprefixed = createSessionStore(p, '');
    assert.equal(unprefixed.count(), 5, 'with no prefix every key is this store’s key');
    const { rmSync } = await import('node:fs');
    rmSync(f, { recursive: true, force: true });
  });

  it('a second writer does not drop the first writer\'s key (no stale cache)', async () => {
    // Regression for the lost-update bug: two DSH profiles (web + desktop) share
    // one state file. With a process-lifetime cache, the second writer persists
    // a map that predates the first writer's change and silently erases it.
    const f = mkdtempSync(join(tmpdir(), 'atomcode-lost-'));
    const p = join(f, 's.json');
    const { createSessionStore } = await import(fileUrl(SESSIONS));
    const web = createSessionStore(p, 'web');
    const desktop = createSessionStore(p, 'desktop');
    // desktop touches the file BEFORE web writes, so a long-lived cache is stale.
    desktop.get('prime-the-stale-cache');
    web.set('workdir', 'sid-web');
    desktop.set('workdir', 'sid-desktop');
    assert.equal(
      createSessionStore(p, 'web').get('workdir'),
      'sid-web',
      "web's recorded session must survive desktop's later write",
    );
    assert.equal(createSessionStore(p, 'desktop').get('workdir'), 'sid-desktop');
    const { rmSync } = await import('node:fs');
    rmSync(f, { recursive: true, force: true });
  });

  it('a corrupt state file is preserved aside instead of being silently erased', async () => {
    const f = mkdtempSync(join(tmpdir(), 'atomcode-corrupt-'));
    const p = join(f, 's.json');
    writeFileSync(p, '{ this is not json', 'utf8');
    const { createSessionStore } = await import(fileUrl(SESSIONS));
    const store = createSessionStore(p, '');
    assert.equal(store.get('anything'), undefined, 'a corrupt file reads as empty');
    const quarantined = readdirSync(f).filter((n) => n.includes('.corrupt-'));
    assert.equal(quarantined.length, 1, 'the corrupt file must be kept for inspection, not destroyed');
    rmSync(f, { recursive: true, force: true });
  });

  it('mount-time sweep bounds quarantine generations and reclaims abandoned temps', async () => {
    const f = mkdtempSync(join(tmpdir(), 'atomcode-gc-'));
    const p = join(f, 's.json');
    for (const ts of [1000, 2000, 3000, 4000]) writeFileSync(`${p}.corrupt-${ts}`, 'x', 'utf8');
    const oldTmp = `${p}.999.1000.tmp`;
    const freshTmp = `${p}.999.${Date.now()}.tmp`;
    writeFileSync(oldTmp, 'x', 'utf8');
    writeFileSync(freshTmp, 'x', 'utf8');
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(oldTmp, longAgo, longAgo);

    const { createSessionStore } = await import(fileUrl(SESSIONS));
    createSessionStore(p, 'web'); // mounting performs the sweep

    const left = readdirSync(f);
    assert.equal(
      left.filter((n) => n.includes('.corrupt-')).length,
      2,
      `only the newest quarantine generations are kept; left=${JSON.stringify(left)}`,
    );
    assert.ok(!left.includes(basename(oldTmp)), 'an abandoned temp file is reclaimed');
    assert.ok(
      left.includes(basename(freshTmp)),
      'a fresh temp file may belong to a live writer and must be left alone',
    );
    rmSync(f, { recursive: true, force: true });
  });
});

describe('lib/index.js — cancelled startup', () => {
  it('a cancelled ask returns promptly instead of riding out the 30s start poll', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-cancel-')), 'sessions.json');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    // Nothing listens on this port, so ensureDaemon would otherwise poll for 30s
    // (20 × 1.5s) before giving up.
    mod.apply(ctx, {
      state_path: statePath,
      auto_start: true,
      binary: 'definitely-not-a-real-binary-xyz-123',
      port: 45999,
    });
    const ask = calls.tools.find((t) => t.name === 'atomcode_ask');
    const ctrl = new AbortController();
    ctrl.abort(); // the caller cancelled before the turn even started

    const startedAt = Date.now();
    const result = await ask.execute({ message: 'hi' }, { signal: ctrl.signal });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.ok, false);
    assert.ok(elapsed < 3000, `a cancelled call must not poll for 30s; took ${elapsed}ms`);
    assert.match(
      result.error,
      /已取消/,
      'cancel-during-startup must be reported as a cancellation, not as a daemon outage',
    );
  });
});

describe('lib/review.js — checkReviewProvision', () => {
  it('returns available=false with reason on absent config.toml', async () => {
    const { checkReviewProvision } = await import(fileUrl(REVIEW));
    const r = checkReviewProvision(join(tmpdir(), 'atomcode-nonexistent-999'));
    assert.equal(r.available, false);
    assert.ok(r.reason.includes('not found'), `reason=${r.reason}`);
  });

  it('returns available=false with reason when only gateway provider exists', async () => {
    const f = mkdtempSync(join(tmpdir(), 'atomcode-gw-'));
    writeFileSync(join(f, 'config.toml'), [
      'default_provider = "gw"',
      '',
      '[provider_accounts.gw]',
      'provider = "openai"',
      'base_url = "https://llm-api.atomgit.com/v1"',
      '',
      '[providers.gw]',
      'account = "gw"',
    ].join('\n'), 'utf8');
    const { checkReviewProvision } = await import(fileUrl(REVIEW));
    const r = checkReviewProvision(f);
    assert.equal(r.available, false);
    assert.ok(r.reason.length > 0);
    const { rmSync } = await import('node:fs');
    rmSync(f, { recursive: true, force: true });
  });

  it('returns available=true when a direct [providers.X] with non-gateway base_url exists', async () => {
    const f = mkdtempSync(join(tmpdir(), 'atomcode-ok-'));
    writeFileSync(join(f, 'config.toml'), [
      'default_provider = "direct"',
      '',
      '[providers.direct]',
      'provider = "openai"',
      'base_url = "https://some-llm.test/v1"',
      'api_key = "sk-test"',
    ].join('\n'), 'utf8');
    const { checkReviewProvision } = await import(fileUrl(REVIEW));
    const r = checkReviewProvision(f);
    assert.equal(r.available, true, `expected available=true, got reason=${r.reason}`);
    const { rmSync } = await import('node:fs');
    rmSync(f, { recursive: true, force: true });
  });
});

describe('lib/index.js — default_provider / review_default_provider (two namespaces)', () => {
  // What this suite pins is the PRECEDENCE reaching the wire, not the string in
  // the config: a configured default that silently never gets sent is the worst
  // outcome, and a configured default that ALWAYS gets sent would override
  // AtomCode's own `default_provider` on every bridged turn. Both directions
  // need a guard, so the fake daemon below records the real /chat payload.
  /** @type {Array<import('node:http').Server>} */
  const openServers = [];
  const stateDirs = [];
  after(() => {
    for (const server of openServers) server.close();
    for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Fake daemon: answers /health so the ask path proceeds, and records the
   * POST /chat body it was actually handed.
   * @returns {Promise<{port:number, chats:Array<object>, port_server:import('node:http').Server}>}
   */
  async function startChatProbe() {
    /** @type {Array<object>} */
    const chats = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: 'atomcode-daemon', version: '5.2.2-test' }));
          return;
        }
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          body = { __unparsable: raw };
        }
        chats.push(body);
        const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          sse([
            // Echo the provider the client asked for, the way the real daemon's
            // runtime_info does — so `result.provider` is checked against intent.
            { type: 'runtime_info', provider: body.provider || 'AtomGit-qwen3.8-27b', model: 'probe-model' },
            { type: 'text', content: 'OK' },
            { type: 'done', tokens: 12, tool_calls: 0, session_id: 'sid-probe', stop_reason: 'stopped' },
          ]),
        );
      });
    });
    openServers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, chats };
  }

  /** Mount the plugin against the probe daemon and hand back the ask tool. */
  async function mountAsk(extraConfig) {
    const probe = await startChatProbe();
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-dp-'));
    stateDirs.push(dir);
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    mod.apply(ctx, {
      state_path: join(dir, 'sessions.json'),
      auto_start: false,
      port: probe.port,
      ...extraConfig,
    });
    const ask = calls.tools.find((t) => t.name === 'atomcode_ask');
    return { ask, chats: probe.chats, calls };
  }

  it('a configured default_provider reaches POST /chat', async () => {
    const { ask, chats } = await mountAsk({ default_provider: 'AtomGit-glm5.3-flash' });
    const r = await ask.execute({ message: 'hi' }, {});
    assert.equal(r.ok, true, r.error);
    assert.equal(chats.length, 1, 'exactly one /chat was made');
    assert.equal(chats[0].provider, 'AtomGit-glm5.3-flash', 'the configured profile must go on the wire');
    assert.equal(r.provider, 'AtomGit-glm5.3-flash', 'the turn must report the profile it ran with');
  });

  it('a per-call provider argument beats the configured default', async () => {
    const { ask, chats } = await mountAsk({ default_provider: 'AtomGit-glm5.3-flash' });
    await ask.execute({ message: 'hi', provider: 'AtomGit-qwen3.8-27b' }, {});
    assert.equal(chats[0].provider, 'AtomGit-qwen3.8-27b', 'the caller names the model for this turn');
  });

  it('an UNSET default_provider sends no provider field at all', async () => {
    // The other half of the contract: with the knob left empty the bridge must
    // stay out of model selection. Always pinning a provider would silently
    // re-point every bridged turn the moment the user changes AtomCode's own
    // default (and would leak a stale profile name across hosts).
    const { ask, chats } = await mountAsk({});
    const r = await ask.execute({ message: 'hi' }, {});
    assert.equal(r.ok, true, r.error);
    assert.ok(!('provider' in chats[0]), `no provider key expected, got ${JSON.stringify(chats[0].provider)}`);
    assert.equal(r.provider, 'AtomGit-qwen3.8-27b', 'falls back to whatever the daemon reports');
  });

  it('an empty/whitespace default_provider behaves exactly like an unset one', async () => {
    const { ask, chats } = await mountAsk({ default_provider: '   ' });
    await ask.execute({ message: 'hi' }, {});
    assert.ok(!('provider' in chats[0]), 'a blank profile must not become provider=""');
  });

  it('a non-string default_provider is dropped, never stringified (config is unvalidated)', async () => {
    const { ask, chats, calls } = await mountAsk({ default_provider: 42 });
    assert.equal(calls.tools.length, 2, 'the mount survives garbage config');
    await ask.execute({ message: 'hi' }, {});
    assert.ok(!('provider' in chats[0]), 'a number must not be coerced into a provider name');
  });

  it('a real provider name is trimmed before it goes on the wire', async () => {
    const { ask, chats } = await mountAsk({ default_provider: ' AtomGit-glm5.3-flash ' });
    await ask.execute({ message: 'hi' }, {});
    assert.equal(chats[0].provider, 'AtomGit-glm5.3-flash');
  });

  it('review_default_provider does not leak onto the ask wire', async () => {
    // The other direction of the namespace split: "atomcode-local" is a direct
    // [providers.<name>] entry the CLI understands, and nothing else. Sending it
    // to /chat would ask the daemon for a profile it does not have.
    const { ask, chats } = await mountAsk({ review_default_provider: 'atomcode-local' });
    const r = await ask.execute({ message: 'hi' }, {});
    assert.equal(r.ok, true, r.error);
    assert.ok(!('provider' in chats[0]), `review knob must not reach /chat, got ${JSON.stringify(chats[0].provider)}`);
  });

  it('both tool descriptions teach that `provider` takes a model PROFILE name', async () => {
    // 红线 1 discipline applied to model selection: the model is told BEFORE the
    // call. AtomCode 5.x has no "provider == vendor" notion on this path; passing
    // "glm5.3-flash" instead of "AtomGit-glm5.3-flash" is the obvious wrong move.
    //
    // HOME is pinned (like the review-selection test below) because the review
    // description interpolates the machine's usable direct providers: reading the
    // DEVELOPER'S real ~/.atomcode/config.toml would make the "must not mention the
    // ask profile" assertion a property of this host rather than of the code.
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-dp-desc-'));
    mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.atomcode', 'config.toml'),
      [
        'default_provider = "account-gw"',
        '[providers.direct]',
        'provider = "openai"',
        'base_url = "https://direct.test/v1"',
        'api_key = "sk-1"',
      ].join('\n'),
      'utf8',
    );
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-dp-desc2-'));
    stateDirs.push(dir);
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const { ctx, calls } = fakeCtx();
      const mod = await import(fileUrl(BRIDGE));
      mod.apply(ctx, {
        state_path: join(dir, 'sessions.json'),
        auto_start: false,
        default_provider: 'AtomGit-glm5.3-flash',
        review_default_provider: 'direct',
      });
      const ask = calls.tools.find((t) => t.name === 'atomcode_ask');
      assert.match(ask.description, /档位名/, 'the ask description must name the kind of value expected');
      assert.match(ask.description, /default_provider="AtomGit-glm5.3-flash"/, 'the ACTIVE default is echoed');
      assert.match(ask.parameters.properties.provider.description, /GET \/models/);
      assert.match(ask.parameters.properties.provider.description, /不要传裸模型 id/);

      const review = calls.tools.find((t) => t.name === 'atomcode_review');
      assert.match(review.description, /provider "direct"|直连 provider：direct/, 'the review knob names the real entry');
      // The two branches must not coexist: with the knob pinned, describing the
      // auto-select refusal would advertise a rejection that cannot happen.
      assert.match(review.description, /留空\*\*不会\*\*被拒绝/, 'the pinned branch must say留空 is safe');
      assert.doesNotMatch(review.description, /会要求你点名/, 'a pinned knob must not advertise the refusal branch');
      assert.match(
        review.parameters.properties.provider.description,
        /providers\.<name>/,
        'the review parameter must name its OWN namespace',
      );
      assert.match(
        review.parameters.properties.provider.description,
        /review_default_provider/,
        'and the knob it falls back to, not the ask one',
      );
      assert.doesNotMatch(
        review.description,
        /AtomGit-glm5\.3-flash/,
        'the ask-side profile must not leak into the review namespace',
      );

      // Unpinned, the refusal branch is the truthful one and must come back.
      const unpinned = fakeCtx();
      mod.apply(unpinned.ctx, { state_path: join(mkdtempSync(join(tmpdir(), 'atomcode-dp-desc3-')), 's.json'), auto_start: false });
      const review2 = unpinned.calls.tools.find((t) => t.name === 'atomcode_review');
      assert.match(review2.description, /会要求你点名/, 'without the knob, ambiguity really is a refusal');
      assert.doesNotMatch(review2.description, /留空.*不会被拒绝/);
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
      else delete process.env.USERPROFILE;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('review: a configured review_default_provider fills the selection slot instead of refusing to guess', async () => {
    // A config with TWO usable direct providers and an unusable config.toml
    // default: with no plugin default, selection must refuse rather than pick a
    // billing channel. Naming one in the plugin config resolves that refusal.
    //
    // Both direct entries point at DEAD LOOPBACK ports on purpose. The CLI's argv
    // is not observable from here (the run dies at a missing binary), so "which
    // entry did selection pick" would otherwise be unassertable — and a weaker
    // version of this test passed vacuously: the fake binary fails identically for
    // `first` and `second`, so a regression that ignored the per-call argument
    // stayed green. A dead loopback entry instead dies in probeLocalEndpoint, whose
    // diagnostic NAMES the selected provider and its base_url, which makes the
    // precedence claim assertable in the positive direction.
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-dp-rev-'));
    mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
    const FIRST = 'http://127.0.0.1:45981/v1';
    const SECOND = 'http://127.0.0.1:45982/v1';
    writeFileSync(
      join(fakeHome, '.atomcode', 'config.toml'),
      [
        'default_provider = "AtomGit-qwen3.8-27b"',
        '[providers.first]',
        'provider = "openai"',
        `base_url = "${FIRST}"`,
        'api_key = "sk-1"',
        '[providers.second]',
        'provider = "openai"',
        `base_url = "${SECOND}"`,
        'api_key = "sk-2"',
      ].join('\n'),
      'utf8',
    );
    const repo = mkdtempSync(join(tmpdir(), 'atomcode-dp-repo-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const mountReview = async (extra) => {
      const dir = mkdtempSync(join(tmpdir(), 'atomcode-dp-revs-'));
      stateDirs.push(dir);
      const { ctx, calls } = fakeCtx();
      const bridge = await import(fileUrl(BRIDGE));
      // A binary that cannot exist, as a backstop: this test must NEVER spawn the
      // real CLI even if the probe order ever changes.
      bridge.apply(ctx, {
        state_path: join(dir, 'sessions.json'),
        auto_start: false,
        binary: join(fakeHome, 'definitely-not-atomcode.exe'),
        ...extra,
      });
      return calls.tools.find((t) => t.name === 'atomcode_review');
    };
    try {
      const withoutDefault = await mountReview({});
      const r1 = await withoutDefault.execute({ working_dir: repo, task: 'noop' }, {});
      assert.equal(r1.ok, false);
      assert.match(r1.error, /several direct providers/, 'precondition: ambiguity is a refusal, not a guess');

      const withDefault = await mountReview({ review_default_provider: 'second' });
      const r2 = await withDefault.execute({ working_dir: repo, task: 'noop' }, {});
      assert.equal(r2.ok, false, 'the run still fails — at the dead endpoint, not at selection');
      assert.doesNotMatch(r2.error, /needs a repository/);
      assert.match(r2.error, /provider "second"/, 'the configured entry must be the one selected');
      assert.match(r2.error, /45982/, 'and its base_url is what got probed');
      assert.doesNotMatch(r2.error, /45981/, 'the other direct entry must not be touched');

      // A per-call argument outranks the configured default — asserted in the
      // POSITIVE direction, which is what the earlier version could not do.
      const withArg = await mountReview({ review_default_provider: 'second' });
      const r3 = await withArg.execute({ working_dir: repo, task: 'noop', provider: 'first' }, {});
      assert.match(r3.error, /provider "first"/, 'the argument must win over the configured default');
      assert.doesNotMatch(r3.error, /45982/, 'the pinned default must not be the one dialed');

      // The namespaces stay apart: the ASK-side profile must not resolve the
      // review ambiguity, because "AtomGit-qwen3.8-27b" is not a billable direct
      // entry — silently using it would point the CLI at a provider it cannot
      // authenticate against.
      const withAskProfile = await mountReview({ default_provider: 'AtomGit-qwen3.8-27b' });
      const r4 = await withAskProfile.execute({ working_dir: repo, task: 'noop' }, {});
      assert.match(r4.error, /several direct providers/, 'ask config must not leak into review selection');
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
      else delete process.env.USERPROFILE;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
