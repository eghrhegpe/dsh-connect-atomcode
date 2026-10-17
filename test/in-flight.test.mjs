/**
 * in-flight.test.mjs — the live reading of a turn that is still running.
 *
 * An `atomcode_ask` reply is aggregated and returned in ONE piece, so between
 * the call and its return the turn existed nowhere: the panel's 5s poll could
 * only show a frozen counter while tools ran for minutes, which is
 * indistinguishable from a hung plugin. `askChat` now reports progress as the
 * SSE arrives, the tool publishes it on `stats.ask.inFlight`, and the snapshot
 * carries it — so the panel has something true to say in that window.
 *
 * Hermetic: a local node:http server speaks the daemon vocabulary on an
 * ephemeral port and HOLDS the stream open on request, which is the only way to
 * observe the middle of a turn at all.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'lib', 'index.js');

const mod = await import(pathToFileURL(BRIDGE).href);
const { askChat } = await import(pathToFileURL(join(ROOT, 'lib', 'daemon.js')).href);

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every fake daemon this file starts, so one global teardown can force every
 * held stream shut.
 *
 * `server.close()` alone WAITS for open connections, and this file's whole trick
 * is leaving a `/chat` response deliberately open — so a single failed assertion
 * (which skips the release) would hang the process forever instead of failing.
 * `closeAllConnections()` is what makes a red test red rather than stuck.
 */
const servers = [];
after(() => {
  for (const server of servers) {
    try { server.closeAllConnections?.(); } catch { /* best effort */ }
    server.close();
  }
});

/** Poll a predicate until it holds, or fail loudly with the timeout named. */
async function waitFor(predicate, what, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

/**
 * A fake daemon that can HOLD a stream open.
 *
 * `control.perChat[i]` names the events the i-th /chat request writes before it
 * holds; the returned `release(i)` writes the terminal events and ends it. The
 * hold is the point of the file: without it there is no "middle of a turn" to
 * assert on, only the aggregate.
 */
async function startHoldDaemon(control = {}) {
  const chats = [];
  const pending = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = (req.url || '').split('?')[0];
      if (url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'atomcode-daemon' }));
        return;
      }
      if (url === '/chat') {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { /* keep {} */ }
        const index = chats.length;
        chats.push(payload);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(sse([
          { type: 'runtime_info', provider: 'Fake-Provider' },
          { type: 'session_assigned', session_id: `sess-${index + 1}` },
        ]));
        for (const ev of (control.perChat && control.perChat[index]) || control.events || []) {
          res.write(sse([ev]));
        }
        pending.push(() => {
          res.write(sse([
            { type: 'text', content: 'finished' },
            { type: 'done', tokens: 7, tool_calls: 1, session_id: `sess-${index + 1}`, stop_reason: 'stopped' },
          ]));
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    server,
    port: server.address().port,
    chats,
    pending,
    release: (i) => { const fn = pending[i]; if (fn) fn(); },
    releaseAll: () => pending.forEach((fn) => fn()),
  };
}

/** Mount the plugin and hand back the ask tool plus its stats route. */
async function mount(port, config = {}) {
  const tools = [];
  const routes = [];
  const ctx = {
    get: (name) => {
      if (name === 'tools') return { register: (def) => { tools.push(def); return () => {}; } };
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {}; } };
      return undefined;
    },
    logger: { warn() {}, error() {}, info() {} },
    fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
    inject() {},
    effect() {},
    on() {},
  };
  mod.apply(ctx, {
    auto_start: false,
    port,
    state_path: join(mkdtempSync(join(tmpdir(), 'atomcode-live-')), 'sessions.json'),
    ...config,
  });
  const ask = tools.find((t) => t.name === 'atomcode_ask');
  assert.ok(ask, 'atomcode_ask must be registered');
  return { ask, routes };
}

