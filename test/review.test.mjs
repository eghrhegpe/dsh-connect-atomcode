/**
 * review.test.mjs — unit tests for the `atomcode review` CLI wrapper.
 * No binary needed: the spawner is a seam (`setSpawnOverride`), so argument
 * construction, temp-diff handling, JSON capture and failure mapping are
 * asserted against fake child processes.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildReviewArgs,
  resolveBinary,
  runReview,
  setSpawnOverride,
  cleanupTempFiles,
  OUTPUT_CAP_BYTES,
} from '../lib/review.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

class FakeChild {
  constructor({ stdout = '', stderr = '', code = 0, stderrAsError = false } = {}) {
    this.stdout = { on(event, cb) { if (event === 'data' && stdout) cb(stdout); } };
    this.stderr = { on(event, cb) { if (event === 'data' && stderr) cb(stderr); } };
    this.code = code;
    this.emitted = false;
    this.killed = false;
    this.on = (event, cb) => {
      if (event === 'exit' && !stderrAsError && !this.emitted) {
        this.emitted = true;
        setImmediate(() => cb(code));
      } else if (event === 'error' && stderrAsError && !this.emitted) {
        this.emitted = true;
        setImmediate(() => cb(new Error('spawn atomcode.exe ENOENT')));
      }
    };
    this.kill = (sig) => {
      this.killed = true;
      this.killedSignal = sig;
    };
  }
}

describe('review.js — argument construction', () => {
  it('task mode skips diff selection', () => {
    const { argv } = buildReviewArgs({ task: 'explain this module' });
    assert.deepEqual(argv.slice(0, 3), ['review', '--task', 'explain this module']);
    for (const flag of ['--base', '--staged', '--pr', '--diff-file']) assert.ok(!argv.includes(flag));
  });

  it('diff-text mode writes a temp file and passes --diff-file', () => {
    const { argv, tempFiles } = buildReviewArgs({ diffText: 'diff --git a/x b/x\n+1' });
    const idx = argv.indexOf('--diff-file');
    assert.ok(idx >= 0);
    const file = argv[idx + 1];
    assert.ok(existsSync(file), 'temp diff file must exist for the run');
    assert.equal(readFileSync(file, 'utf8'), 'diff --git a/x b/x\n+1');
    assert.equal(tempFiles.length, 1);
    cleanupTempFiles(tempFiles);
    assert.ok(!existsSync(file), 'temp file is cleaned up');
  });

  it('selection precedence: diff_text > pr > staged > base', () => {
    assert.ok(buildReviewArgs({ diffText: 'd', pr: 7, staged: true, base: 'main' }).argv.includes('--diff-file'));
    assert.ok(buildReviewArgs({ pr: 7, staged: true, base: 'main' }).argv.includes('--pr'));
    assert.ok(buildReviewArgs({ staged: true, base: 'main' }).argv.includes('--staged'));
    assert.ok(buildReviewArgs({ base: 'main' }).argv.includes('--base'));
  });

  it('fuses and no-web defaults are always present', () => {
    const { argv } = buildReviewArgs({});
    assert.ok(argv.includes('--json'));
    assert.ok(argv.includes('--no-telemetry'));
    assert.ok(argv.includes('--max-rounds') && argv[argv.indexOf('--max-rounds') + 1] === '35');
    assert.ok(argv.includes('--max-duration') && argv[argv.indexOf('--max-duration') + 1] === '900');
    assert.ok(argv.includes('--no-web'));
    const withWeb = buildReviewArgs({ noWeb: false });
    assert.ok(!withWeb.argv.includes('--no-web'));
  });

  it('a negative or non-finite fuse never reaches the CLI verbatim', () => {
    // `--max-rounds -5` / `--max-duration 0` would be the CLI's guess to
    // interpret. NOTE 0 is deliberately NOT in this list any more: it is an
    // explicit "no round fuse" (see the next test), while -0.5 / NaN / null and
    // friends are values that cannot BE a round count.
    for (const bad of [-5, -0.5, NaN, Infinity, -Infinity, null, undefined, '12']) {
      const { argv } = buildReviewArgs({ maxRounds: bad, maxDurationSecs: bad });
      assert.equal(argv[argv.indexOf('--max-rounds') + 1], '35', `maxRounds=${String(bad)} must fall back to 35`);
      assert.equal(argv[argv.indexOf('--max-duration') + 1], '900', `maxDurationSecs=${String(bad)} must fall back to 900`);
    }
  });

  it('maxRounds: 0 means NO round fuse — the flag is omitted, not sent as 0', () => {
    // The trap this replaces: 0 used to be read as "unset -> use 35", so a caller
    // who had learned from `atomcode_ask` that 0 disarms the fuse got a 35-round
    // cap instead and was never told. The CLI documents `--max-rounds` as
    // UNLIMITED when absent (docs/AtomCode-CLI与daemon接口参考.md), so omitting the
    // flag is the honest way to say it — forwarding a literal 0 would abort the
    // review immediately, which is why the old comment believed 0 was impossible.
    const { argv } = buildReviewArgs({ maxRounds: 0 });
    assert.ok(!argv.includes('--max-rounds'), 'a disarmed round fuse must not be spelled at all');
    // The wall-clock fuse is a SEPARATE knob: "no round cap" is not "no limit".
    assert.equal(argv[argv.indexOf('--max-duration') + 1], '900');
    // …and an explicit 0 must not leak into the other fuse either.
    const both = buildReviewArgs({ maxRounds: 0, maxDurationSecs: 300 });
    assert.ok(!both.argv.includes('--max-rounds'));
    assert.equal(both.argv[both.argv.indexOf('--max-duration') + 1], '300');
  });

  it('positive fuses are forwarded, floored to whole seconds/rounds', () => {
    const { argv } = buildReviewArgs({ maxRounds: 12.7, maxDurationSecs: 300.9 });
    assert.equal(argv[argv.indexOf('--max-rounds') + 1], '12');
    assert.equal(argv[argv.indexOf('--max-duration') + 1], '300');
  });

  it('working_dir and provider map to --repo / --provider', () => {
    const { argv } = buildReviewArgs({ workingDir: 'C:\\code\\repo', provider: 'AtomGit-glm5.3-flash' });
    assert.ok(argv.includes('--repo'));
    assert.ok(argv.includes('C:\\code\\repo'));
    assert.ok(argv.includes('--provider'));
    assert.ok(argv.includes('AtomGit-glm5.3-flash'));
  });

  it('resolveBinary precedence: config > env > platform default', () => {
    assert.equal(resolveBinary('D:\\bin\\atomcode.exe'), 'D:\\bin\\atomcode.exe');
    const saved = process.env.ATOMCODE_BIN;
    try {
      process.env.ATOMCODE_BIN = 'C:\\elsewhere\\atomcode.exe';
      assert.equal(resolveBinary(''), 'C:\\elsewhere\\atomcode.exe');
      process.env.ATOMCODE_BIN = '';
      assert.equal(resolveBinary(''), process.platform === 'win32' ? 'atomcode.exe' : 'atomcode');
    } finally {
      if (saved === undefined) delete process.env.ATOMCODE_BIN;
      else process.env.ATOMCODE_BIN = saved;
    }
  });
});

describe('review.js — run outcomes', () => {
  before(() => setSpawnOverride((bin, args, opts) => new FakeChild({})));
  after(() => setSpawnOverride(null));

  it('exit 0 with stdout → ok:true, report captured', async () => {
    setSpawnOverride(() => new FakeChild({ stdout: '{"findings":[]}' }));
    const r = await runReview({ task: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.report, '{"findings":[]}');
    assert.equal(r.exitCode, 0);
    assert.equal(r.error, '');
  });

  it('non-zero exit → ok:false with stderr detail', async () => {
    setSpawnOverride(() => new FakeChild({ code: 2, stderr: 'git: not a repository' }));
    const r = await runReview({ task: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /exited 2/);
    assert.match(r.error, /not a repository/);
  });

  it('spawn error (ENOENT) → ok:false, exitCode -1', async () => {
    setSpawnOverride(() => new FakeChild({ stderrAsError: true }));
    const r = await runReview({ task: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, -1);
  });

  it('empty output on exit 0 → ok:false ("no output")', async () => {
    setSpawnOverride(() => new FakeChild({ stdout: '   ' }));
    const r = await runReview({ task: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /no output/);
  });

  it('a runaway stdout is named as a corrupt document, never returned as findings', async () => {
    // `--json` means stdout IS the findings document, so a clipped stream is a
    // corrupt one. The failure mode this guards is the quiet one: a TRUNCATED
    // findings list still parses, and reads to the model as a clean review.
    setSpawnOverride(() => new FakeChild({ stdout: Buffer.alloc(OUTPUT_CAP_BYTES + 1, 0x78) }));
    const r = await runReview({ task: 'x' });
    assert.equal(r.ok, false, 'a clipped --json document must not be reported as a result');
    assert.match(r.error, /cut off/);
    assert.match(r.error, /incomplete/);
    assert.equal(r.exitCode, 0, 'the exit code is still reported as what it was');
  });

  it('an ordinary 1 MB findings document is NOT clipped', async () => {
    // The counter-case: a cap that fires on real work would be worse than none.
    const payload = `{"findings":[${'"x",'.repeat(250000)}]}`;
    assert.ok(payload.length > 1_000_000 && payload.length < OUTPUT_CAP_BYTES);
    setSpawnOverride(() => new FakeChild({ stdout: payload }));
    const r = await runReview({ task: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.report.length, payload.length);
  });

  it('a multi-byte character split across two pipe reads survives decoding', async () => {
    // A pipe hands over arbitrary byte boundaries and a Chinese character is 3
    // bytes, so a read can land mid-character. Decoding each chunk on its own
    // (`buffer.toString('utf8')`) emits U+FFFD for it — a findings document that
    // still parses and is now WRONG, which is the same silent-corruption class
    // OUTPUT_CAP_BYTES refuses to return. The assertion is byte-faithfulness, not
    // just "no crash".
    const text = '评审：改动无问题，可以合并。';
    const bytes = Buffer.from(text, 'utf8');
    const cut = bytes.indexOf(Buffer.from('评', 'utf8')) + 1;
    assert.ok(cut > 0 && cut < bytes.length, 'the split must land inside a character');
    setSpawnOverride(() => {
      const c = new FakeChild({});
      c.stdout = {
        on(event, cb) {
          if (event !== 'data') return;
          cb(bytes.subarray(0, cut));
          cb(bytes.subarray(cut));
        },
      };
      return c;
    });
    const r = await runReview({ task: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.report, text, 'the document must come back byte-faithful');
    assert.ok(!r.report.includes('\uFFFD'), 'no replacement character may be substituted');
  });

  it('missing-base-URL failure carries the actionable provider hint', async () => {
    setSpawnOverride(
      () =>
        new FakeChild({
          code: 1,
          stderr: 'AtomCode error: missing base URL: pass --base-url, set $ATOMCODE_BASE_URL, or add base_url to the config provider',
        }),
    );
    const r = await runReview({ task: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /missing base URL/);
    assert.match(r.error, /default_provider/);
    assert.match(r.error, /\[providers\.<name>\]/);
  });

  it('a synchronous spawn throw is structured and leaks no temp diff file', async () => {
    // buildReviewArgs has already written the diff to a temp dir by the time the
    // spawner runs, so a throwing spawn must clean up before returning.
    let tempDir = null;
    setSpawnOverride((bin, args) => {
      const i = args.indexOf('--diff-file');
      tempDir = i >= 0 ? dirname(args[i + 1]) : null;
      throw new Error('spawn EINVAL (simulated)');
    });
    const r = await runReview({ diffText: 'diff --git a/x b/x\n+1' });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, -1);
    assert.match(r.error, /spawn failed/);
    assert.ok(tempDir, 'the temp diff dir should have existed before the throw');
    assert.equal(existsSync(tempDir), false, 'temp dir must be cleaned up when spawn throws synchronously');
  });

  it('the wall-clock backstop kills a stalled process and names the timeout', async () => {
    // The plugin passes timeoutMs, so this fuse is live on the real path: a run
    // that ignores its own --max-duration must not hang the bridge forever, and
    // must not surface as a bare signal exit code.
    setSpawnOverride(() => {
      const c = new FakeChild({ stdout: 'partial findings' });
      let exitCb;
      c.on = (event, cb) => {
        if (event === 'exit') exitCb = cb; // never auto-emitted: the run stalls
      };
      c.kill = () => {
        if (exitCb) setImmediate(() => exitCb(null));
      };
      return c;
    });
    const r = await runReview({ task: 'x', timeoutMs: 60 });
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out after 60ms/);
    assert.equal(r.report, 'partial findings', 'partial output is still handed back');
  });

  it('caller abort kills the child and reports canceled', async () => {
    const makeHangingChild = () => {
      const c = new FakeChild({ stdout: 'partial' });
      let exitCb;
      c.on = (event, cb) => {
        if (event === 'exit') exitCb = cb; // captured but never auto-emitted
      };
      c.kill = (sig) => {
        c.killed = true;
        c.killedSignal = sig;
        if (exitCb) setImmediate(() => exitCb(137));
      };
      return c;
    };
    setSpawnOverride(() => makeHangingChild());
    const ctrl = new AbortController();
    const p = runReview({ task: 'x', signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.error, /canceled/);
  });
});

describe('atomcode_review — the round fuse reaches the child the way the ask tool means it', () => {
  // The end-to-end half of the `max_rounds: 0` fix. `buildReviewArgs`'s own test
  // proves the argv SPELLING; this one proves the TOOL did not swallow the 0 into
  // the configured default first — which is exactly what the old predicate did,
  // and what no unit test on either side of that boundary could see. The spawn
  // seam is the observation point: the argv the child is handed is the end of the
  // chain (tool → runReview → buildReviewArgs → spawn).
  let review;
  let savedHome;
  let savedUserProfile;
  let savedProfile;
  const dirs = [];

  before(async () => {
    const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
    const home = mkdtempSync(join(tmpdir(), 'atomcode-fuse-home-'));
    const statePath = join(mkdtempSync(join(tmpdir(), 'atomcode-fuse-state-')), 'sessions.json');
    dirs.push(home, dirname(statePath));
    mkdirSync(join(home, '.atomcode'), { recursive: true });
    // A direct provider with a NON-loopback base_url: `selectReviewProvider` picks
    // it and no local-endpoint probe is attempted, so the call reaches the spawn
    // in the same tick.
    writeFileSync(
      join(home, '.atomcode', 'config.toml'),
      ['[providers.direct]', 'base_url = "https://some-llm.test/v1"', 'api_key = "sk-test"'].join('\n'),
      'utf8',
    );
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedProfile = process.env.DSH_PROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.DSH_PROFILE;
    const tools = [];
    const ctx = {
      get: (name) => {
        if (name === 'tools') return { register: (d) => { tools.push(d); return () => {}; } };
        if (name === 'webServer') return { register: () => () => {} };
        return undefined;
      },
      logger: { warn() {}, error() {}, info() {} },
      fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
      inject() {},
      effect() {},
      on() {},
    };
    mod.apply(ctx, { auto_start: false, port: 45995, state_path: statePath });
    review = tools.find((t) => t.name === 'atomcode_review');
    assert.ok(review, 'the review tool must be registered');
  });

  after(() => {
    setSpawnOverride(null);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    if (savedProfile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = savedProfile;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** Run one tool call against a child that records the argv it was given. */
  async function runTool(args) {
    const seen = [];
    setSpawnOverride((bin, argv) => {
      seen.push({ bin, argv });
      return new FakeChild({ stdout: '{"findings":[]}' });
    });
    try {
      const repo = mkdtempSync(join(tmpdir(), 'atomcode-fuse-repo-'));
      try {
        const r = await review.execute({ task: 'x', working_dir: repo, ...args }, {});
        assert.ok(seen.length === 1, `the CLI must have been spawned once (got ${seen.length})`);
        assert.equal(r.ok, true, `precondition: the fake child must succeed; error=${r.error}`);
        return seen[0].argv;
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    } finally {
      setSpawnOverride(null);
    }
  }

  it('max_rounds: 0 omits --max-rounds entirely (the CLI then applies its own UNLIMITED)', async () => {
    const argv = await runTool({ max_rounds: 0 });
    assert.ok(
      !argv.includes('--max-rounds'),
      'a disarmed round fuse must not arrive as "--max-rounds 35" — that is the silent 35 the caller never asked for',
    );
    assert.ok(argv.includes('--max-duration'), 'the wall-clock fuse is a separate knob and stays armed');
  });

  it('a positive max_rounds is forwarded unchanged', async () => {
    const argv = await runTool({ max_rounds: 7 });
    assert.equal(argv[argv.indexOf('--max-rounds') + 1], '7');
  });
});
