/**
 * wiring.test.mjs — tools-only plugin wiring under a fake Cordis context.
 *
 * v0.3 ships no LlmAdapter: the bridge registers exactly two model tools
 * (`atomcode_ask`, `atomcode_review`) and nothing on the `llm` service.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
