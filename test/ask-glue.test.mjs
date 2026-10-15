/**
 * ask-glue.test.mjs — the `atomcode_ask` session-continuity glue.
 *
 * The glue (`continue` → sessions.get → askChat → sessions.set) is the plugin's
 * headline feature and previously had NO direct test: `askChat` was covered by
 * daemon-stream.test.mjs, but "which session gets resumed, when is it
 * written back, and what happens when the turn fails" was not.
 *
 * Hermetic: a local node:http server speaks the daemon vocabulary on an
 * ephemeral port, and the plugin is mounted with `auto_start: false`, so no
 * real daemon, no network, and no spawned process.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, before, after, beforeEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'lib', 'index.js');

// Module scope: `await` is not allowed inside a synchronous describe callback.
const mod = await import(pathToFileURL(BRIDGE).href);

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** A fake AtomCode daemon: /health + /chat, recording every request body. */
function startFakeDaemon(state) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if ((req.url || '').startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'atomcode-daemon' }));
        return;
      }
      if ((req.url || '').startsWith('/chat')) {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch { /* ignore */ }
        state.requests.push(payload);
        // Echo a supplied session id (continuation), else assign a fresh one.
        const sessionId = payload.session_id || `sess-${++state.counter}`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (state.mode === 'error') {
          res.end(sse([
            { type: 'runtime_info', provider: 'Fake-Provider' },
            { type: 'session_assigned', session_id: sessionId },
            { type: 'error', message: 'synthetic failure' },
          ]));
          return;
        }
        // `state.toolStarts` drives the round fuse: the plugin counts `tool_start`
        // events and closes the stream past its budget, so a turn emitting more
        // than the budget must come back FUSED rather than merely described.
        const events = [
          { type: 'runtime_info', provider: 'Fake-Provider' },
          { type: 'session_assigned', session_id: sessionId },
        ];
        for (let i = 0; i < (state.toolStarts || 0); i += 1) {
          events.push({ type: 'tool_start', name: `synthetic-tool-${i}` });
        }
        events.push({ type: 'text', content: 'ok' });
        events.push({
          type: 'done',
          session_id: sessionId,
          tokens: 5,
          tool_calls: state.toolStarts || 0,
          stop_reason: 'stopped',
        });
        res.end(sse(events));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Mount the plugin against a fake daemon and return its atomcode_ask tool. */
async function mountAsk(mod, { statePath, port, keyPrefix, config = {} }) {
  const tools = [];
  const ctx = {
    get: (name) => (name === 'tools' ? { register: (def) => { tools.push(def); return () => {}; } } : undefined),
    logger: { warn() {}, error() {}, info() {} },
    fiber: { entry: { options: { id: 'dsh-atomcode-bridge' } } },
    inject() {},
    effect() {},
    on() {},
  };
  mod.apply(ctx, {
    auto_start: false, // the fake daemon is already listening
    port,
    state_path: statePath,
    ...(keyPrefix !== undefined ? { session_key_prefix: keyPrefix } : {}),
    ...config,
  });
  const ask = tools.find((t) => t.name === 'atomcode_ask');
  assert.ok(ask, 'atomcode_ask must be registered');
  return ask;
}

const readState = (p) => JSON.parse(readFileSync(p, 'utf8'));
const tempState = () => join(mkdtempSync(join(tmpdir(), 'atomcode-glue-')), 'sessions.json');
const WORKDIR = 'C:\\repo';

describe('atomcode_ask — session continuity glue', () => {
  const state = { requests: [], counter: 0, mode: 'ok' };
  let fake;
  let savedProfile;

  before(async () => {
    // These tests are about the session KEY logic, not profile detection, and
    // the ambient harness env DOES set DSH_PROFILE (e.g. "desktop") — which
    // would prefix every key. Neutralize it so the keys stay readable here;
    // profile detection has its own suite below.
    savedProfile = process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE;
    fake = await startFakeDaemon(state);
  });
  after(() => {
    fake.server.close();
    if (savedProfile !== undefined) process.env.DSH_PROFILE = savedProfile;
  });
  beforeEach(() => { state.requests.length = 0; state.mode = 'ok'; state.toolStarts = 0; });

  it('a fresh turn records the session the daemon assigned', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    assert.equal(r.ok, true);
    assert.equal(r.continued, false, 'a fresh turn is not a continuation');
    assert.match(r.session_id, /^sess-\d+$/);
    // The point of the glue: the id is persisted under the working_dir key so
    // the model never has to carry it. Asserted against the wire value rather
    // than a hardcoded id, so the test does not depend on daemon call order.
    assert.equal(
      readState(statePath)[WORKDIR].sessionId,
      r.session_id,
      'the assigned id must be persisted under the working_dir key',
    );
  });

  it('continue:true replays the recorded session id to the daemon', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: WORKDIR }, {});
    const recorded = readState(statePath)[WORKDIR].sessionId;
    const second = await ask.execute({ message: 'second', continue: true, working_dir: WORKDIR }, {});
    assert.equal(second.continued, true);
    assert.equal(
      state.requests.at(-1).session_id,
      recorded,
      'the recorded session must be replayed as session_id',
    );
  });

  it('omitting continue starts a new line (no session_id on the wire)', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: WORKDIR }, {});
    const fresh = await ask.execute({ message: 'unrelated', working_dir: WORKDIR }, {});
    assert.equal(fresh.continued, false);
    assert.equal(state.requests.at(-1).session_id, undefined, 'no continuation key must be sent');
    assert.notEqual(fresh.session_id, 'sess-1', 'a new line gets a new session');
  });

  it('an explicit session_id outranks continue', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: WORKDIR }, {});
    const r = await ask.execute(
      { message: 'pinned', session_id: 'explicit-42', continue: true, working_dir: WORKDIR },
      {},
    );
    assert.equal(r.continued, true);
    assert.equal(state.requests.at(-1).session_id, 'explicit-42');
  });

  it('a FAILED turn does not clobber the recorded session', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: WORKDIR }, {});
    const recorded = readState(statePath)[WORKDIR].sessionId;
    assert.ok(recorded, 'the successful turn must have recorded a session');

    state.mode = 'error';
    // Deliberately a FRESH turn (not `continue`): the daemon then assigns a NEW
    // session id. That matters — with `continue` the daemon echoes the recorded
    // id back, and overwriting it with itself would be invisible, which is
    // exactly how an earlier version of this test failed to catch the removal
    // of the `result.ok` guard.
    const failed = await ask.execute({ message: 'boom', working_dir: WORKDIR }, {});
    assert.equal(failed.ok, false);
    assert.match(failed.error, /synthetic failure/);
    // Guard the guard: if the failed turn ever carried the recorded id, the
    // assertion below would silently stop detecting that regression.
    assert.notEqual(
      failed.session_id,
      recorded,
      'premise: the failed turn must carry a different session id than the recorded one',
    );
    // The daemon still announced a session; persisting it on a failed turn would
    // silently re-point the line at a turn that never completed.
    assert.equal(
      readState(statePath)[WORKDIR].sessionId,
      recorded,
      'a failed turn must leave the previously recorded session intact',
    );
  });

  it('a different working_dir is a different session key', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'repo a', working_dir: WORKDIR }, {});
    const firstId = readState(statePath)[WORKDIR].sessionId;
    await ask.execute({ message: 'repo b', working_dir: 'C:\\other' }, {});
    const saved = readState(statePath);
    assert.ok(saved['C:\\other'], 'the second working_dir must get its own key');
    assert.equal(saved[WORKDIR].sessionId, firstId, 'the first key is untouched');
    assert.notEqual(saved['C:\\other'].sessionId, firstId);
  });

  it('trailing slashes on working_dir fold onto the same key', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: 'C:\\repo' }, {});
    const r = await ask.execute({ message: 'again', continue: true, working_dir: 'C:\\repo\\\\' }, {});
    assert.equal(r.continued, true, 'trailing separators must not fork the session key');
  });

  it('reset_session clears a stale mapping AND stops this turn from resuming it', async () => {
    // The escape hatch for a daemon-side session that expired: v0.3 had a
    // `drop()` on the store with no caller at all, so a stale id could only be
    // cleared by hand-editing sessions.json.
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: WORKDIR }, {});
    const stale = readState(statePath)[WORKDIR].sessionId;
    assert.ok(stale);

    const r = await ask.execute({ message: 'start over', continue: true, reset_session: true, working_dir: WORKDIR }, {});
    assert.equal(r.continued, false, 'a reset must not report a continuation');
    assert.equal(
      state.requests.at(-1).session_id,
      undefined,
      'the stale session id must NOT be replayed to the daemon',
    );
    // …and the new turn's own session takes its place.
    const saved = readState(statePath)[WORKDIR];
    assert.equal(saved.sessionId, r.session_id);
    assert.notEqual(saved.sessionId, stale);
  });

  it('reset_session with an explicit session_id pins that id and drops the stale one', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: WORKDIR }, {});
    const r = await ask.execute(
      { message: 'pinned', session_id: 'fresh-9', reset_session: true, working_dir: WORKDIR },
      {},
    );
    assert.equal(r.continued, true);
    assert.equal(state.requests.at(-1).session_id, 'fresh-9');
    assert.equal(readState(statePath)[WORKDIR].sessionId, 'fresh-9');
  });

  it('reset_session on a key that was never recorded is a no-op, not an error', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', reset_session: true, working_dir: 'C:\\never-used' }, {});
    assert.equal(r.ok, true);
    assert.equal(r.continued, false);
  });
});

