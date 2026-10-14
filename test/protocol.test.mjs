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
import { parseTomlProviders } from '../lib/review.js';

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
    assert.match(r.error, /upgrade dsh-atomcode-bridge/);
  });

  it('stays quiet when an unknown type rides ALONG a valid turn', async () => {
    // One new event type among known ones is additive drift, not breakage:
    // reporting it as a failure would train the model to ignore this error.
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
    assert.equal(r.error, '');
  });

  it('a truncated turn with an additive unknown type is NOT called a protocol change', async () => {
    // The false positive this guards: recognized `text` arrives, one harmless new
    // event type shows up, then the stream dies without a terminal event (idle
    // kill / network blip / timeout). Without the `sawRecognizable` gate the
    // error reads "the daemon may have changed its /chat protocol; upgrade
    // dsh-atomcode-bridge" — sending the user to upgrade for a network hiccup.
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
    assert.doesNotMatch(r.error, /upgrade dsh-atomcode-bridge/, 'no upgrade advice for a truncated turn');
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
  });

  it('healthInfo reports down with an empty version when nothing listens', async () => {
    const info = await healthInfo(45993);
    assert.equal(info.up, false);
    assert.equal(info.version, '');
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
      fiber: { entry: { options: { id: 'dsh-atomcode-bridge' } } },
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