/** Drive the stats route the panel polls, and return the parsed body. */
async function readStats(routes) {
  const route = routes.find((r) => r.path === '/api/atomcode-bridge/stats');
  assert.ok(route, 'the stats route must be registered');
  const captured = { body: null };
  await route.handler(
    { method: 'GET', headers: { host: '127.0.0.1:3080' } },
    {
      writeHead() {},
      end(payload) { captured.body = JSON.parse(payload); },
    },
  );
  return captured.body;
}

describe('askChat — progress is reported while the turn runs, not only after', () => {
  let fake;
  let progress;
  let seen;

  before(async () => {
    progress = [];
    seen = null;
    fake = await startHoldDaemon({
      events: [
        { type: 'tool_start', name: 'read_file' },
        { type: 'tool_start', name: 'bash' },
        { type: 'tool_result', success: true },
      ],
    });
    const promise = askChat({
      message: 'go',
      port: fake.port,
      timeoutMs: 5000,
      onProgress: (p) => { progress.push({ ...p }); },
    });
    await waitFor(() => fake.chats.length === 1, 'the turn to reach the daemon');
    // Wait for the READINGS, not for the request: the request lands before the
    // client has parsed a single event, and sampling at that instant is what
    // made the first version of this file assert on an empty list.
    await waitFor(
      () => progress.length > 0 && progress[progress.length - 1].rounds === 2,
      'both tool_start events to be reported',
    );
    // A reading taken BEFORE the turn ends: this is the whole point.
    seen = progress[progress.length - 1];
    fake.releaseAll();
    await promise;
  });
  after(() => fake.server.close());

  it('publishes readings BEFORE the turn finishes', () => {
    assert.ok(seen, 'at least one reading must arrive while the turn is still running');
    assert.equal(seen.rounds, 2, 'two tool_start events must be counted as they land');
    assert.equal(seen.completed, 1, 'the answered call must count as completed: rounds - outstanding');
    assert.equal(seen.sessionId, 'sess-1', 'the assigned session must be visible mid-turn');
    assert.equal(seen.lastTool, 'bash', 'the most recent tool must be named, not just counted');
  });

  it('counts the calls still waiting rather than pretending they finished', () => {
    // `rounds - completed` is what the panel prints as "N 未回": a turn that
    // looks stuck is usually waiting on exactly this.
    assert.equal(seen.rounds - seen.completed, 1);
  });

  it('carries no partial reply text', () => {
    assert.ok(!('reply' in seen) && !('text' in seen), 'the reading is counts, never content');
    assert.equal(typeof seen.chars, 'number', 'but it does report a SIZE, so "is it producing?" is answerable');
  });
});

describe('askChat — a broken progress observer cannot kill a live turn', () => {
  it('swallows an exception thrown by onProgress', async () => {
    const fake = await startHoldDaemon({ events: [{ type: 'tool_start', name: 'bash' }] });
    const promise = askChat({
      message: 'go',
      port: fake.port,
      timeoutMs: 5000,
      onProgress: () => { throw new Error('observer exploded'); },
    });
    await waitFor(() => fake.chats.length === 1, 'the turn to reach the daemon');
    fake.releaseAll();
    const result = await promise;
    fake.server.close();
    // The observer crosses into the caller's code; without the guard this
    // exception would surface as a failed turn that never happened.
    assert.equal(result.ok, true, `the turn must survive its observer: ${result.error}`);
    assert.match(result.reply, /finished/);
  });
});