describe('atomcode_ask — bounded default and reply truncation', () => {
  const state = { requests: [], counter: 200, mode: 'ok' };
  let fake;

  before(async () => { fake = await startFakeDaemon(state); });
  after(() => fake.server.close());

  it('a long reply is marked truncated instead of silently clipped', async () => {
    // v0.3 did `reply.slice(0, 200_000)` with no marker: the model read a
    // half-finished report as a complete answer. The mark + flag make the loss
    // explicit.
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if ((req.url || '').startsWith('/health')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ service: 'atomcode-daemon' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse([
          { type: 'text', content: 'x'.repeat(200_100) },
          { type: 'done', session_id: 'sess-long', tokens: 1, stop_reason: 'stopped' },
        ]));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const statePath = tempState();
    try {
      const ask = await mountAsk(mod, { statePath, port });
      const r = await ask.execute({ message: 'say a lot', working_dir: WORKDIR }, {});
      assert.equal(r.ok, true);
      assert.equal(r.truncated, true, 'truncation must be reported, not silent');
      assert.match(r.reply, /truncated by dsh-atomcode-bridge/, 'the clip point must be marked inline');
      assert.match(r.reply, /100 more characters/, 'the lost length must be stated');
    } finally {
      server.close();
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });

  it('a short reply is not marked truncated', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    assert.equal(r.truncated, false);
    assert.doesNotMatch(r.reply, /truncated/);
  });

  // The round budget is a FUSE, and these assert its BEHAVIOUR against a daemon
  // that emits more tool_start events than any sane budget — not the wording of
  // the description. The two suites above this one used port 45995 (nothing
  // listening) and therefore "passed" for the wrong reason: a closed port fails
  // the turn whether the fuse is bounded or not, so neither one could tell a
  // fused turn from an unreachable daemon.
  const TOOL_STORM = 40;

  it('the default round budget is BOUNDED, and a turn past it is fused', async () => {
    state.toolStarts = TOOL_STORM;
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    assert.doesNotMatch(
      ask.parameters.properties.max_rounds.description,
      /默认不限/,
      'the default must not advertise "unlimited"',
    );
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    assert.equal(r.ok, false, 'the shipped default must fuse a 40-tool turn');
    assert.match(r.error, /exceeded 25 tool rounds/, 'the error must name the budget it tripped');
  });

  it('a configured ask_max_rounds: 3 trips the fuse at 3', async () => {
    state.toolStarts = TOOL_STORM;
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, config: { ask_max_rounds: 3 } });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    assert.equal(r.ok, false);
    assert.match(r.error, /exceeded 3 tool rounds/);
  });

  it('an explicit ask_max_rounds: 0 disables the fuse (unlimited)', async () => {
    // cordis.patch.yml: "Set 0 to hand the budget back to the daemon's own loop";
    // README: "0 = 不限". The old `> 0` gate turned an explicit 0 into 25, so the
    // knob was documented in three places and honoured in none.
    state.toolStarts = TOOL_STORM;
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, config: { ask_max_rounds: 0 } });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    assert.equal(r.ok, true, '0 means "no fuse", so a 40-tool turn must complete');
    assert.equal(r.round_count, TOOL_STORM);
  });

  it('a per-call max_rounds: 0 disables the fuse even over a bounded config', async () => {
    state.toolStarts = TOOL_STORM;
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, config: { ask_max_rounds: 3 } });
    const r = await ask.execute({ message: 'hi', max_rounds: 0, working_dir: WORKDIR }, {});
    assert.equal(r.ok, true, 'a per-call 0 must override a bounded config budget');
  });
});

