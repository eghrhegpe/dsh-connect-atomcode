/**
 * chat-stop.test.mjs — hermetic coverage for the /chat/stop cancel path.
 *
 * Same shape as daemon-stream.test.mjs: a local node:http server speaks the
 * daemon's vocabulary on an ephemeral port, so what the PLUGIN does when a turn
 * dies early (fuse, cancel, truncation) is asserted without a daemon — and,
 * crucially, what it does on a turn that finished normally (must not touch it)
 * is asserted too.
 *
 * The contract asserted here was measured against a live daemon 5.2.3 by
 * scripts/probes/chat-stop.mjs (session_id required → 422; unknown id → 200
 * "was not running"). The server below replays those two shapes verbatim.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, before, after } from 'node:test';
import {
  askChat,
  appendStopOutcome,
  stopChat,
  STOP_COMMAND_TIMEOUT_MS,
} from '../lib/daemon.js';

/** Build an SSE body from a list of event objects. */
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/**
 * Start a fake daemon that records every /chat/stop request.
 *
 * @param {(req, res, body) => void} handler - answers the /chat stream.
 * @param {{stopStatus?: number, stopMessage?: string}} [stopShape]
 */
async function startFakeDaemon(handler, stopShape = {}) {
  const stops = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = (req.url || '').split('?')[0];
      if (url === '/chat/stop') {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* keep null */ }
        stops.push({ body: parsed, raw: body });
        res.writeHead(stopShape.stopStatus ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: stopShape.stopStatus === 500 ? false : true, message: stopShape.stopMessage ?? 'stopped' }));
        return;
      }
      try {
        handler(req, res, body);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, stops };
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

const HEAD = [{ type: 'runtime_info', provider: 'Fake-A', model: 'fake' }];

describe('stopChat', () => {
  let server;
  let port;
  before(async () => {
    const f = await startFakeDaemon((req, res) => {
      respondSse(res, []);
    });
    server = f.server;
    port = f.port;
  });
  after(() => server.close());

  it('refuses to invent a target when no session id is known (never sends)', async () => {
    const out = await stopChat({ port, sessionId: '' });
    assert.equal(out.sent, false);
    assert.equal(out.ok, false);
    assert.match(out.message, /no session id/);
  });

  it('posts session_id and reports the daemon answer verbatim', async () => {
    const out = await stopChat({ port, sessionId: 'sess-abc' });
    assert.equal(out.sent, true);
    assert.equal(out.ok, true);
    assert.equal(out.message, 'stopped');
  });

  it('treats "was not running" as an answer, not a failure', async () => {
    const f = await startFakeDaemon((req, res) => respondSse(res, []), {
      stopMessage: 'Chat session probe-nonexistent-xyz was not running',
    });
    try {
      const out = await stopChat({ port: f.port, sessionId: 'probe-nonexistent-xyz' });
      assert.equal(out.ok, true, 'the daemon processed the request; the turn just was not running');
      assert.match(out.message, /was not running/);
      assert.equal(f.stops.length, 1);
      assert.equal(f.stops[0].body.session_id, 'probe-nonexistent-xyz');
    } finally {
      f.server.close();
    }
  });

  it('names a non-2xx answer instead of throwing', async () => {
    const f = await startFakeDaemon((req, res) => respondSse(res, []), { stopStatus: 500 });
    try {
      const out = await stopChat({ port: f.port, sessionId: 'sess-500' });
      assert.equal(out.ok, false);
      assert.equal(out.sent, true);
      assert.match(out.message, /HTTP 500/);
    } finally {
      f.server.close();
    }
  });

  it('has a named budget', () => {
    assert.equal(STOP_COMMAND_TIMEOUT_MS, 1500);
  });
});

describe('appendStopOutcome', () => {
  it('names the no-id case as its own state, not as a failure', () => {
    const out = appendStopOutcome('atomcode turn aborted: timeout', { ok: false, sent: false, message: 'x' });
    assert.match(out, /还没拿到 session_id/);
    assert.match(out, /daemon 侧可能仍在继续跑/);
  });

  it('quotes the daemon answer when the request landed', () => {
    const out = appendStopOutcome('boom', { ok: true, sent: true, message: 'stopped' });
    assert.equal(out, 'boom（已请求 daemon 停止该回合：/chat/stop 已应答 — stopped）');
  });

  it('names the failed request and still warns about the daemon side', () => {
    const out = appendStopOutcome('boom', { ok: false, sent: true, message: 'ECONNREFUSED' });
    assert.match(out, /未成功：ECONNREFUSED/);
    assert.match(out, /可能仍在继续跑/);
  });
});