describe('atomcode_ask — the panel can see a turn while it is in flight', () => {
  it('publishes the in-flight turn, then clears it when the turn ends', async () => {
    const fake = await startHoldDaemon({ events: [{ type: 'tool_start', name: 'bash' }] });
    const { ask, routes } = await mount(fake.port, { approval_mode: 'bypass', working_dir: 'C:\\repo' });

    const running = ask.execute({ message: 'slow', working_dir: 'C:\\repo' }, {});
    await waitFor(() => fake.chats.length === 1, 'the turn to reach the daemon');

    const mid = await readStats(routes);
    assert.ok(mid.ask && mid.ask.inFlight, 'a running turn must be visible on the snapshot');
    assert.equal(mid.ask.inFlight.rounds, 1, 'the progress reading must reach the panel');
    assert.equal(mid.ask.inFlight.lastTool, 'bash');
    assert.equal(mid.ask.inFlight.workingDir, 'C:\\repo', 'the panel can say WHERE it runs, not just that it runs');
    assert.equal(typeof mid.ask.inFlight.elapsedMs, 'number');
    // An elapsed TIME, not a start timestamp: a client clock offset would
    // otherwise render a turn that started in the future.
    assert.ok(!('startedAt' in mid.ask.inFlight), 'the host measures the age; the client must not do clock maths');

    fake.releaseAll();
    await running;

    const after = await readStats(routes);
    assert.equal(after.ask.inFlight, null, 'a finished turn must not keep claiming to be running');
    assert.equal(after.ask.calls, 1, 'and the counter it belongs to must have moved');
  });

  it('a turn that never reaches the daemon never claims to be running', async () => {
    // The refusal path returns before the request goes out; the panel must not
    // show a turn that was never started.
    const fake = await startHoldDaemon({});
    const { ask, routes } = await mount(fake.port, { approval_mode: 'bypass' });
    const r = await ask.execute({ message: 'no directory' }, {});
    assert.equal(r.ok, false, 'premise: this turn is refused');
    const snapshot = await readStats(routes);
    assert.equal(snapshot.ask.inFlight, null, 'a refused turn must not appear in flight');
    fake.server.close();
  });

  it('the NEWEST turn finishing first still leaves the older one visible', async () => {
    // The ordering the identity check alone could not see. The slot holds the
    // NEWEST turn, so when THAT one finishes first, a plain `= null` blanks the
    // row while the older turn is still executing — the panel then claims
    // nothing is in flight during a turn that is. `endInFlight` recomputes the
    // slot from the set of live turns, which covers both orderings.
    const fake = await startHoldDaemon({});
    const { ask, routes } = await mount(fake.port, { approval_mode: 'bypass', working_dir: 'C:\\repo' });

    const first = ask.execute({ message: 'one', working_dir: 'C:\\repo' }, {});
    await waitFor(() => fake.chats.length === 1, 'the first turn to reach the daemon');
    const second = ask.execute({ message: 'two', working_dir: 'C:\\repo' }, {});
    await waitFor(() => fake.chats.length === 2, 'the second turn to reach the daemon');

    const both = await readStats(routes);
    assert.equal(both.ask.inFlight.sessionId, 'sess-2', 'the newest turn is the one the single row describes');

    fake.release(1); // the NEWEST finishes FIRST — the case the old clear got wrong
    await second;
    const mid = await readStats(routes);
    assert.ok(mid.ask.inFlight, 'the older turn is still running: the row must not vanish');
    assert.equal(mid.ask.inFlight.sessionId, 'sess-1', 'and it must fall back to describing the older turn');

    fake.release(0);
    await first;
    const after = await readStats(routes);
    assert.equal(after.ask.inFlight, null, 'when the last one ends the row goes away');
  });

  it('a turn that finishes does not blank a DIFFERENT turn still running', async () => {
    // One slot in the bag, and the model can have two ask calls in flight. The
    // clear is identity-checked for exactly this: a blind `= null` from
    // whichever turn finishes first would hide the one still working.
    const fake = await startHoldDaemon({});
    const { ask, routes } = await mount(fake.port, { approval_mode: 'bypass', working_dir: 'C:\\repo' });

    const first = ask.execute({ message: 'one', working_dir: 'C:\\repo' }, {});
    await waitFor(() => fake.chats.length === 1, 'the first turn to reach the daemon');
    const second = ask.execute({ message: 'two', working_dir: 'C:\\repo' }, {});
    await waitFor(() => fake.chats.length === 2, 'the second turn to reach the daemon');

    fake.release(0);
    await first;
    const mid = await readStats(routes);
    assert.ok(mid.ask.inFlight, 'the second turn is still running and must still be visible');

    fake.release(1);
    await second;
    const after = await readStats(routes);
    assert.equal(after.ask.inFlight, null, 'once BOTH are done the row goes away');
  });
});
