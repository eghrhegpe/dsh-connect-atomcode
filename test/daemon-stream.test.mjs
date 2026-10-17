/**
 * daemon-stream.test.mjs — hermetic coverage for the /chat SSE client.
 *
 * Nothing here needs AtomCode, a daemon, or the network: a local node:http
 * server speaks the daemon's SSE vocabulary on an ephemeral port, so the
 * aggregation logic (reply concat, session, tokens, tool pairing, provider
 * capture, roundCount), the round fuse and the abort-reason mapping are all
 * asserted without a real agent turn.
 *
 * This closes the gap that previously left `askChat` covered only by the live
 * suite (which skips when no daemon is running).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, before, after } from 'node:test';
import { askChat, streamChat } from '../lib/daemon.js';

/** Build an SSE body from a list of event objects. */
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/**
 * Start a fake daemon. `handler(req, res)` decides the response; the returned
 * object exposes the port and a shutter.
 */
async function startFakeDaemon(handler) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        handler(req, res, body);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** Stream a fixed SSE body then end. */
function respondSse(res, events, { chunkDelayMs = 0 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  if (chunkDelayMs <= 0) {
    res.end(sse(events));
    return;
  }
  let i = 0;
  const tick = setInterval(() => {
    if (i >= events.length) {
      clearInterval(tick);
      res.end();
      return;
    }
    res.write(sse([events[i]]));
    i += 1;
  }, chunkDelayMs);
}

const HAPPY = [
  { type: 'runtime_info', provider: 'Fake-Provider-A', model: 'fake-model' },
  { type: 'session_assigned', session_id: 'sess-123' },
  { type: 'reasoning', content: 'thinking' },
  { type: 'text', content: 'Hello ' },
  { type: 'tool_start', name: 'read' },
  { type: 'tool_result', success: true },
  { type: 'text', content: 'world' },
  { type: 'tokens', prompt: 10, completion: 5, total: 15 },
  { type: 'done', tokens: 42, tool_calls: 1, session_id: 'sess-123', stop_reason: 'stopped' },
];

describe('daemon /chat SSE client — hermetic', () => {
  /** @type {Array<{server: import('node:http').Server}>} */
  const open = [];
  after(() => {
    for (const { server } of open) server.close();
  });

  it('aggregates a happy-path turn (reply, session, tokens, tools, provider, roundCount)', async () => {
    const fake = await startFakeDaemon((req, res) => respondSse(res, HAPPY));
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, true);
    assert.equal(r.error, '');
    assert.equal(r.reply, 'Hello world');
    assert.equal(r.sessionId, 'sess-123');
    assert.equal(r.tokens, 42, 'done.tokens wins over the tokens event');
    assert.equal(r.toolCalls, 1);
    assert.equal(r.roundCount, 1, 'one tool_start observed');
    assert.deepEqual(r.tools, [{ name: 'read', success: true }]);
    assert.equal(r.stopReason, 'stopped');
    assert.equal(r.provider, 'Fake-Provider-A', 'provider comes from runtime_info');
    assert.deepEqual(
      r.unknownTypes,
      [],
      'no drift observed must be reported as an EMPTY list, not an absent field — '
        + '"not checked" and "nothing seen" are different facts',
    );
  });

  it('a SUCCESSFUL turn carrying an unknown event type still reports it', async () => {
    // The hole both error gates missed. Gate 1 needs the turn to have FAILED,
    // gate 2 needs it to have produced nothing — so a daemon that renames an
    // event while leaving `text`/`done` intact came back ok:true with the drift
    // thrown away. Here the renamed event is `tool_begin`, and the consequence
    // is asserted rather than described: `roundCount` stays 0, so the round fuse
    // (which counts `tool_start`) is silently disarmed for this very turn.
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [
        { type: 'text', content: 'all good' },
        { type: 'tool_begin', name: 'read' },
        { type: 'done', session_id: 'sess-x', tokens: 1, stop_reason: 'stopped' },
      ]),
    );
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, true, 'the turn genuinely succeeded — this is why it stayed silent');
    assert.equal(r.reply, 'all good');
    assert.equal(r.error, '');
    assert.deepEqual(
      r.unknownTypes,
      ['tool_begin'],
      'the drift must survive a successful turn (红线 3)',
    );
    assert.equal(r.roundCount, 0, 'premise: the renamed tool event is not counted, so the fuse is blind');
  });

  it('falls back to the tokens event when done omits tokens', async () => {
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [
        { type: 'text', content: 'x' },
        { type: 'tokens', prompt: 1, completion: 2, total: 3 },
        { type: 'done', session_id: 's', stop_reason: 'stopped' },
      ]),
    );
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, true);
    assert.equal(r.tokens, 3);
  });

  it('reports the requested provider when no runtime_info arrives', async () => {
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [{ type: 'text', content: 'x' }, { type: 'done', stop_reason: 'stopped' }]),
    );
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, provider: 'Asked-For', timeoutMs: 10_000 });
    assert.equal(r.provider, 'Asked-For');
  });

  it('stream ending before done → ok:false with a named error', async () => {
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [{ type: 'text', content: 'partial' }]),
    );
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /ended before done/);
    assert.equal(r.reply, 'partial', 'partial text is preserved for the caller');
  });

  it('HTTP error carries the status', async () => {
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
  });

  it('timeout aborts with an actionable reason (not a bare DOMException)', async () => {
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [
        { type: 'text', content: 'slow' },
        { type: 'done', stop_reason: 'stopped' },
      ], { chunkDelayMs: 400 }),
    );
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 150 });
    assert.equal(r.ok, false);
    assert.match(r.error, /atomcode turn aborted: timeout after 150ms/);
  });

  it('round fuse trips on the (maxRounds+1)-th tool_start with a named reason', async () => {
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [
        { type: 'tool_start', name: 'a' },
        { type: 'tool_start', name: 'b' },
        { type: 'tool_start', name: 'c' },
        { type: 'done', stop_reason: 'stopped' },
      ]),
    );
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000, maxRounds: 2 });
    assert.equal(r.ok, false);
    assert.match(r.error, /agent exceeded 2 tool rounds \(round fuse\)/);
    // The offending (maxRounds+1)-th tool_start is yielded before the abort, so
    // the caller can see which round broke the budget; roundCount is therefore
    // maxRounds + 1 rather than maxRounds.
    assert.equal(r.roundCount, 3);
  });

  it('round fuse stays out of the way when the budget is not exceeded', async () => {
    const fake = await startFakeDaemon((req, res) => respondSse(res, HAPPY));
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000, maxRounds: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.roundCount, 1);
  });

  it('caller signal cancellation is reported as caller-cancelled', async () => {
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [
        { type: 'text', content: 'slow' },
        { type: 'done', stop_reason: 'stopped' },
      ], { chunkDelayMs: 400 }),
    );
    open.push(fake);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const r = await askChat({ message: 'hi', port: fake.port, signal: ctrl.signal });
    assert.equal(r.ok, false);
    assert.match(r.error, /atomcode turn aborted: canceled by caller/);
  });

  it('all three abort reasons carry the SAME caveat', async () => {
    // The caveat used to live in exactly one place — the `max_rounds` parameter
    // description. A turn that timed out, or one the caller cancelled, reported a
    // bare "aborted" and read as "the turn stopped", while the daemon was still
    // spending tool calls and quota on it. Same fact, one sentence, three paths.
    //
    // Asserted as ONE test over all three reasons (rather than one line added to
    // each existing test) so a fourth abort path has to answer this question
    // here instead of quietly shipping its own wording.
    //
    // v0.4.3: an abort now ALSO asks the daemon to stop the turn (`stopChat`),
    // so the sentence grew a second half describing what that achieved. What
    // this test still guards is the shared FIRST half: every abort path starts
    // from "本端已停止等待" plus its stop outcome, none ships its own wording.
    // These fixtures carry no session id, so all three land on the
    // "还没拿到 session_id" branch; the "stop landed" wording is asserted in
    // test/chat-stop.test.mjs, where a session id exists.
    const slowDaemon = async () => {
      const fake = await startFakeDaemon((req, res) =>
        respondSse(
          res,
          [
            { type: 'text', content: 'slow' },
            { type: 'done', stop_reason: 'stopped' },
          ],
          { chunkDelayMs: 400 },
        ),
      );
      open.push(fake);
      return fake;
    };

    const timedOut = await askChat({ message: 'hi', port: (await slowDaemon()).port, timeoutMs: 150 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const canceled = await askChat({ message: 'hi', port: (await slowDaemon()).port, signal: ctrl.signal });
    const fuseDaemon = await startFakeDaemon((req, res) =>
      respondSse(res, [
        { type: 'tool_start', name: 'a' },
        { type: 'tool_start', name: 'b' },
        { type: 'done', stop_reason: 'stopped' },
      ]),
    );
    open.push(fuseDaemon);
    const fused = await askChat({ message: 'hi', port: fuseDaemon.port, timeoutMs: 10_000, maxRounds: 1 });

    const shared = /（本端已停止等待/;
    for (const [which, r] of [
      ['timeout', timedOut],
      ['caller cancel', canceled],
      ['round fuse', fused],
    ]) {
      assert.equal(r.ok, false, `${which}: an aborted turn must not report ok`);
      assert.match(r.error, /atomcode turn aborted/, `${which}: the abort must be named, not a bare DOMException`);
      assert.match(r.error, shared, `${which}: must share the abort caveat, not invent one`);
      assert.match(r.error, /还没拿到 session_id/, `${which}: a turn with no id must SAY it could not be stopped`);
    }
  });

  it('streamChat yields events in order and skips keep-alive/noise lines', async () => {
    const fake = await startFakeDaemon((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive\n\n');
      res.write('event: message\n\n');
      res.write('data: {"type":"text","content":"a"}\n\n');
      res.write('data: not-json\n\n');
      res.write('data: {"type":"done","stop_reason":"stopped"}\n\n');
      res.end();
    });
    open.push(fake);
    const types = [];
    for await (const ev of streamChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 })) {
      types.push(ev.type);
    }
    assert.deepEqual(types, ['text', 'done']);
  });

  it('sends the message, approval_mode and optional fields in the JSON body', async () => {
    let seen = null;
    const fake = await startFakeDaemon((req, res, body) => {
      seen = JSON.parse(body);
      respondSse(res, [{ type: 'done', stop_reason: 'stopped' }]);
    });
    open.push(fake);
    await askChat({
      message: 'payload check',
      port: fake.port,
      approvalMode: 'bypass',
      sessionId: 'sess-xyz',
      workingDir: 'C:\\repo',
      provider: 'P',
      timeoutMs: 10_000,
    });
    assert.equal(seen.message, 'payload check');
    assert.equal(seen.approval_mode, 'bypass');
    assert.equal(seen.session_id, 'sess-xyz');
    assert.equal(seen.working_dir, 'C:\\repo');
    assert.equal(seen.provider, 'P');
  });

  /**
   * Tool attribution. `tool_result` carries no name or id, so the ONLY thing
   * tying it to a `tool_start` is ordering — and ordering is unambiguous only
   * while exactly one call is outstanding. These three cases are the whole
   * contract: serial rounds stay attributed (the shape every existing test
   * assumes), a concurrent batch must say "unknown" instead of writing every
   * result onto the last call started, and a serial round AFTER a concurrent
   * batch must be attributed again (the batch flag is per batch, not sticky).
   */
  it('attributes tool results in a SERIAL turn (each result belongs to the only open call)', async () => {
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [
        { type: 'tool_start', name: 'read' },
        { type: 'tool_result', success: true },
        { type: 'tool_start', name: 'edit' },
        { type: 'tool_result', success: false },
        { type: 'done', session_id: 's', tool_calls: 2, stop_reason: 'stopped' },
      ]),
    );
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.deepEqual(
      r.tools,
      [
        { name: 'read', success: true },
        { name: 'edit', success: false },
      ],
      'a serial turn is the case attribution actually works for',
    );
  });

  it('a CONCURRENT batch reports success:null for the whole batch rather than a fabricated false', async () => {
    // Three calls started before any result arrives — the shape an agent that
    // fans out produces. The old code wrote every result onto the LAST started
    // call, so `read` and `grep` stayed `success: false` while both succeeded:
    // a wrong fact handed to the model as a per-tool verdict, which is how
    // already-done work gets redone.
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [
        { type: 'tool_start', name: 'read' },
        { type: 'tool_start', name: 'grep' },
        { type: 'tool_start', name: 'bash' },
        { type: 'tool_result', success: true },
        { type: 'tool_result', success: true },
        { type: 'tool_result', success: true },
        { type: 'done', session_id: 's', tool_calls: 3, stop_reason: 'stopped' },
      ]),
    );
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.equal(r.roundCount, 3, 'premise: three tool_start events, so the fuse counts calls not rounds');
    assert.deepEqual(
      r.tools,
      [
        { name: 'read', success: null },
        { name: 'grep', success: null },
        { name: 'bash', success: null },
      ],
      'unknown must be distinguishable from failed: null, not false. The whole '
        + 'batch is marked, including the last one — a single attributed value '
        + 'among two unknowns would read as if attribution had worked',
    );
  });

  it('a serial round AFTER a concurrent batch is attributed again (the flag is per batch)', async () => {
    const fake = await startFakeDaemon((req, res) =>
      respondSse(res, [
        { type: 'tool_start', name: 'read' },
        { type: 'tool_start', name: 'grep' },
        { type: 'tool_result', success: true },
        { type: 'tool_result', success: true },
        { type: 'tool_start', name: 'edit' },
        { type: 'tool_result', success: false },
        { type: 'done', session_id: 's', tool_calls: 3, stop_reason: 'stopped' },
      ]),
    );
    open.push(fake);
    const r = await askChat({ message: 'hi', port: fake.port, timeoutMs: 10_000 });
    assert.deepEqual(
      r.tools,
      [
        { name: 'read', success: null },
        { name: 'grep', success: null },
        { name: 'edit', success: false },
      ],
      'once the batch drains, the next single call is unambiguous again',
    );
  });
});
