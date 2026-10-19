/**
 * protocol.test.mjs — the drift pins (from an earlier minor).
 *
 * The bridge rides two PRIVATE, unversioned AtomCode surfaces: the /chat SSE
 * vocabulary and the `status` command's localized text. Every one of them can change under us with a binary
 * upgrade and no error. That minor's answer is not a protocol handshake (none is
 * offered) but **observable degradation**: a silent failure mode becomes either
 * a named diagnostic or a panel signal.
 *
 * These tests are the regression guard for that contract. They use a fake
 * daemon speaking a DELIBERATELY WRONG vocabulary, and a captured-shaped
 * status text in a shape the parser must NOT accept — no binary, no network.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { askChat, healthInfo } from '../lib/daemon.js';
import { parseStatusQuota } from '../lib/quota.js';
import { requireDeadPort, sentinelPort } from './dead-port.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

async function startFakeDaemon(handler) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

describe('SSE protocol drift — an unknown vocabulary must fail LOUDLY', () => {
  /** @type {Array<import('node:http').Server>} */
  const open = [];
  // CLOSE FULLY, not just stop accepting. A bare `server.close()` is async: it
  // halts accept but keeps the handle alive until lingering connections drain,
  // so it leaves the server mid-`UV_HANDLE_CLOSING` when the test ends. The
  // runner mounts every suite with `--test-force-exit` (see
  // scripts/test.mjs — it kills the event loop right after the last assertion),
  // and force-exit landing on a closing libuv async handle trips
  // `src\win\async.c:94` on Windows: an abort that reports as a FILE-level test
  // failure with all 16 `it()`s green. Measured 4 reds / 6 runs before this.
  // `closeAllConnections()` drops the keep-alive sockets, and awaiting `close()`
  // means the handle is actually destroyed before the suite returns, so there is
  // nothing closing left for the forced exit to race. `engines` (node
  // ^22.19.0 || >=24.0.0, package.json) pins a version where
  // `closeAllConnections` always exists — a 2026-10 review worried a bare
  // `await close()` could hang forever if it did not, but no supported runtime
  // lacks it (the method landed in Node 18.2). The `typeof` guard below is
  // therefore NOT a back-compat hedge for old Node; it only stops this teardown
  // itself from throwing if a FUTURE node moves the symbol, and a bare
  // `server.close()` still drains the listening handle in that case (so the
  // race is softened, not re-opened). A timeout race was rejected on purpose:
  // timing out mid-close leaves the handle CLOSING, which is the exact state
  // `--test-force-exit` trips on — it would trade a hang for the abort this
  // fix exists to remove.
  after(async () => {
    await Promise.all(
      open.map(async ({ server }) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }),
    );
    // Second source of the same abort, on the CLIENT side of these turns. Every
    // `askChat`/`healthInfo` here goes through native `fetch` (undici), whose
    // global dispatcher keeps a pool of keep-alive sockets that outlive the last
    // assertion — closing a server only drains the LISTENING handle, not the
    // client pool. A pooled socket mid-`uv_close` is another `UV_HANDLE_CLOSING`
    // async handle for `--test-force-exit` to trip on (same `src\win\async.c:94`
    // abort as above). The dispatcher is created lazily on first fetch, so by
    // now it exists; `close()` returns a promise that resolves once the pool is
    // drained, and is best-effort: a future Node that moves the symbol must not
    // turn the guard itself into a failure (the server close above is the load-
    // bearing part; this is the remainder).
    const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
    if (dispatcher && typeof dispatcher.close === 'function') {
      await dispatcher.close().catch(() => {});
    }
  });

  it('names the observed types instead of "ended before done"', async () => {
    // A post-upgrade daemon that renamed every event. The earlier behaviour was
    // `ok:false, error:"atomcode SSE stream ended before done"` — technically
    // true, operationally useless (no hint that the PROTOCOL changed).
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([
        { type: 'llm.delta', text: 'hello' },
        { type: 'llm.done', session: 's1' },
      ]));
    });
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /unrecognized daemon SSE vocabulary/);
    assert.match(r.error, /llm\.delta/, 'the observed type names must be reported');
    assert.match(r.error, /upgrade dsh-connect-atomcode/);
  });

  it('is not a FAILURE — but it is not SILENT either (the drift that survives success)', async () => {
    // Two halves, and the second one used to be missing (2026-10 review: both
    // gates above require a turn to have FAILED or produced nothing, so drift
    // riding along a healthy turn was discarded).
    //
    // Half one, unchanged: one new event type among known ones is additive
    // drift, not breakage — calling it a failure would train the model to
    // ignore this error.
    //
    // Half two, the point of this case: "not a failure" had been rounded up to
    // "not a fact". When the renamed event is one the bridge COUNTS, the round
    // fuse goes silent with it — a `tool_start` renamed to anything else leaves
    // roundCount at 0, so the fuse can never trip and nothing on any surface
    // says so. The observation therefore has to outlive the success.
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([
        { type: 'runtime_info', provider: 'P' },
        { type: 'usage_telemetry', tokens: 3 },
        { type: 'text', content: 'fine' },
        { type: 'done', session_id: 's', stop_reason: 'stopped' },
      ]));
    });
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, true, 'an additive unknown event must not fail a healthy turn');
    assert.equal(r.reply, 'fine');
    assert.equal(r.error, '', 'and it must not be dressed up as a failure');
    assert.deepEqual(
      r.unknownTypes,
      ['usage_telemetry'],
      'but the observation must survive the success — otherwise the fuse can go blind in silence',
    );
  });

  it('a renamed BODY with done still intact is NOT a silent success (half drift)', async () => {
    // The shape the earlier payload gate missed (2026-10 code review): `done` keeps its
    // name, only the payload events were renamed. The old aggregation produced
    // ok:true with an EMPTY reply — "successful nothing", which red line 3
    // exists to ban, and it passed every existing drift test green because
    // `done !== null` made the turn recognizable. Must now fail loudly and
    // name the observed types.
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([
        { type: 'llm.delta', text: 'hello' },
        { type: 'done', session_id: 's1', stop_reason: 'stopped' },
      ]));
    });
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, false, 'a done carrying no recognizable content must not report success');
    assert.match(r.error, /no recognizable content/);
    assert.match(r.error, /llm\.delta/, 'the renamed payload type must be named');
    assert.match(r.error, /upgrade dsh-connect-atomcode/);
    assert.equal(r.sessionId, 's1', 'the session carried by done is still handed back');
  });

  it('a mid-turn error event SURVIVES a later done instead of being erased', async () => {
    // The earlier aggregation returned `error: ok ? '' : error` — once done arrived, any error
    // event was cleared unconditionally and a partially failed turn read as a
    // full success (ask.ok++ in the panel, no caveat for the model). The turn
    // stays ok — it DID complete with deliverable content — but carries the
    // error out; the render shows it as a named caveat.
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([
        { type: 'text', content: 'partial ' },
        { type: 'error', message: 'upstream hiccup' },
        { type: 'text', content: 'answer' },
        { type: 'done', session_id: 's', stop_reason: 'stopped' },
      ]));
    });
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, true, 'a completed turn is still completed');
    assert.equal(r.reply, 'partial answer');
    assert.equal(r.error, 'upstream hiccup', 'the mid-turn error must be carried out');
  });

  it('a truncated turn with an additive unknown type is NOT called a protocol change', async () => {
    // The false positive this guards: recognized `text` arrives, one harmless new
    // event type shows up, then the stream dies without a terminal event (idle
    // kill / network blip / timeout). Without the `sawRecognizable` gate the
    // error reads "the daemon may have changed its /chat protocol; upgrade
    // dsh-connect-atomcode" — sending the user to upgrade for a network hiccup.
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([
        { type: 'text', content: 'partial answer' },
        { type: 'usage_telemetry', tokens: 7 },
      ]));
    });
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /unrecognized daemon SSE vocabulary/, 'additive drift must not be blamed');
    assert.doesNotMatch(r.error, /upgrade dsh-connect-atomcode/, 'no upgrade advice for a truncated turn');
    assert.match(r.error, /ended before done/, 'the honest cause is a truncated stream');
    assert.equal(r.reply, 'partial answer', 'the partial answer is still handed back');
  });

  it('healthInfo surfaces the daemon version for the panel', async () => {
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'atomcode-daemon', version: '5.2.3' }));
    });
    open.push(fake);
    const info = await healthInfo(fake.port);
    assert.equal(info.up, true);
    assert.equal(info.version, '5.2.3');
    assert.equal(info.reason, '', 'a serving daemon has no failure to name');
  });

  // `up: false` used to be ONE bit for four different causes, and every caller
  // that reported an outage worded all four the same way — "未监听". That is
  // true of exactly one of them, and it is the one with the least to do: the
  // other three sent the reader hunting for a stopped process while the port
  // was, in fact, held by something else. Each cause gets its own assertion
  // because a classification nobody checks is a classification that drifts.
  it('names the cause: a stranger on the port is NOT "nothing listening"', async () => {
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'not atomcode' }));
    });
    open.push(fake);
    const info = await healthInfo(fake.port);
    assert.equal(info.up, false);
    assert.equal(info.reason, 'not-atomcode', 'the port IS served; "未监听" would be a lie');
  });

  it('names the cause: an unparseable 2xx body is its own failure', async () => {
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
    });
    open.push(fake);
    const info = await healthInfo(fake.port);
    assert.equal(info.up, false);
    assert.equal(info.reason, 'unreadable');
  });

  it('names the cause: a non-2xx answer from a live port', async () => {
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(503);
      res.end();
    });
    open.push(fake);
    const info = await healthInfo(fake.port);
    assert.equal(info.up, false);
    assert.equal(info.reason, 'http-error');
  });

  it('names the cause: a refusal is a REFUSAL, and nothing else', async () => {
    // A sentinel port proven free RIGHT NOW (test/dead-port.mjs), so "nothing
    // listens" stays a fact about THIS number instead of an assumption. It used
    // to be learned by binding an ephemeral port and releasing it — a fact too,
    // but under the parallel runner another suite's listen(0) could be handed
    // the just-released number before this request lands. The sentinel band sits
    // below every OS dynamic range, so no concurrent binder can receive it.
    const deadPort = await requireDeadPort(sentinelPort(6));
    const info = await healthInfo(deadPort);
    assert.equal(info.up, false);
    assert.equal(info.version, '');
    assert.equal(info.reason, 'refused', 'the one cause "未监听" was ever true of');
  });
});

