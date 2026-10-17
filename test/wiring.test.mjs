/**
 * wiring.test.mjs — tools-only plugin wiring under a fake Cordis context.
 *
 * v0.3 ships no LlmAdapter: the bridge registers exactly two model tools
 * (`atomcode_ask`, `atomcode_review`) and nothing on the `llm` service.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, after } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Every path here is a BUILD ARTIFACT (`npm run build`), not a source: the host
// half is now generated from `src/host/*.ts` into `lib/*.js`, exactly as the
// client half is generated from `src/client/*.ts` into `client.js`.
//
// These must stay on the ARTIFACTS, and that is load-bearing rather than
// stylistic: `wiring` installs the fake review spawner through
// `setSpawnOverride`, which is module-level state. `lib/index.js` imports
// `./review.js`, so the override only reaches it when the test and the plugin
// hold the SAME module instance. Pointing this at `src/host/review.ts` instead
// gives the test a private copy, the override lands on a module nobody calls,
// and the suite drives the REAL review CLI. `test/build-gate.test.mjs` is what
// guarantees these artifacts are a faithful build of `src/`.
const BRIDGE = join(__dirname, '..', 'lib', 'index.js');
const REVIEW = join(__dirname, '..', 'lib', 'review.js');
const SESSIONS = join(__dirname, '..', 'lib', 'sessions.js');
const PROVIDER_STORE = join(__dirname, '..', 'lib', 'provider-store.js');
// apply() split: `detectProfileKey` lives in config.ts now (lib/config.js), not
// in the God module — it is a pure config helper, not part of the assembly.
const CONFIG = join(__dirname, '..', 'lib', 'config.js');

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
    fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
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

  it('registered schemas stay inside the host-accepted JSON Schema subset (no array-typed `type`)', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-wiring-')), 'sessions.json');
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    mod.apply(ctx, { state_path: statePath, auto_start: false });

    // The host accepts a CLOSED subset of JSON Schema at `tools.register`: `type`
    // must be a single type string. An array-typed union is rejected with a
    // JsonSchemaError THERE, `apply()` throws, and the plugin never activates —
    // no tools, no web routes, and the detail-page card shows HTTP 404 on its
    // stats fetch (the 2026-10 incident: the dev tree gained null-carrying unions,
    // and against host 0.2.0-rc.1 the whole plugin failed to mount while the
    // published 0.4.2 on desktop still loaded fine). `hostSubsetSchema` in
    // src/host/tools.ts is the translation to that subset; this walk pins the
    // invariant on the very ARTIFACTS the host loads, so removing the sanitizer
    // (or re-introducing a union) turns this suite red again.
    const assertHostSubset = (node, where) => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) assertHostSubset(item, where);
        return;
      }
      assert.ok(
        !Array.isArray(node.type),
        `${where}: array-typed \`type\` (${JSON.stringify(node.type)}) is not host-acceptable`,
      );
      for (const [key, value] of Object.entries(node)) assertHostSubset(value, `${where}.${key}`);
    };

    for (const def of calls.tools) {
      assertHostSubset(def.parameters, `${def.name}.parameters`);
      assertHostSubset(def.output.schema, `${def.name}.output.schema`);
    }

    // Null must stay a LEGITIMATE value on the null-carrying fields: the host
    // validates the returned value against output.schema at call time, so these
    // nodes are annotation-only (no `type` key). Folding one back to a single
    // type would make every legitimate null throw a ToolOutputError.
    const ask = calls.tools.find((t) => t.name === 'atomcode_ask');
    const askFields = [
      ask.output.schema.properties.tools.items.properties.success,
      ask.output.schema.properties.working_dir,
      ask.output.schema.properties.daemon_tool_calls,
      ask.output.schema.properties.daemon_rounds,
    ];
    const review = calls.tools.find((t) => t.name === 'atomcode_review');
    const reviewFields = ['severity', 'file', 'line'].map((key) => review.output.schema.properties.findings.items.properties[key]);
    for (const node of [...askFields, ...reviewFields]) {
      assert.ok(!('type' in node), 'null-carrying field must stay annotation-only (no single-type fold)');
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
      // The reason CARRIES the self-contained fix (it ships to every
      // workspace in the tool description, where this repo's docs/ do not):
      // it must name the local sidecar, where it comes from, and where the
      // login token lives — not just "a local server".
      assert.match(prov.reason, /atomcode-open-api/);
      assert.match(prov.reason, /github\.com\/baimocn\/atomcode-open-api/);
      assert.match(prov.reason, /auth\.toml/);
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

describe('src/host/sessions.ts — key prefixing', () => {
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
    // The directory is named so the run reaches the startup poll this case is
    // about: an unnamed one is refused up front (see the suite note in
    // "two namespaces" below), which never reaches `ensureDaemon` at all.
    const result = await ask.execute({ message: 'hi', working_dir: 'C:\\cancel-probe' }, { signal: ctrl.signal });
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

describe('src/host/review.ts — checkReviewProvision', () => {
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
    assert.match(r.reason, /atomcode-open-api/, 'the gateway-only reason must carry the local fix text');
    assert.match(r.reason, /github\.com\/baimocn\/atomcode-open-api/);
    const { rmSync } = await import('node:fs');
    rmSync(f, { recursive: true, force: true });
  });

  it('returns available=false with the two-option fix text when config.toml has no providers at all', async () => {
    const f = mkdtempSync(join(tmpdir(), 'atomcode-none-'));
    writeFileSync(join(f, 'config.toml'), '# no providers, no default_provider\n', 'utf8');
    const { checkReviewProvision } = await import(fileUrl(REVIEW));
    const r = checkReviewProvision(f);
    assert.equal(r.available, false);
    assert.match(r.reason, /no direct \[providers\.<name>\] entry/);
    assert.match(r.reason, /atomcode-open-api/, 'the "nothing configured" reason must also carry the fix text');
    assert.match(r.reason, /127\.0\.0\.1:8899/);
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
   * @param {{ withRuntimeInfo?: boolean }} [opts] `withRuntimeInfo: false`
   *   omits the runtime_info event — the protocol-drift shape where `provider`
   *   degrades from a measured value to an echo of the request.
   * @returns {Promise<{port:number, chats:Array<object>, port_server:import('node:http').Server}>}
   */
  async function startChatProbe(opts = {}) {
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
        const events = [];
        if (opts.withRuntimeInfo !== false) {
          // Echo the provider the client asked for, the way the real daemon's
          // runtime_info does — so `result.provider` is checked against intent.
          events.push({ type: 'runtime_info', provider: body.provider || 'AtomGit-qwen3.8-27b', model: 'probe-model' });
        }
        events.push(
          { type: 'text', content: 'OK' },
          { type: 'done', tokens: 12, tool_calls: 0, session_id: 'sid-probe', stop_reason: 'stopped' },
        );
        res.end(sse(events));
      });
    });
    openServers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, chats };
  }

  /** Mount the plugin against the probe daemon and hand back the ask tool. */
  async function mountAsk(extraConfig, picks, probeOpts) {
    const probe = await startChatProbe(probeOpts);
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-dp-'));
    stateDirs.push(dir);
    // The panel writes provider.json through the route; a test pre-seeds the same
    // file through the same module, so the precedence ladder is exercised against
    // the real on-disk shape rather than a mock of it.
    if (picks && Object.keys(picks).length > 0) {
      const { createProviderStore } = await import(fileUrl(PROVIDER_STORE));
      const store = createProviderStore(join(dir, 'provider.json'));
      for (const [slot, name] of Object.entries(picks)) store.set(slot, name);
    }
    const { ctx, calls } = fakeCtx();
    const mod = await import(fileUrl(BRIDGE));
    // A working_dir is supplied by DEFAULT here because this suite is about the
    // provider ladder on the wire, not about directory resolution: with no
    // resolvable directory, `atomcode_ask` REFUSES the turn before touching the
    // daemon (the gate is mode-independent — 2026-10-17 probe; bypass is just
    // the shipped default), so every case below would otherwise fail on the
    // same refusal and test nothing.
    // `extraConfig` still wins, so a case that wants to exercise the ladder's
    // directory rung can override it.
    mod.apply(ctx, {
      state_path: join(dir, 'sessions.json'),
      auto_start: false,
      port: probe.port,
      working_dir: join(dir, 'probe-repo'),
      ...extraConfig,
    });
    const ask = calls.tools.find((t) => t.name === 'atomcode_ask');
    return { ask, chats: probe.chats, calls, dir };
  }

  it('flags an echoed provider when the daemon omits runtime_info', async () => {
    // `provider=` is documented as the daemon's MEASURED value ("not an echo
    // of what we asked for"). When a protocol drift drops runtime_info, the
    // value silently degrades to an echo — the turn must say so per-turn
    // instead of masquerading as the model that ran.
    const { ask } = await mountAsk({}, undefined, { withRuntimeInfo: false });
    const r = await ask.execute({ message: 'hi', provider: 'AtomGit-glm5.3-flash' }, {});
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'AtomGit-glm5.3-flash', 'echoed when the daemon reports nothing');
    assert.equal(r.providerReported, false, 'the echo must be flagged');
    const text = ask.output.render({}, r).map((p) => p.text).join('\n');
    assert.match(text, /未经远端证实/, 'the render must carry the caveat');
  });

  it('reports providerReported: true for a normal turn', async () => {
    const { ask } = await mountAsk({}, undefined, { withRuntimeInfo: true });
    const r = await ask.execute({ message: 'hi', provider: 'AtomGit-glm5.3-flash' }, {});
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'AtomGit-glm5.3-flash');
    assert.equal(r.providerReported, true, 'runtime_info arrived — this is a measured value');
    const text = ask.output.render({}, r).map((p) => p.text).join('\n');
    assert.doesNotMatch(text, /未经远端证实/, 'no caveat when the daemon reported the provider');
  });

  it('both parameter comments state ONE precedence — and it is the real one', () => {
    // Comments have no tests, which is exactly why three stale ones shipped in a
    // single round: `default_provider` carried TWO contradictory `Precedence:`
    // paragraphs (an older one without the panel, left behind when the panel was
    // added), `review_working_dir` described a fallback the code deliberately
    // REFUSES, and the docs quoted a function count that had doubled.
    //
    // `cordis.patch.yml` is this repo's field documentation of record, so a
    // contradiction here is worse than a wrong comment elsewhere: it is the file
    // the README points at as the source of truth.
    const yaml = readFileSync(join(__dirname, '..', 'cordis.patch.yml'), 'utf8');
    const lines = yaml.split('\n');
    // Map each comment block to the config key it precedes.
    const owners = new Map();
    let pending = [];
    for (const line of lines) {
      if (/^\s{8}#/.test(line) || /^\s{8}$/.test(line)) {
        pending.push(line);
        continue;
      }
      const field = line.match(/^\s{8}([a-z_]+):/);
      if (field) {
        owners.set(field[1], pending.join('\n'));
        pending = [];
      }
    }

    for (const key of ['default_provider', 'review_default_provider']) {
      const block = owners.get(key);
      assert.ok(block, `${key} must have a comment block`);
      const precedence = block.match(/Precedence:/g) || [];
      assert.equal(
        precedence.length,
        1,
        `${key} must state its precedence EXACTLY once; found ${precedence.length} — a second, staler ` +
          'paragraph is how the panel got dropped from this field\'s documented order',
      );
      assert.match(block, /panel|detail page/i, `${key}'s documented precedence must include the panel pick`);
    }

    // review_working_dir: empty REFUSES; it does not fall back to the host cwd.
    const rwd = owners.get('review_working_dir');
    assert.ok(rwd, 'review_working_dir must have a comment block');
    assert.ok(
      /does NOT fall back|REFUSE/i.test(rwd),
      'review_working_dir must document the refusal — the code rejects a call with no repository rather than ' +
        'reviewing the host process cwd (see the "REFUSES rather than falling back" test above)',
    );
    assert.ok(
      !/Empty = the\s*\n?\s*#?\s*HOST PROCESS/i.test(rwd),
      'the old wording claimed an empty value uses the host cwd, which is the behaviour the code refuses',
    );

    // ask_max_rounds: the client labels default-vs-authored from config.defaults, so
    // the number in the shipped patch must be the number the host falls back to.
    assert.match(owners.get('ask_max_rounds') || '', /defaults/, 'ask_max_rounds must note that the panel reads its default from the snapshot');
  });

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

  it('a panel pick outranks the configured default_provider', async () => {
    // The whole point of the dropdown: a click must beat a line in a config file,
    // or the control is decoration.
    const { ask, chats } = await mountAsk({ default_provider: 'AtomGit-qwen3.8-27b' }, { ask: 'AtomGit-glm5.3-flash' });
    const r = await ask.execute({ message: 'hi' }, {});
    assert.equal(r.ok, true, r.error);
    assert.equal(chats[0].provider, 'AtomGit-glm5.3-flash', 'the panel pick wins over the patch field');
    assert.equal(r.provider, 'AtomGit-glm5.3-flash');
  });

  it('a per-call provider argument still outranks the panel pick', async () => {
    const { ask, chats } = await mountAsk({ default_provider: 'AtomGit-qwen3.8-27b' }, { ask: 'AtomGit-glm5.3-flash' });
    await ask.execute({ message: 'hi', provider: 'AtomGit-qwen3.8-27b' }, {});
    assert.equal(chats[0].provider, 'AtomGit-qwen3.8-27b', 'one turn may still name its own model');
  });

  it('clearing the panel pick is read on the NEXT call (no restart needed)', async () => {
    // The state file is read per call, so BOTH directions of a user's choice take
    // effect immediately. This asserts the fallback after a clear — the half that
    // would break if the pick were cached at mount.
    const { ask, chats, dir } = await mountAsk({ default_provider: 'AtomGit-qwen3.8-27b' }, { ask: 'AtomGit-glm5.3-flash' });
    const { createProviderStore } = await import(fileUrl(PROVIDER_STORE));
    createProviderStore(join(dir, 'provider.json')).set('ask', null);
    await ask.execute({ message: 'hi' }, {});
    assert.equal(chats[0].provider, 'AtomGit-qwen3.8-27b', 'a cleared file falls back to the config field');
  });

  it('a panel pick for one slot never lands on the other path', async () => {
    // 红线 8 with the new layer in play: pin BOTH slots and the ask wire must still
    // carry ONLY the model profile.
    const { ask, chats } = await mountAsk(
      { default_provider: 'AtomGit-qwen3.8-27b', review_default_provider: 'atomcode-local' },
      { ask: 'AtomGit-glm5.3-flash', review: 'atomcode-local' }
    );
    await ask.execute({ message: 'hi' }, {});
    assert.equal(chats[0].provider, 'AtomGit-glm5.3-flash');
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
      assert.match(ask.description, /详情页面板上选的档位/, 'and the panel slot above it');
      assert.match(ask.parameters.properties.provider.description, /GET \/models/);
      assert.match(ask.parameters.properties.provider.description, /不要传裸模型 id/);
      assert.match(ask.parameters.properties.provider.description, /面板上选的档位/);

      const review = calls.tools.find((t) => t.name === 'atomcode_review');
      assert.match(review.description, /直连 provider：direct/, 'the review note names the real entry');
      // A tool description is registered ONCE at mount, while the panel pick is read
      // PER CALL — so the note may state the ORDER of resolution and must never
      // state the OUTCOME. Both sentences below are the outcome-claims that this
      // test has already had to kill twice (a pinned "留空即点名它", an unpinned
      // "留空时自动选择"): each is false as soon as someone touches the dropdown.
      assert.match(review.description, /按顺序取：详情页面板选的条目/, 'the ladder must lead with the panel pick');
      assert.match(review.description, /只有前面几档都没配上.*才会要求你点名/, 'the refusal must stay conditional');
      assert.doesNotMatch(review.description, /留空即点名它/, 'no unconditional "empty means this one" claim');
      assert.doesNotMatch(review.description, /provider 留空时自动选择——/, 'no unconditional auto-select claim');
      // What IS safe to echo: the mount-time config value, which cannot change under
      // the registered description.
      assert.match(review.description, /当前="direct"/, 'the config field echo is a mount-time fact');
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
      assert.match(
        review.parameters.properties.provider.description,
        /面板上选的条目/,
        'and the panel slot above it',
      );
      assert.doesNotMatch(
        review.description,
        /AtomGit-glm5\.3-flash/,
        'the ask-side profile must not leak into the review namespace',
      );

      // Unpinned: the config echo flips to 未配, and the ladder is unchanged — the
      // point of the conditional phrasing is that ONE sentence stays true either way.
      const unpinned = fakeCtx();
      mod.apply(unpinned.ctx, { state_path: join(mkdtempSync(join(tmpdir(), 'atomcode-dp-desc3-')), 's.json'), auto_start: false });
      const review2 = unpinned.calls.tools.find((t) => t.name === 'atomcode_review');
      assert.match(review2.description, /当前未配/, 'the echo must follow the real config');
      assert.doesNotMatch(review2.description, /当前="direct"/);
      assert.match(review2.description, /按顺序取：详情页面板选的条目/);
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

  it('review: the selected provider actually lands in the CLI argv', async () => {
    // The positive form of the precedence claim. The loopback test above proves
    // WHICH entry selection picked (via the probe's named diagnostic); this one
    // proves the picked name is what the CLI is handed — via review.js's documented
    // `setSpawnOverride` seam, so nothing real is ever spawned.
    //
    // Why both tests exist: the original version of this suite asserted precedence
    // through a missing binary, where `first` and `second` produce an identical
    // ENOENT. That assertion could not fail, which is exactly how a precedence
    // regression would ship green.
    const { setSpawnOverride } = await import(fileUrl(REVIEW));
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-argv-'));
    mkdirSync(join(fakeHome, '.atomcode'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.atomcode', 'config.toml'),
      [
        'default_provider = "account-gw"',
        '[providers.first]',
        'provider = "openai"',
        'base_url = "https://first.test/v1"',
        'api_key = "sk-1"',
        '[providers.second]',
        'provider = "openai"',
        'base_url = "https://second.test/v1"',
        'api_key = "sk-2"',
      ].join('\n'),
      'utf8',
    );
    const repo = mkdtempSync(join(tmpdir(), 'atomcode-argv-repo-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    /** @type {string[][]} */
    const spawned = [];
    const providerOf = (argv) => {
      const i = argv.indexOf('--provider');
      return i >= 0 ? argv[i + 1] : undefined;
    };
    setSpawnOverride((_bin, args) => {
      spawned.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', '{"findings":[]}');
        child.emit('exit', 0);
      });
      return child;
    });
    const mount = async (extra, picks) => {
      const dir = mkdtempSync(join(tmpdir(), 'atomcode-argv-s-'));
      stateDirs.push(dir);
      if (picks && Object.keys(picks).length > 0) {
        const { createProviderStore } = await import(fileUrl(PROVIDER_STORE));
        const store = createProviderStore(join(dir, 'provider.json'));
        for (const [slot, name] of Object.entries(picks)) store.set(slot, name);
      }
      const { ctx, calls } = fakeCtx();
      const bridge = await import(fileUrl(BRIDGE));
      bridge.apply(ctx, { state_path: join(dir, 'sessions.json'), auto_start: false, ...extra });
      return calls.tools.find((t) => t.name === 'atomcode_review');
    };
    try {
      const pinned = await mount({ review_default_provider: 'second' });
      const r1 = await pinned.execute({ working_dir: repo, task: 'noop' }, {});
      assert.equal(r1.ok, true, `the fake CLI must have "run": ${r1.error}`);
      assert.equal(providerOf(spawned[0]), 'second', 'the configured default reaches --provider');

      const argued = await mount({ review_default_provider: 'second' });
      const r2 = await argued.execute({ working_dir: repo, task: 'noop', provider: 'first' }, {});
      assert.equal(r2.ok, true, r2.error);
      assert.equal(providerOf(spawned[1]), 'first', 'the per-call argument must outrank the configured default');

      const before = spawned.length;
      const ambiguous = await mount({});
      const r3 = await ambiguous.execute({ working_dir: repo, task: 'noop' }, {});
      assert.equal(r3.ok, false);
      assert.match(r3.error, /several direct providers/);
      assert.equal(spawned.length, before, 'a refused selection must never reach the spawner');

      // The panel layer, in the same observable form. A pick resolves the ambiguity
      // with NO config edit (this is what the dropdown is for), and it outranks the
      // patch field when both are set. Indexed off `spawned.length` because a
      // refused selection never reaches the spawner at all.
      const iPanel = spawned.length;
      const byPanel = await mount({}, { review: 'first' });
      const r4 = await byPanel.execute({ working_dir: repo, task: 'noop' }, {});
      assert.equal(r4.ok, true, `a panel pick must resolve the ambiguity: ${r4.error}`);
      assert.equal(providerOf(spawned[iPanel]), 'first', 'the panel pick reaches --provider');

      const iVsConfig = spawned.length;
      const panelVsConfig = await mount({ review_default_provider: 'first' }, { review: 'second' });
      const r5 = await panelVsConfig.execute({ working_dir: repo, task: 'noop' }, {});
      assert.equal(r5.ok, true, r5.error);
      assert.equal(providerOf(spawned[iVsConfig]), 'second', 'the panel pick must outrank review_default_provider');
    } finally {
      setSpawnOverride(null);
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
      else delete process.env.USERPROFILE;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('version truth — the manifest and the reported version cannot disagree', () => {
  // `AGENTS.md` used to call `lib/index.js`'s stats body a "truth source" for the
  // version. It is not: it is a BUILD ARTIFACT of `src/host/index.ts`. What the
  // rule actually needs is that the two HAND-EDITED places agree:
  //
  //   package.json       — what pnpm / a GitHub-direct install pins
  //   src/host/index.ts  — what the plugin REPORTS on its stats route, and what
  //                        the panel therefore shows next to the daemon version
  //
  // Nothing else could notice a half-bumped version: `build-gate.test.mjs`
  // compares `lib/` against `src/` and never looks at the manifest, so a release
  // could ship as 0.4.1 while every panel says 0.4.0. The manifest version also
  // names the release tag (`git tag v<version>`) and the npm publish, so a
  // mismatch here would mislabel both.
  //
  // The third place — release numbers written into PROSE (`// the 0.4.3 split`) —
  // is not tracked but BANNED, asserted by the last test in this block. The
  // release runbook used to list those labels as a thing to hand-check; a list
  // that only a human counts is a list that drifts.
  //
  // Reading `src/` as TEXT (never importing it) is deliberate and safe here. The
  // "tests hit artifacts, not sources" rule exists for module identity — see the
  // `setSpawnOverride` note at the top of this file — and a text read shares no
  // module state.
  it('package.json version === the version in the src/host stats body', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const src = readFileSync(join(__dirname, '..', 'src', 'host', 'index.ts'), 'utf8');
    const m = src.match(/^\s*version:\s*'([^']+)',\s*$/m);
    assert.ok(m, 'src/host/index.ts must declare a version literal in its stats body');
    assert.equal(m[1], pkg.version, `package.json says ${pkg.version}, the plugin reports ${m[1]}`);
  });

  it('the committed artifact agrees too — the chain manifest → src → lib is whole', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const built = readFileSync(BRIDGE, 'utf8');
    assert.ok(
      built.includes(`version: "${pkg.version}"`),
      `lib/index.js must be built from a source reporting ${pkg.version}`,
    );
  });

  // The THIRD version place, and the reason this test exists at all.
  //
  // Comments have always said things like "the split of the God module" with the
  // release number glued on, and the release runbook had to admit it could not
  // pin them: the labels are prose, so nothing could tell "8 of them" from "9 of
  // them" — and by the time anyone counted, the docs were already one release
  // behind. A metric nobody can check is not a discipline; it is a claim.
  //
  // So the rule is now a BAN rather than a count: name the EVENT ("the apply()
  // split", "the abort path", "the earlier gate"), never the release, in any
  // source or test comment. The release number belongs in exactly two hand-edited
  // places (asserted above) plus CHANGELOG.md, which is generated from git log.
  //
  // This is what makes the ban enforceable rather than aspirational: a `vX.Y.Z`
  // token anywhere in `src/`, `test/` or `tsdown.config.mjs` fails here, so the
  // next "it's just a comment" version tag cannot land.
  it('no src/ or test/ file carries a vX.Y.Z release label in prose', () => {
    const ROOT = join(__dirname, '..');
    const roots = [join(ROOT, 'src'), join(ROOT, 'test')];
    const files = [join(ROOT, 'tsdown.config.mjs')];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) files.push(p);
      }
    };
    for (const r of roots) walk(r);

    const offenders = [];
    for (const p of files) {
      readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/v\d+\.\d+\.\d+/.test(line)) {
            offenders.push(`${p.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'release numbers must not appear in src/ or test/ prose — name the event instead ("the apply() split", "the abort path", "the earlier gate"). The version lives in package.json + the src/host stats body (asserted above); the history lives in CHANGELOG.md. Offenders:\n' +
        offenders.join('\n'),
    );
  });
});

/**
 * detectProfileKey — the key-space prefix that keeps two profiles on disjoint keys.
 *
 * It had ZERO coverage until now, and two behaviours a test would have caught:
 * an explicit `DSH_PROFILE` was run through a three-word allowlist (so a
 * legitimate value outside it was DISCARDED and the answer fell through to a
 * guess), and the argv heuristic was a regex over `process.argv.join(' ')` that
 * matched across argument boundaries and inside unrelated paths.
 *
 * The consequence of getting this wrong is not cosmetic: with no prefix, both
 * profiles write the same `default::` key in the shared sessions.json, and a
 * `continue: true` in one resumes the other's side conversation.
 */
describe('detectProfileKey — the prefix that keeps two profiles apart', () => {
  const savedProfile = process.env.DSH_PROFILE;
  after(() => {
    if (savedProfile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = savedProfile;
  });

  it('an explicit DSH_PROFILE is the authority, whatever it says', async () => {
    // The allowlist is what was wrong: 'my-own-profile' is a legitimate value
    // and used to be thrown away in favour of a guess.
    const { detectProfileKey } = await import(fileUrl(CONFIG));
    for (const value of ['web', 'desktop', 'headless', 'my-own-profile']) {
      process.env.DSH_PROFILE = value;
      assert.equal(detectProfileKey(['node', 'dsh', 'web']), value, `${value} must win over argv`);
    }
  });

  it('falls back to the argv subcommand, as its own token', async () => {
    const { detectProfileKey } = await import(fileUrl(CONFIG));
    delete process.env.DSH_PROFILE;
    assert.equal(detectProfileKey(['node', 'dsh', 'desktop']), 'desktop');
    assert.equal(detectProfileKey(['node', '/usr/local/bin/dsh', 'web']), 'web');
    assert.equal(detectProfileKey(['node', 'dsh.exe', 'desktop']), 'desktop');
  });

  it('does NOT invent a profile out of unrelated arguments', async () => {
    const { detectProfileKey } = await import(fileUrl(CONFIG));
    delete process.env.DSH_PROFILE;
    // The old `/dsh.*\bweb\b/i` over the JOINED line read this as 'web'.
    assert.equal(detectProfileKey(['node', '/opt/dsh-tools/webpack.config.js']), '');
    // A path argument that merely ends in the profile word is not a subcommand.
    assert.equal(detectProfileKey(['node', 'dsh', '--cwd', '/srv/web']), '');
    // A profile word with no dsh invocation at all is not enough either.
    assert.equal(detectProfileKey(['node', 'some-other-cli', 'web']), '');
  });

  it('an undetermined profile is NAMED at mount, not left to be discovered later', async () => {
    const { detectProfileKey } = await import(fileUrl(CONFIG));
    delete process.env.DSH_PROFILE;
    // Premise of this test: this process genuinely looks underdetermined. If the
    // runner ever starts passing a profile, this line says so instead of letting
    // the assertion below fail for a reason nobody can see.
    assert.equal(detectProfileKey(), '', 'this process must look profile-less for the mount assertion to mean anything');

    const warnings = [];
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-profile-')), 'sessions.json');
    const { ctx } = fakeCtx();
    ctx.logger = { warn: (m) => warnings.push(String(m)), error() {}, info() {} };
    (await import(fileUrl(BRIDGE))).apply(ctx, { state_path: statePath, auto_start: false });
    assert.ok(
      warnings.some((w) => w.includes('session_key_prefix') && w.includes('profile')),
      'an unprefixed key space must be named at mount (红线 3)',
    );
  });

  it('a configured session_key_prefix silences it', async () => {
    const mod = await import(fileUrl(BRIDGE));
    delete process.env.DSH_PROFILE;
    const warnings = [];
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-profile-')), 'sessions.json');
    const { ctx } = fakeCtx();
    ctx.logger = { warn: (m) => warnings.push(String(m)), error() {}, info() {} };
    mod.apply(ctx, { state_path: statePath, auto_start: false, session_key_prefix: 'web' });
    assert.ok(
      !warnings.some((w) => w.includes('session_key_prefix')),
      'a user who named the prefix must not be warned about it',
    );
  });
});
