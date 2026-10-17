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
import { dirname, join, resolve, sep } from 'node:path';
import { describe, it, before, after, beforeEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'lib', 'index.js');

// Module scope: `await` is not allowed inside a synchronous describe callback.
const mod = await import(pathToFileURL(BRIDGE).href);
// The ONE budget constant (src/host/config.ts → lib/config.js). Imported rather
// than spelled out here: the case below asserts where the cut happens, and a
// second copy of the number would quietly stop asserting that.
const { OUTPUT_CAP } = await import(pathToFileURL(join(ROOT, 'lib', 'config.js')).href);

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
        // Drift injection: event types this client does not know. Deliberately
        // ADDITIVE and placed before a perfectly good `text`/`done`, because
        // that is the shape that used to pass for a clean success.
        for (const type of state.unknownTypes || []) {
          events.push({ type, name: 'synthetic-unknown' });
        }
        events.push({ type: 'text', content: 'ok' });
        events.push({
          type: 'done',
          session_id: sessionId,
          tokens: 5,
          // `state.reportedToolCalls` overrides what the daemon CLAIMS it ran,
          // which is how the "our fuse missed calls the daemon made" case is
          // produced: the wire carries fewer `tool_start` events than the number
          // `done` reports. Unset = the honest fixture behaviour (the daemon
          // reports exactly what it emitted).
          ...(state.reportedToolCalls !== undefined
            ? { tool_calls: state.reportedToolCalls }
            : { tool_calls: state.toolStarts || 0 }),
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

/**
 * Mount the plugin against a fake daemon and return its atomcode_ask tool.
 *
 * The fake logger DOES NOT swallow what the plugin says: warnings and errors
 * are collected on `ask.mountWarnings`. The plugin degrades silently by design
 * when a state file cannot be written (红线 3 says it must still be NAMED), and
 * a mock logger with no-op methods was throwing that name away — which is why
 * this suite's one flake (three profile cases reading a sessions.json that was
 * never written) surfaced as a bare ENOENT that pointed at the symptom and hid
 * the cause. Capturing the name here is what lets `readState` report it.
 */
async function mountAsk(mod, { statePath, port, keyPrefix, config = {}, withRoutes = false }) {
  const tools = [];
  const routes = [];
  const mountWarnings = [];
  const ctx = {
    get: (name) => {
      if (name === 'tools') return { register: (def) => { tools.push(def); return () => {}; } };
      // Opt-in. Registering the webServer is what makes the mount build its HTTP
      // routes; leaving it off by default keeps the cases that never read the
      // panel running the same code path they ran before.
      if (name === 'webServer') {
        return withRoutes ? { register: (route) => { routes.push(route); return () => {}; } } : undefined;
      }
      return undefined;
    },
    logger: {
      warn: (m) => mountWarnings.push(String(m)),
      error: (m) => mountWarnings.push(String(m)),
      info() {},
    },
    fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
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
  ask.mountWarnings = mountWarnings;
  ask.routes = routes;
  return ask;
}

/**
 * Drive a registered route for real and capture what it wrote.
 *
 * The stats snapshot is the only place the panel-facing half of protocol drift
 * lives, and it is built inside the mount — so asserting it means calling the
 * route the panel actually calls, not rebuilding the body here.
 */
async function callRoute(route, { method = 'GET', headers = {} } = {}) {
  const captured = { status: 0, body: null, ended: false };
  const response = {
    writeHead(status) { captured.status = status; },
    end(payload) {
      captured.ended = true;
      if (payload === undefined) return;
      try { captured.body = JSON.parse(payload); } catch { captured.body = null; }
    },
  };
  await route.handler({ method, headers }, response);
  assert.equal(captured.ended, true, 'the handler must end the response');
  return captured;
}

/**
 * Read the on-disk session map, and — when it cannot be read — say WHY in the
 * failure itself. A missing file is the one flake this suite has ever produced;
 * `ENOENT` alone names the symptom and buries the cause. Passing `ask` here
 * lets the error carry whatever the plugin said while mounting, so the next
 * occurrence debugs itself instead of costing another bisect.
 */
const readState = (p, ask) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (error) {
    const said = ask && Array.isArray(ask.mountWarnings) && ask.mountWarnings.length
      ? `\n  the plugin named this at mount time:\n    ${ask.mountWarnings.join('\n    ')}`
      : '\n  (the plugin named nothing at mount time)';
    throw new Error(`readState(${p}) failed: ${error.message}${said}`);
  }
};

/**
 * Assert a turn SUCCEEDED, and when it did not, say why.
 *
 * Tests that assert on the state file read it AFTER a turn; if that turn failed
 * (a daemon that never answered), the absence of a file is what they see —
 * `ENOENT`, which names the symptom and discards the cause the turn itself had
 * already reported in `r.error`. That is the shape of this suite's one flake:
 * three cases failed as a missing file with the real error buried in an
 * ignored return value. Assert the success FIRST so the two cannot be confused.
 */
function execOk(r, ask) {
  const ext = ask && Array.isArray(ask.mountWarnings) && ask.mountWarnings.length
    ? ` mountWarnings=${JSON.stringify(ask.mountWarnings)}`
    : '';
  assert.equal(
    r.ok,
    true,
    `the turn must succeed before its bookkeeping is asserted; r.error=${JSON.stringify(r.error)}${ext}`,
  );
}

const tempState = () => join(mkdtempSync(join(tmpdir(), 'atomcode-glue-')), 'sessions.json');
const WORKDIR = 'C:\\repo';
const OTHERDIR = 'C:\\other';

// The state KEY is not the argument string: the glue stores under
// `resolve(working_dir)` (`src/host/tools.ts`), and `resolve` is
// platform-dependent. On Windows the fixture above is already absolute, so
// `resolve(WORKDIR) === WORKDIR` and the difference is invisible; on POSIX the
// same fixture is RELATIVE, so `resolve` prefixes the cwd — and every
// `state[WORKDIR]` lookup then reads a key nobody ever wrote. That is exactly
// how this suite passed here and failed on every CI run (eight cases, ubuntu):
// a Windows-shaped fixture asserted against a platform-dependent resolver.
// Index the state file through these, never through the literal.
const WORKDIR_KEY = resolve(WORKDIR);
const OTHERDIR_KEY = resolve(OTHERDIR);

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
      readState(statePath, ask)[WORKDIR_KEY].sessionId,
      r.session_id,
      'the assigned id must be persisted under the working_dir key',
    );
  });

  it('continue:true replays the recorded session id to the daemon', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: WORKDIR }, {});
    const recorded = readState(statePath, ask)[WORKDIR_KEY].sessionId;
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
    const recorded = readState(statePath, ask)[WORKDIR_KEY].sessionId;
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
      readState(statePath, ask)[WORKDIR_KEY].sessionId,
      recorded,
      'a failed turn must leave the previously recorded session intact',
    );
  });

  it('a different working_dir is a different session key', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'repo a', working_dir: WORKDIR }, {});
    const firstId = readState(statePath, ask)[WORKDIR_KEY].sessionId;
    await ask.execute({ message: 'repo b', working_dir: OTHERDIR }, {});
    const saved = readState(statePath, ask);
    assert.ok(saved[OTHERDIR_KEY], 'the second working_dir must get its own key');
    assert.equal(saved[WORKDIR_KEY].sessionId, firstId, 'the first key is untouched');
    assert.notEqual(saved[OTHERDIR_KEY].sessionId, firstId);
  });

  it('trailing slashes on working_dir fold onto the same key', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: WORKDIR }, {});
    // The trailing separator must be THIS platform's separator. `resolve` folds
    // only what `path.sep` recognises: on POSIX a Windows-shaped `C:\repo\\` is a
    // genuinely DIFFERENT path (backslash is an ordinary character there), so
    // forking the key would be the correct behaviour and this assertion would be
    // asserting a Windows-only accident. Built from `sep`, the fixture keeps the
    // invariant on both platforms.
    const r = await ask.execute({ message: 'again', continue: true, working_dir: WORKDIR + sep + sep }, {});
    assert.equal(r.continued, true, 'trailing separators must not fork the session key');
  });

  it('reset_session clears a stale mapping AND stops this turn from resuming it', async () => {
    // The escape hatch for a daemon-side session that expired: v0.3 had a
    // `drop()` on the store with no caller at all, so a stale id could only be
    // cleared by hand-editing sessions.json.
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    await ask.execute({ message: 'first', working_dir: WORKDIR }, {});
    const stale = readState(statePath, ask)[WORKDIR_KEY].sessionId;
    assert.ok(stale);

    const r = await ask.execute({ message: 'start over', continue: true, reset_session: true, working_dir: WORKDIR }, {});
    assert.equal(r.continued, false, 'a reset must not report a continuation');
    assert.equal(
      state.requests.at(-1).session_id,
      undefined,
      'the stale session id must NOT be replayed to the daemon',
    );
    // …and the new turn's own session takes its place.
    const saved = readState(statePath, ask)[WORKDIR_KEY];
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
    assert.equal(readState(statePath, ask)[WORKDIR_KEY].sessionId, 'fresh-9');
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
          // `OUTPUT_CAP + 100`, not a hardcoded 200_100: the number lives in one
          // place now, and a test that spelled it out again would keep passing
          // after the constant moved.
          { type: 'text', content: 'x'.repeat(OUTPUT_CAP + 100) },
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
      assert.match(r.reply, /truncated by dsh-connect-atomcode/, 'the clip point must be marked inline');
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
      execOk(await ask.execute({ message: 'hi', working_dir: WORKDIR }, {}), ask);
      const keys = Object.keys(readState(statePath, ask));
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
      execOk(await ask.execute({ message: 'hi', working_dir: WORKDIR }, {}), ask);
      const keys = Object.keys(readState(statePath, ask));
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
      execOk(await ask.execute({ message: 'hi', working_dir: WORKDIR }, {}), ask);
      const keys = Object.keys(readState(statePath, ask));
      assert.deepEqual(keys, [WORKDIR_KEY], `expected the bare working_dir key; got ${JSON.stringify(keys)}`);
    } finally {
      if (saved !== undefined) process.env.DSH_PROFILE = saved;
      rmSync(dirname(statePath), { recursive: true, force: true });
    }
  });
});