describe('ask render — a completed turn must show its caveat, a clean one must not', () => {
  // Mounted ONCE for the cases below: `render` is a pure function of the value
  // it is handed, so the mount exists only to obtain it.
  let render;
  let fakeHome;
  before(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-render-home-'));
    const tools = [];
    const ctx = {
      get: (name) => (name === 'tools' ? { register: (d) => { tools.push(d); return () => {}; } } : undefined),
      logger: { warn() {}, error() {}, info() {} },
      fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
      inject() {},
      effect() {},
      on() {},
    };
    // Sentinel 4: INERT mount — `render` is obtained from the descriptor and
    // `auto_start: false` means nothing ever connects; it only needs a unique
    // dead number of its own, which is what the offset table guarantees.
    mod.apply(ctx, { auto_start: false, port: sentinelPort(4), state_path: join(fakeHome, 'sessions.json') });
    const ask = tools.find((t) => t.name === 'atomcode_ask');
    render = ask.output.render; // the descriptor nests render under `output`
  });
  after(() => rmSync(fakeHome, { recursive: true, force: true }));

  // `working_dir` is part of the value the tool now returns, and a turn that
  // names one is the CLEAN case the assertions below rely on: a turn with no
  // directory has a caveat of its own (see the third test in this suite).
  const base = {
    reply: 'partial answer', session_id: 's', continued: false, truncated: false,
    tokens: 1, tool_calls: 0, round_count: 0, tools: [], stop_reason: 'stopped',
    working_dir: '/repo', provider: 'P',
  };

  it('names the directory the turn ran in — and warns when there was none', () => {
    // An ask with no `working_dir` runs in the daemon's OWN cwd (the user's home,
    // in the default launch) and asks for unattended auto-approval: tools
    // auto-approved in a directory nobody named (the headless daemon does this
    // in EVERY approval_mode — 2026-10-17 probe). `atomcode_review` refuses that
    // case outright (红线 8) and `atomcode_ask` does too, in `execute()` — so the
    // render only ever sees a homeless turn the caller waved through with
    // `allow_unattended: true`. The directory has to be visible on the clean
    // path too, or "where did this run" stays a guess.
    const pinned = render({}, { ...base, ok: true, error: '' })[0].text;
    assert.match(pinned, /working_dir=\/repo/, 'a named directory must be stated, not implied');
    assert.doesNotMatch(pinned, /未指定/, 'and must not carry the unspecified-directory caveat');
    const homeless = render({}, { ...base, ok: true, error: '', working_dir: null })[0].text;
    assert.match(homeless, /未指定 working_dir/, 'an unattended turn in an unnamed directory must say so');
    assert.match(homeless, /无人值守/, 'the caveat must name WHY it matters (无人值守自动放行)');
    assert.match(homeless, /allow_unattended=true/, '…and that the caller already acknowledged it');
  });

  it('surfaces value.error on ok:true, and stays silent when error is empty', () => {
    // The carry-out fix in `askChat` is worthless if render's ok-branch hides
    // `error` (the earlier ok-branch only printed reply + meta). Pinned here: the
    // model MUST see the caveat, and a healthy turn must NOT be smeared with
    // one — both halves, or the next "cleanup" deletes it again.
    const warned = render({}, { ...base, ok: true, error: 'upstream hiccup' })[0].text;
    assert.match(warned, /upstream hiccup/, 'the caveat must reach the model');
    assert.match(warned, /partial answer/, 'the reply itself still comes through');
    const clean = render({}, { ...base, ok: true, error: '' })[0].text;
    assert.doesNotMatch(clean, /注意/, 'a healthy turn must not be smeared with a caveat');
  });

  it('surfaces the SSE drift list on ok:true, and stays silent when it is empty', () => {
    // The same discipline as the case above, applied to the one drift shape that
    // rides a SUCCESSFUL turn (see `askChat`'s `unknownTypes`). This is the half
    // the MODEL reads, and it is the half that matters most: without it the
    // bridge keeps answering ok while its round fuse counts nothing.
    const drifted = render(
      {},
      { ...base, ok: true, error: '', round_count: 0, protocol_unknown_types: ['tool_begin'] },
    )[0].text;
    assert.match(drifted, /tool_begin/, 'the observed type must be named, not summarised');
    assert.match(drifted, /轮数为 0/, 'and the disarmed fuse stated, since the rounds were undercounted');
    const tidy = render({}, { ...base, ok: true, error: '', protocol_unknown_types: [] })[0].text;
    assert.doesNotMatch(tidy, /注意/, 'an empty drift list is silence, not furniture');
  });
});

