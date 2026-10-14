/**
 * wiring.test.mjs — tools-only plugin wiring under a fake Cordis context.
 *
 * v0.3 ships no LlmAdapter: the bridge registers exactly two model tools
 * (`atomcode_ask`, `atomcode_review`) and nothing on the `llm` service.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

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