describe('atomcode_ask — a clipped tool list is MARKED, never silent', () => {
  const state = { requests: [], counter: 0, mode: 'ok', toolStarts: 0 };
  let fake;

  before(async () => { fake = await startFakeDaemon(state); });
  after(() => fake.server.close());
  beforeEach(() => { state.requests.length = 0; state.toolStarts = 0; });

  // `ask_max_rounds: 0` disables the bridge's round fuse, which is what lets 40
  // tool rounds reach the aggregator at all — so this case also re-checks that
  // 0 means "unbounded" rather than falling back to the 25 default.
  it('caps the array at 30 AND says so, with tool_calls still the true count', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, config: { ask_max_rounds: 0 } });
    state.toolStarts = 40;
    const r = await ask.execute({ message: 'spam tools', working_dir: WORKDIR }, {});
    assert.equal(r.ok, true, 'with the fuse off, 40 rounds must not fail the turn');
    assert.equal(r.tools.length, 30, 'the array is capped');
    assert.equal(r.tools_truncated, true, 'the cut must be flagged, not left implicit');
    assert.equal(r.tool_calls, 40, 'the true count survives the cap');
    assert.equal(r.tools[0].name, 'synthetic-tool-0', 'the FIRST records are kept, not the last');
  });

  it('a turn under the cap reports tools_truncated: false', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, config: { ask_max_rounds: 0 } });
    state.toolStarts = 3;
    const r = await ask.execute({ message: 'three tools', working_dir: WORKDIR }, {});
    assert.equal(r.tools.length, 3);
    assert.equal(r.tools_truncated, false, 'no cut happened, so nothing may be flagged');
  });

  // The static contract: the schema must NAME the cap, because a caller reading
  // only the schema (render output aside) has no other way to know 30 is a limit
  // rather than a coincidence.
  it('the schema declares the cap, and the marker is a required field', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const props = ask.output.schema.properties;
    assert.match(props.tools.description, /30/, 'the tools description must name the cap');
    assert.equal(props.tools_truncated.type, 'boolean');
    assert.ok(
      ask.output.schema.required.includes('tools_truncated'),
      'a truncation marker that may be omitted is not a contract',
    );
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

describe('atomcode_ask — bookkeeping that cannot be written does not fail the turn', () => {
  const state = { requests: [], counter: 0, mode: 'ok' };
  let fake;

  before(async () => { fake = await startFakeDaemon(state); });
  after(() => fake.server.close());

  // The turn is fine; only the mapping that would let the NEXT `continue: true`
  // resume it is unavailable. Before this was fixed, the `set()` call at the end
  // of a successful turn threw EISDIR (a `state_path` pointing at a directory)
  // and the model received a tool error for a turn that had already produced a
  // complete reply — the bookkeeping took down the work.
  it('a state_path pointing at a directory degrades the glue, not the answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-statedir-'));
    try {
      const ask = await mountAsk(mod, { statePath: dir, port: fake.port });
      const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
      assert.equal(r.ok, true, 'a broken state path must not turn a good answer into an error');
      assert.match(r.reply, /ok/, 'the reply itself must survive untouched');
      // …and the degrade is NAMED, not swallowed (红线 3). Degrading silently is
      // half the bug: a turn that quietly stops recording sessions looks
      // identical to one that has no sessions to record.
      assert.ok(
        ask.mountWarnings.some((w) => w.includes('state path is a directory, not a file')),
        `the reason must reach the logger; the plugin said ${JSON.stringify(ask.mountWarnings)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The dedupe is by ROOT CAUSE, not by which side failed. A directory at
  // `state_path` fails the read as EISDIR and the write as EISDIR too; if each
  // reported its own wording, the panel's per-poll `count()` would alternate
  // between two messages and log a "fresh" degradation forever — a warning that
  // never stops is how a real one gets ignored. Same cause, same sentence.
  it('names that cause ONCE, however many times the store is poked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomcode-statedir-'));
    try {
      const ask = await mountAsk(mod, { statePath: dir, port: fake.port });
      await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
      const afterFirst = ask.mountWarnings.length;
      // Re-run and poll: each call reads (EISDIR) then writes (EISDIR) again.
      await ask.execute({ message: 'again', working_dir: WORKDIR }, {});
      assert.equal(
        ask.mountWarnings.length,
        afterFirst,
        `a repeated identical failure must not be re-announced; got ${JSON.stringify(ask.mountWarnings)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('atomcode_ask — a renamed daemon event is NAMED, never a silent success', () => {
  // The drift shape neither of askChat's error gates can report, because both
  // require the turn to have FAILED or produced NOTHING. A daemon that renames an
  // event while leaving `text`/`done` intact therefore came back as a clean
  // success with the evidence discarded — and when the renamed event is
  // `tool_start`, the round fuse (which COUNTS it) quietly stops existing while
  // every surface still says ok. These cases assert the signal end to end:
  // wire → aggregation → tool output → stats snapshot the panel reads.
  const state = { requests: [], counter: 300, mode: 'ok', unknownTypes: [] };
  let fake;

  before(async () => { fake = await startFakeDaemon(state); });
  after(() => fake.server.close());
  beforeEach(() => {
    state.requests.length = 0;
    state.unknownTypes = [];
    // Cleared here rather than left to each case: an override that leaked out of
    // the one test that set it would quietly change what every later turn claims
    // the daemon reported.
    delete state.reportedToolCalls;
  });

  it('a SUCCESSFUL turn carrying an unknown SSE type reports it on the tool output', async () => {
    state.unknownTypes = ['tool_begin'];
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    assert.equal(r.ok, true, 'the turn must genuinely succeed — otherwise the other gate would explain it');
    assert.deepEqual(r.protocol_unknown_types, ['tool_begin'], 'the drift must survive success (红线 3)');
    assert.equal(r.round_count, 0, 'premise: the renamed event is not counted, so the fuse is disarmed');
  });

  it('a clean turn reports an EMPTY list rather than omitting the field', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    assert.deepEqual(r.protocol_unknown_types, [], '"not checked" and "nothing seen" must not look alike');
    assert.ok(
      ask.output.schema.required.includes('protocol_unknown_types'),
      'a drift marker that may be omitted is not a contract (same rule as tools_truncated)',
    );
  });

  it('the render names the type, and CONFIRMS the fuse worked when both counts agree', async () => {
    // This fixture reports `tool_calls: 0` on `done` while the turn carried an
    // unknown type — i.e. the daemon's own count says no tool ran, so the
    // renamed event was NOT one of the counted ones. That is now a measurable
    // verdict rather than the old "if it was a tool event, the fuse is
    // disarmed": the two numbers are compared and the sentence says which
    // case it is. Drift is still worth naming (the next rename may hit a
    // counted type), so the line stays either way.
    state.unknownTypes = ['tool_begin'];
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    const text = ask.output.render({}, r).map((part) => part.text).join('\n');
    assert.match(text, /不认识的事件类型（tool_begin）/, 'the drifted type must be named, not summarised');
    assert.match(text, /与本端计数一致/, 'and the comparison must be stated as the result it is');
    assert.match(text, /下一次改名未必还避开它/, 'a confirmed-clean fuse must not be sold as "no risk"');
  });

  it('the render says the fuse DID NOT FIRE when the daemon counted more than we did', async () => {
    // The shape the old wording could only hedge about, now measured: the
    // daemon reports calls the plugin never saw counted. This is the turn where
    // `max_rounds` silently did nothing.
    state.unknownTypes = ['tool_begin'];
    state.reportedToolCalls = 12;
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    const text = ask.output.render({}, r).map((part) => part.text).join('\n');
    assert.match(text, /daemon 自报 12 次工具调用、本端只数到 0 次/, 'both numbers, not just "a mismatch"');
    assert.match(text, /熔断确实没有生效/, 'stated as a fact, not as a possibility');
    assert.match(text, /不是"可能失效"/, 'the upgrade from hedge to verdict must be visible in the words');
  });

  it('the render falls back to the hedge when the daemon reports no count', async () => {
    // An older daemon (or a body-rename drift) sends no number. The plugin must
    // not invent agreement — "it said nothing" is not "it said the same thing" —
    // and with our count at 0 this is the dangerous shape: the fuse may have
    // been disarmed for the whole turn.
    state.unknownTypes = ['tool_begin'];
    state.reportedToolCalls = null;
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    const text = ask.output.render({}, r).map((part) => part.text).join('\n');
    assert.equal(r.daemon_tool_calls, null, 'the field must stay null rather than default to a favourable 0');
    assert.match(text, /daemon 没有自报次数/, 'the reason the verdict is unavailable must be named');
    assert.match(text, /熔断此刻已是失效状态/, 'and the 0-round case must not be softened');
  });

  it('with no daemon count but a non-zero one of ours, it says which branch is unknowable', async () => {
    state.unknownTypes = ['tool_begin'];
    state.reportedToolCalls = null;
    state.toolStarts = 3;
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    const text = ask.output.render({}, r).map((part) => part.text).join('\n');
    assert.match(text, /无法当场判定/, 'a partial count is not evidence of a working fuse');
    // The round count is what the caller has, so it must still be printed.
    assert.match(text, /round_count 偏小/);
  });

  it('the drift reaches the stats snapshot the panel polls', async () => {
    state.unknownTypes = ['tool_begin'];
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, withRoutes: true });
    const stats = ask.routes.find((r) => r.path === '/api/atomcode-bridge/stats');
    assert.ok(stats, 'the stats route must be registered');
    await ask.execute({ message: 'hi', working_dir: WORKDIR }, {});
    const res = await callRoute(stats, { headers: { host: '127.0.0.1:3080' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.protocol.unknownTypes, ['tool_begin']);
  });

  it('a later clean turn does NOT erase a drift already seen', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, withRoutes: true });
    const stats = ask.routes.find((r) => r.path === '/api/atomcode-bridge/stats');
    state.unknownTypes = ['tool_begin'];
    await ask.execute({ message: 'drifting', working_dir: WORKDIR }, {});
    state.unknownTypes = [];
    await ask.execute({ message: 'clean', working_dir: WORKDIR }, {});
    const res = await callRoute(stats, { headers: { host: '127.0.0.1:3080' } });
    assert.deepEqual(
      res.body.protocol.unknownTypes,
      ['tool_begin'],
      'an intermittent drift that a later turn erases is invisible again — the union is the point',
    );
  });
});

describe('atomcode_ask — an unnamed directory is REFUSED, not warned about afterwards', () => {
  // The case that matters is NO resolvable working_dir: it hands AtomCode a
  // full autonomous tool loop, auto-approved, running in whatever cwd the
  // daemon was launched in — the user's home, in the default launch. `atomcode_review`
  // has refused this case since it existed; ask only MENTIONED it, in the
  // render, which runs after the turn. A warning delivered with the results
  // cannot stop the thing it warns about — so the weaker guard sat on the more
  // dangerous tool (review is one-shot and bounded; ask is the one with the
  // tool loop). These cases pin the refusal and, just as importantly, the three
  // ways a caller gets a WORKING turn back.
  //
  // The refusal is mode-INDEPENDENT on purpose. It used to fire only on the
  // `approval_mode: bypass` pairing, on the assumption that a non-bypass turn
  // had a human approving tools. The 2026-10-17 probe (scripts/probes/approval-mode.mjs)
  // proved a headless daemon auto-approves ask-class tools in EVERY mode
  // (`[headless] auto-approved`), so the danger — and the gate — no longer
  // names a mode.
  const state = { requests: [], counter: 400, mode: 'ok' };
  let fake;

  before(async () => { fake = await startFakeDaemon(state); });
  after(() => fake.server.close());
  beforeEach(() => { state.requests.length = 0; });

  it('no working_dir refuses BEFORE the daemon is touched (shipped default = bypass)', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi' }, {});
    assert.equal(r.ok, false, 'the turn must not report success');
    assert.equal(r.working_dir, null, 'the refused turn still has to say it ran nowhere');
    assert.match(r.error, /拒绝了本回合/, 'a refusal must read as a refusal, not as a daemon failure');
    assert.match(r.error, /红线 8/, 'and must name the rule it is enforcing');
    assert.match(r.error, /working_dir/, 'the message must name escape 1');
    assert.match(r.error, /allow_unattended/, 'and the explicit escape');
    assert.equal(
      state.requests.length,
      0,
      'nothing may reach the daemon: refusing after POSTing /chat would already have started the turn',
    );
  });

  it('allow_unattended:true is the acknowledged way through', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi', allow_unattended: true }, {});
    assert.equal(r.ok, true, 'an acknowledged turn must be allowed to run');
    assert.equal(r.working_dir, null, 'the acknowledgement does not invent a directory');
    assert.equal(
      state.requests.at(-1).working_dir,
      undefined,
      'no directory was named, so none may be sent',
    );
    const text = ask.output.render({}, r).map((part) => part.text).join('\n');
    assert.match(text, /allow_unattended=true 放行/, 'the render must present this as the acknowledgement it is');
  });

  it('a NON-bypass approval_mode is STILL refused — the gate does not couple to the mode', async () => {
    // The old assumption: with a human in the loop an unnamed directory was
    // tolerable, so only the bypass pairing was refused. The 2026-10-17 probe
    // disproved it for the headless daemon — auto-approval holds in every mode,
    // so an unnamed directory is unattended danger in all of them. `on-request`
    // (the value the old test used) is not even a legal daemon value (closed
    // enum build|accept_edits|bypass|plan, 422 gate), so this one pins the
    // behavior on a real enum value.
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, config: { approval_mode: 'accept_edits' } });
    const r = await ask.execute({ message: 'hi' }, {});
    assert.equal(r.ok, false, 'the refusal must not depend on the mode');
    assert.match(r.error, /拒绝了本回合/);
    assert.equal(state.requests.length, 0, 'the refusal must happen before the daemon is touched');
  });

  it('allow_unattended:true is the acknowledgement in any mode', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, config: { approval_mode: 'accept_edits' } });
    const r = await ask.execute({ message: 'hi', allow_unattended: true }, {});
    assert.equal(r.ok, true, 'the acknowledgement must work regardless of the mode');
    assert.equal(r.working_dir, null, 'the acknowledgement does not invent a directory');
    assert.equal(state.requests.at(-1).approval_mode, 'accept_edits');
  });

  it('a configured working_dir fills the gap, and reaches the wire', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, {
      statePath,
      port: fake.port,
      config: { working_dir: 'C:\\configured' },
    });
    const r = await ask.execute({ message: 'hi' }, {});
    assert.equal(r.ok, true, 'rung 3 of the ladder is a real answer to the refusal');
    assert.equal(r.working_dir, 'C:\\configured');
    assert.equal(state.requests.at(-1).working_dir, 'C:\\configured');
  });

  it('the host session cwd fills the gap too, without any flag', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const r = await ask.execute({ message: 'hi' }, { cwd: 'C:\\from-host' });
    assert.equal(r.ok, true, 'once the host exposes the session cwd the refusal stops firing on its own');
    assert.equal(state.requests.at(-1).working_dir, 'C:\\from-host');
  });

  it('a refused turn is charged to the error counter the panel polls', async () => {
    // An average built from a subset of calls is worse than no average: the
    // refusal has to reach stats whether or not it reached the daemon.
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port, withRoutes: true });
    const stats = ask.routes.find((r) => r.path === '/api/atomcode-bridge/stats');
    await ask.execute({ message: 'refused' }, {});
    const res = await callRoute(stats, { headers: { host: '127.0.0.1:3080' } });
    assert.equal(res.body.ask.calls, 1, 'the refused call happened; the panel must see it');
    assert.equal(res.body.ask.err, 1, 'and it failed');
  });

  it('the schema documents the flag, so the retry is one call away', async () => {
    const statePath = tempState();
    const ask = await mountAsk(mod, { statePath, port: fake.port });
    const param = ask.parameters.properties.allow_unattended;
    assert.ok(param, 'a refusal whose escape is undocumented is a dead end');
    assert.match(param.description, /默认 false/);
    assert.match(param.description, /working_dir/, 'and must send the caller to the directory first');
  });
});