describe('quota text drift', () => {
  it('an unrelated line carrying a percentage is NOT mistaken for the usage line', () => {
    // "window" was removed from the label list precisely because lines like
    // this one (a percentage, a clock time, a parenthetical countdown — the
    // SHAPE of the usage line, but about something else) would otherwise be
    // misread. The correct answer is null, never a fabricated number.
    const q = parseStatusQuota([
      '  CodingPlan：CodingPlan Lite · 到期 2026-11-02（3d / 共 7d）',
      '  Smoothing window: 50% · 下一窗口 12:00（2h 后）',
    ].join('\n'));
    assert.equal(q.usagePercent, null, 'no fabricated percentage');
    assert.equal(q.raw.usageLine, null, 'and it must not even be adopted as "the" usage line');
    assert.equal(q.limited, false, 'a stale line must not fake an exhausted window');
  });

  it('keeps the raw plan line so the panel can still show a drifted status', () => {
    const q = parseStatusQuota('  CodingPlan：CodingPlan Lite · 到期 2026-11-02（3d / 共 7d）');
    assert.equal(q.usagePercent, null);
    assert.match(q.raw.planLine, /CodingPlan/);
  });

  it('the Chinese/English quota words still win over the tightened label', () => {
    assert.equal(parseStatusQuota('CodingPlan：X\n用量：当前窗口约 40% · 重置于 10:00（5m 后）').usagePercent, 40);
    assert.equal(parseStatusQuota('CodingPlan: X\nUsage: window 40%  ·  resets 10:00 (5m)').usagePercent, 40);
    assert.equal(parseStatusQuota('CodingPlan: X\nQuota 40% · resets 10:00 (5m)').usagePercent, 40);
  });
});
