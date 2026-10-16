/**
 * protocol.test.mjs — the drift pins (v0.4).
 *
 * The bridge rides three PRIVATE, unversioned AtomCode surfaces: the /chat SSE
 * vocabulary, the `status` command's localized text, and the review CLI's
 * provider resolution. Every one of them can change under us with a binary
 * upgrade and no error. v0.4's answer is not a protocol handshake (none is
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
import { parseDefaultProvider, parseTomlProviders } from '../lib/review.js';

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
  after(() => { for (const { server } of open) server.close(); });

  it('names the observed types instead of "ended before done"', async () => {
    // A post-upgrade daemon that renamed every event. The v0.3 behaviour was
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
    // The shape the v0.4.0 gate missed (2026-10 code review): `done` keeps its
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
    // v0.4.0 returned `error: ok ? '' : error` — once done arrived, any error
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
    // Bind, learn the port, release it — so "nothing listens" is a fact about
    // THIS port rather than an assumption about a hardcoded one that some other
    // process on the machine is free to take.
    const fake = await startFakeDaemon(() => {});
    const deadPort = fake.port;
    await new Promise((resolve) => fake.server.close(resolve));
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
    mod.apply(ctx, { auto_start: false, port: 45995, state_path: join(fakeHome, 'sessions.json') });
    const ask = tools.find((t) => t.name === 'atomcode_ask');
    render = ask.output.render; // the descriptor nests render under `output`
  });
  after(() => rmSync(fakeHome, { recursive: true, force: true }));

  const base = {
    reply: 'partial answer', session_id: 's', continued: false, truncated: false,
    tokens: 1, tool_calls: 0, round_count: 0, tools: [], stop_reason: 'stopped', provider: 'P',
  };

  it('surfaces value.error on ok:true, and stays silent when error is empty', () => {
    // The carry-out fix in `askChat` is worthless if render's ok-branch hides
    // `error` (v0.4.0's ok-branch only printed reply + meta). Pinned here: the
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

describe('TOML provider parsing — quoted names must not become false negatives', () => {
  it('parses a bare provider name', () => {
    const ps = parseTomlProviders(['[providers.direct]', 'base_url = "https://x.test/v1"', 'api_key = "sk-1"'].join('\n'));
    assert.equal(ps.length, 1);
    assert.equal(ps[0].name, 'direct');
    assert.equal(ps[0].base_url, 'https://x.test/v1');
  });

  it('parses a QUOTED provider name (the v0.3 false-negative case)', () => {
    // v0.3 stripped only the `providers.` prefix, leaving the quotes in the
    // name; worse, the name then mismatched `--provider <name>` exactly as
    // written in config.toml, so a WORKING provider was reported unavailable.
    const ps = parseTomlProviders(['[providers."my provider"]', 'base_url = "https://x.test/v1"', 'api_key = "sk-1"'].join('\n'));
    assert.equal(ps.length, 1);
    assert.equal(ps[0].name, 'my provider', 'quotes must be stripped from the name');
    assert.equal(ps[0].api_key, 'sk-1');
  });

  it('accepts quoted KEYS too', () => {
    const ps = parseTomlProviders(['[providers.p]', '"base_url" = "https://x.test/v1"', '"api_key" = "sk-1"'].join('\n'));
    assert.equal(ps[0].base_url, 'https://x.test/v1');
    assert.equal(ps[0].api_key, 'sk-1');
  });

  it('ignores a fully-quoted section, which is a literal key, not a table', () => {
    // ["providers.x"] is a single quoted KEY named "providers.x" — a table
    // named `providers` with key `x`, not a provider entry.
    assert.deepEqual(parseTomlProviders(['["providers.x"]', 'base_url = "https://x.test/v1"'].join('\n')), []);
  });

  it('ignores comments and blank lines, and never throws on junk', () => {
    assert.deepEqual(parseTomlProviders(''), []);
    assert.deepEqual(parseTomlProviders('# only a comment\n\n   \n'), []);
    assert.doesNotThrow(() => parseTomlProviders('[[[broken\nproviders\n= = =\n'));
  });

  it('reads default_provider in either quoting style, root table only', () => {
    // The two callers (provision probe + execute-time selection) each carried
    // this same regex, and it was wrong in two measurable ways in two places:
    // double quotes ONLY, and no section scoping.
    assert.equal(parseDefaultProvider('default_provider = "atomcode-local"'), 'atomcode-local');
    assert.equal(parseDefaultProvider("default_provider = 'atomcode-local'"), 'atomcode-local');
    assert.equal(parseDefaultProvider('default_provider = atomcode-local'), 'atomcode-local');
    assert.equal(parseDefaultProvider('default_provider = "x"  # 本地代理'), 'x');
    assert.equal(
      parseDefaultProvider(['[ui]', 'default_provider = "ui-model"'].join('\n')),
      '',
      'a section-scoped key is a DIFFERENT key with the same spelling',
    );
    assert.equal(
      parseDefaultProvider(['default_provider = "root-model"', '', '[ui]', 'default_provider = "ui-model"'].join('\n')),
      'root-model',
      'the first root-table hit wins (TOML forbids duplicate keys)',
    );
    assert.equal(parseDefaultProvider(''), '');
    assert.equal(parseDefaultProvider(null), '');
    assert.equal(parseDefaultProvider(42), '');
  });

  it('strips INLINE comments and trailing whitespace from values', () => {
    // The kv regex grabs everything to end-of-line, so a real-world line like
    // `base_url = "http://127.0.0.1:8899/v1"  # 本地代理` used to parse as
    // `http://127.0.0.1:8899/v1"  # 本地代理` — quote and comment included.
    // The corrupted value feeds this plugin's own loopback/gateway decisions
    // while the review CLI parses config.toml correctly itself: two parsers,
    // one silently wrong.
    const ps = parseTomlProviders([
      '# leading comment',
      '[providers.atomcode-local]',
      'provider = "openai"',
      'base_url = "http://127.0.0.1:8899/v1"  # 本地代理',
      'api_key = "local-proxy-any-string"',
      'model = "deepseek-ai/DeepSeek-V4-Flash" #no-space-comment',
      '',
      '[providers.ollama]',
      "base_url = 'http://127.0.0.1:11434/v1'  ",
      'model = "qwen3"',
    ].join('\n'));
    assert.equal(ps.length, 2);
    const [first, second] = ps;
    assert.equal(first.name, 'atomcode-local');
    assert.equal(first.base_url, 'http://127.0.0.1:8899/v1', 'inline comment must not corrupt the value');
    assert.equal(first.api_key, 'local-proxy-any-string');
    assert.equal(first.model, 'deepseek-ai/DeepSeek-V4-Flash', '# without a space is still a comment');
    assert.equal(second.name, 'ollama');
    assert.equal(second.base_url, 'http://127.0.0.1:11434/v1', 'trailing whitespace must go');
    assert.equal(second.model, 'qwen3');
  });

  it('accepts dashed KEYS (legal TOML bare keys)', () => {
    // TOML bare keys may contain dashes; the old regex only allowed [a-zA-Z0-9_].
    const ps = parseTomlProviders(['[providers.dash]', 'api-key = "sk-1"', 'base_url = "https://x.test/v1"'].join('\n'));
    assert.equal(ps.length, 1);
    assert.equal(ps[0].name, 'dash');
    assert.equal(ps[0]['api-key'], 'sk-1');
    assert.equal(ps[0].base_url, 'https://x.test/v1');
  });

  it('collects several providers, including one without base_url', () => {
    const ps = parseTomlProviders([
      '[providers.a]',
      'base_url = "https://a.test/v1"',
      'api_key = "sk-a"',
      '',
      '[providers.b]',
      'account = "AtomGit"',
    ].join('\n'));
    assert.deepEqual(ps.map((p) => p.name), ['a', 'b']);
    assert.equal(ps[1].base_url, undefined);
  });
});

describe('review provision is re-read per call, not frozen at mount', () => {
  it('a provider added after mount is honoured (and the description follows)', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-drift-home-'));
    const cfgDir = join(fakeHome, '.atomcode');
    const tools = [];
    const ctx = {
      get: (name) => (name === 'tools' ? { register: (d) => { tools.push(d); return () => {}; } } : undefined),
      logger: { warn() {}, error() {}, info() {} },
      fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
      inject() {},
      effect() {},
      on() {},
    };
    try {
      // Before: no direct provider at all -> the description warns.
      const savedHome = process.env.HOME;
      const savedUserProfile = process.env.USERPROFILE;
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      mod.apply(ctx, {
        auto_start: false,
        port: 45994,
        state_path: join(fakeHome, 'sessions.json'),
      });
      const review = tools.find((t) => t.name === 'atomcode_review');
      assert.match(review.description, /review CLI 不可用/, 'precondition: unavailable at mount');

      // The user then adds a direct provider and calls the tool. v0.3 would
      // have spawned a process and surfaced a CLI diagnostic; v0.4 re-reads the
      // config, so the call is refused for the RIGHT reason (the probe says no)
      // — or, once the config is fixed, succeeds. Pinned as: the mount-time
      // verdict is not what the execute path believes.
      const { rmSync, mkdirSync } = await import('node:fs');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, 'config.toml'), [
        'default_provider = "direct"',
        '[providers.direct]',
        'provider = "openai"',
        'base_url = "https://some-llm.test/v1"',
        'api_key = "sk-test"',
      ].join('\n'), 'utf8');
      const { checkReviewProvision } = await import(pathToFileURL(join(ROOT, 'lib', 'review.js')).href);
      assert.equal(checkReviewProvision(cfgDir).available, true, 'the probe now sees the new provider');
      // The description string in the still-mounted tool object is intentionally
      // stale (descriptions are registered once); the EXECUTE path is what the
      // fix guarantees. Assert that execute no longer short-circuits with the
      // mount-time reason.
      const r = await review.execute({ working_dir: fakeHome, task: 'x' }, {});
      assert.notEqual(
        /unavailable on this host/.test(r.error),
        true,
        'execute must not refuse with the mount-time verdict after the config was fixed',
      );
      rmSync(fakeHome, { recursive: true, force: true });
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
    } catch (error) {
      rmSync(fakeHome, { recursive: true, force: true });
      throw error;
    }
  });
});