describe('session_key_prefix — profile detection', () => {
  const state = { requests: [], counter: 100, mode: 'ok' };
  let fake;

  before(async () => { fake = await startFakeDaemon(state); });
  after(() => fake.server.close());

  it('auto-detects the profile from DSH_PROFILE', async () => {
    const statePath = tempState();
    const saved = process.env.DSH_PROFILE;
    process.env.DSH_PROFILE = 'web';
    try {
      const ask = await mountAsk(mod, { statePath, port: fake.port });
      await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
      const keys = Object.keys(readState(statePath));
      assert.ok(
        keys.some((k) => k.startsWith('web::')),
        `expected a web::-prefixed key from DSH_PROFILE; got ${JSON.stringify(keys)}`,
      );
    } finally {
      if (saved === undefined) delete process.env.DSH_PROFILE;
      else process.env.DSH_PROFILE = saved;
    }
  });

  it('an explicit session_key_prefix overrides detection', async () => {
    const statePath = tempState();
    const saved = process.env.DSH_PROFILE;
    process.env.DSH_PROFILE = 'web'; // must lose to the explicit value
    try {
      const ask = await mountAsk(mod, { statePath, port: fake.port, keyPrefix: 'custom' });
      await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
      const keys = Object.keys(readState(statePath));
      assert.ok(
        keys.some((k) => k.startsWith('custom::')),
        `an explicit prefix must win over DSH_PROFILE; got ${JSON.stringify(keys)}`,
      );
      assert.ok(!keys.some((k) => k.startsWith('web::')), 'the detected prefix must not also apply');
    } finally {
      if (saved === undefined) delete process.env.DSH_PROFILE;
      else process.env.DSH_PROFILE = saved;
    }
  });

  it('leaves keys unprefixed when no profile is detectable', async () => {
    const statePath = tempState();
    const saved = process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE;
    try {
      // argv in this process holds the test file path, which matches neither
      // profile, so detection resolves to '' and keys stay bare.
      const ask = await mountAsk(mod, { statePath, port: fake.port, keyPrefix: '' });
      await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
      const keys = Object.keys(readState(statePath));
      assert.deepEqual(keys, [WORKDIR], `expected the bare working_dir key; got ${JSON.stringify(keys)}`);
    } finally {
      if (saved !== undefined) process.env.DSH_PROFILE = saved;
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });
});

describe('atomcode_ask — the provider ladder is described ONCE, in order', () => {
  const state = { requests: [], counter: 0, mode: 'ok' };
  let fake;

  before(async () => { fake = await startFakeDaemon(state); });
  after(() => fake.server.close());

  // The description is the model's ONLY input about which layer wins (红线 8), so
  // every rung must appear exactly once. The old string appended default_provider's
  // parenthetical AFTER the last rung, producing
  // "… > 默认档位（当前 default_provider="x"） > 默认档位" — a ladder whose last two
  // steps are the same step, read by a model as an ordering it cannot resolve.
  const RUNGS = ['本参数', '详情页面板上选的档位', '插件配置 default_provider', 'AtomCode 自己的默认档位'];

  for (const withDefault of [false, true]) {
    it(`names each rung exactly once (default_provider ${withDefault ? 'set' : 'unset'})`, async () => {
      const statePath = tempState();
      const ask = await mountAsk(mod, {
        statePath,
        port: fake.port,
        config: withDefault ? { default_provider: 'AtomGit-glm5.3-flash' } : {},
      });
      for (const rung of RUNGS) {
        const count = ask.description.split(rung).length - 1;
        assert.equal(count, 1, `rung "${rung}" must appear exactly once; got ${count}`);
      }
      // The parenthetical states default_provider's current value, so it belongs
      // NEXT TO that rung — not trailing the last one.
      assert.match(ask.description, /default_provider[（(][^）)]*[）)] > AtomCode 自己的默认档位/);
      assert.doesNotMatch(ask.description, /AtomCode 自己的默认档位[（(][^）)]*[）)] > /);
    });
  }
});