describe('askChat asks the daemon to stop a cut turn', () => {
  let server;
  let port;
  let stops;
  before(async () => {
    const f = await startFakeDaemon((req, res) => {
      // A stream that is still flowing when the fuse/cancel lands: two
      // tool_start events (the second trips maxRounds:1) and enough padding
      // that a 40ms-later abort arrives mid-stream, not after the end.
      respondSse(res, [
        ...HEAD,
        { type: 'session_assigned', session_id: 'sess-cut' },
        { type: 'text', content: 'partial' },
        { type: 'tool_start', name: 'read' },
        { type: 'text', content: 'more' },
        { type: 'tool_start', name: 'write' },
        { type: 'text', content: 'tail' },
      ], { chunkDelayMs: 60 });
    });
    server = f.server;
    port = f.port;
    stops = f.stops;
  });
  after(() => server.close());

  it('round fuse fires → /chat/stop carries the session id, error says it landed', async () => {
    const before = stops.length;
    const result = await askChat({
      message: 'go',
      port,
      maxRounds: 1,
      timeoutMs: 10_000,
    });
    assert.equal(result.ok, false, 'the fuse must fail the turn');
    assert.match(result.error, /round fuse/);
    assert.equal(stops.length, before + 1, 'one stop request');
    assert.equal(stops[stops.length - 1].body.session_id, 'sess-cut');
    assert.match(result.error, /已请求 daemon 停止该回合：\/chat\/stop 已应答/);
  });

  it('caller cancel fires → /chat/stop carries the session id', async () => {
    const ctrl = new AbortController();
    const promise = askChat({ message: 'go', port, signal: ctrl.signal, timeoutMs: 10_000 });
    setTimeout(() => ctrl.abort(), 40);
    const result = await promise;
    assert.equal(result.ok, false);
    assert.match(result.error, /canceled by caller/);
    assert.equal(stops[stops.length - 1].body.session_id, 'sess-cut');
  });
});

describe('a finished turn is left alone', () => {
  let server;
  let stops;
  before(async () => {
    const f = await startFakeDaemon((req, res) => {
      respondSse(res, [
        ...HEAD,
        { type: 'session_assigned', session_id: 'sess-done' },
        { type: 'text', content: 'hello' },
        { type: 'done', tokens: 7, tool_calls: 0, session_id: 'sess-done', stop_reason: 'stop' },
      ]);
    });
    server = f.server;
    stops = f.stops;
  });
  after(() => server.close());

  it('does not post /chat/stop when the turn completed', async () => {
    const result = await askChat({ message: 'go', port: server.address().port, timeoutMs: 10_000 });
    assert.equal(result.ok, true);
    assert.equal(result.reply, 'hello');
    assert.equal(stops.length, 0, 'a finished turn must not be touched');
    assert.equal(result.error, '');
  });
});

describe('stream cut before any session id existed', () => {
  let server;
  let stops;
  before(async () => {
    const f = await startFakeDaemon((req, res) => {
      respondSse(res, [HEAD], { chunkDelayMs: 120 });
    });
    server = f.server;
    stops = f.stops;
  });
  after(() => server.close());

  it('says so instead of guessing a target', async () => {
    const result = await askChat({ message: 'go', port: server.address().port, timeoutMs: 300 });
    assert.equal(result.ok, false);
    assert.equal(stops.length, 0, 'nothing was sent');
    assert.match(result.error, /还没拿到 session_id/);
  });

  it('uses the resumed session id when the caller named one', async () => {
    const ctrl = new AbortController();
    const promise = askChat({
      message: 'go',
      port: server.address().port,
      sessionId: 'sess-resumed',
      signal: ctrl.signal,
      timeoutMs: 10_000,
    });
    setTimeout(() => ctrl.abort(), 60);
    await promise;
    assert.equal(stops.length, 1);
    assert.equal(stops[0].body.session_id, 'sess-resumed', 'continue: turns can be stopped by their resumed id');
  });
});

describe('a stop request that fails is named, not swallowed', () => {
  let server;
  after(() => server?.close());

  it('surfaces the failure inside the turn error', async () => {
    const f = await startFakeDaemon((req, res) => {
      respondSse(res, [
        ...HEAD,
        { type: 'session_assigned', session_id: 'sess-fail' },
        { type: 'text', content: 'partial' },
      ]);
    }, { stopStatus: 500 });
    server = f.server;
    const result = await askChat({ message: 'go', port: f.port, timeoutMs: 300 });
    assert.equal(result.ok, false);
    assert.match(result.error, /未成功：\/chat\/stop -> HTTP 500/);
    assert.match(result.error, /daemon 侧可能仍在继续跑/);
  });
});
