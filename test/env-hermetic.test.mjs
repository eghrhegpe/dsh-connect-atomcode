/**
 * env-hermetic.test.mjs — a suite's verdict must not depend on WHO runs it.
 *
 * THE FAILURE THIS CLOSES. This repo has already lost a full CI cycle (three
 * consecutive red runs on a released commit) to a fixture that encoded a
 * Windows-only coincidence: the assertion was green on the author's machine and
 * red on the ubuntu runner. The mirror image is worse and quieter — a test that
 * reads the DEVELOPER's real state (their `~/.dsh` session file, their
 * `~/.atomcode/config.toml`, their `DSH_PROFILE`) is red locally and GREEN in
 * CI, so CI can never catch it and the author learns to ignore it.
 *
 * Two arms, because the two halves fail independently:
 *
 *   1. RUNTIME — mount the plugin with `HOME`/`USERPROFILE` pointed at a fresh
 *      temp directory and no explicit `state_path`, then read the stats route.
 *      The plugin's state path must follow that fake home, and the mount must
 *      not create anything under the real one. This is the end-to-end statement:
 *      "the plugin derives its state location from HOME and writes nothing into
 *      the developer's real state directory just by being mounted".
 *   2. STATIC — every suite that mounts the HOST bundle must either pin
 *      `HOME`/`USERPROFILE` or pass an explicit `state_path`. Today all of them
 *      do; this is what keeps a NEW suite honest, since pinning has until now
 *      been per-suite discipline that nothing enforced.
 *
 * The static arm is deliberately file-level, not call-site-level: a call-site
 * rule ("every `apply(` needs `state_path`") reads correct code as wrong, because
 * `apply(ctx, {})` with no `tools` service returns before it ever resolves a
 * state path. A rule that cries wolf gets deleted, so this one is loose and
 * true. Comments are stripped first, so a suite that merely *mentions*
 * `lib/index.js` in prose is not swept into the scan set.
 *
 * Both arms carry a LIVENESS assert: a scan that finds nothing because it read
 * nothing is not a pass.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'lib', 'index.js');
const TEST_DIR = join(ROOT, 'test');
const mod = await import(pathToFileURL(BRIDGE).href);

const CLOSED_PORT = 45992;
const STATS_PATH = '/api/atomcode-bridge/stats';
const REAL_STATE_DIR = join(homedir(), '.dsh', 'state', 'dsh-connect-atomcode');

/** Strip line comments and block comments so prose never joins a scan set. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Does this suite mount the HOST bundle (as opposed to the client bundle)? */
function mountsHostBundle(stripped) {
  return /join\(\s*(?:__dirname|ROOT)[^)]*'lib',\s*'index\.js'/.test(stripped) || /lib\/index\.js/.test(stripped);
}

/** Mount the plugin with NO state_path and capture the stats route. */
function mountStatsRoute() {
  const routes = [];
  const ctx = {
    get: (name) => {
      if (name === 'tools') return { register: () => () => {} };
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {}; } };
      return undefined;
    },
    logger: { warn() {}, error() {}, info() {} },
    fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
    inject() {},
    effect() {},
    on() {},
  };
  // `state_path` is INTENTIONALLY absent: the default path is the thing under test.
  mod.apply(ctx, { auto_start: false, port: CLOSED_PORT });
  const route = routes.find((r) => r.path === STATS_PATH);
  assert.ok(route, `route ${STATS_PATH} must be registered`);
  return route;
}

async function readStats(route) {
  const captured = { status: 0, body: null };
  const response = {
    writeHead(status) { captured.status = status; },
    end(payload) { if (payload !== undefined) { try { captured.body = JSON.parse(payload); } catch { captured.body = null; } } },
  };
  await route.handler({ method: 'GET', headers: {} }, response);
  return captured;
}

describe('测试环境自洽 — 判定不许取决于「谁在跑」', () => {
  it('挂载后的状态路径跟着 HOME 走，且不往真实状态目录写东西', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'atomcode-hermetic-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DSH_PROFILE: process.env.DSH_PROFILE };
    const realBefore = existsSync(REAL_STATE_DIR) ? readdirSync(REAL_STATE_DIR).sort() : null;
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome; // Windows resolves the home dir from this one
      delete process.env.DSH_PROFILE; // an ambient "desktop" must not pick a profile
      const stats = await readStats(mountStatsRoute());
      assert.equal(stats.status, 200, '面板读的快照必须能取到');
      // `config.statePath` is NOT on the wire (the contract never exposed it), and
      // it should not be: the provider store path already proves the same fact,
      // because the host derives it as `dirname(statePath)/provider.json`.
      const storePath = stats.body?.provider?.storePath;
      assert.ok(typeof storePath === 'string' && storePath !== '', '快照里必须有 provider.storePath');
      assert.ok(
        storePath.startsWith(fakeHome),
        `状态/偏好路径必须落在 HOME 下（这是「换个 HOME 就跑在别处」的全部意义）：${storePath} 不在 ${fakeHome} 下`,
      );
      const realAfter = existsSync(REAL_STATE_DIR) ? readdirSync(REAL_STATE_DIR).sort() : null;
      assert.deepEqual(
        realAfter,
        realBefore,
        '一次挂载不得在真实状态目录里留下任何东西——否则每个开发者机器上的测试都在改自己的会话文件',
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('每个挂载 host 的套件都钉了 HOME/USERPROFILE，或显式传了 state_path', () => {
    const suites = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'));
    const scanners = suites.map((f) => {
      const text = readFileSync(join(TEST_DIR, f), 'utf8');
      return { name: f, stripped: withoutComments(text) };
    });
    const mounting = scanners.filter((s) => mountsHostBundle(s.stripped));
    // Liveness: the scan surface must actually contain the suites we know mount the host.
    assert.ok(
      mounting.length >= 6,
      `扫描面不对：只认出 ${mounting.length} 个挂载 host 的套件（应 ≥6）——判据本身失效时这里就会红`,
    );
    // Both sides read `stripped`. Mount detection already ignores comments; if the
    // pin check did not, a suite that only MENTIONS `process.env.HOME` in prose
    // ("we deliberately do not pin HOME because …") would be exempted from the very
    // rule this test exists to enforce — the false green it is here to catch.
    const unpinned = mounting
      .filter((s) => !/process\.env\.(HOME|USERPROFILE)/.test(s.stripped) && !/state_path|statePath/.test(s.stripped))
      .map((s) => `test/${s.name}`);
    assert.deepEqual(
      unpinned,
      [],
      '挂载 host 的套件必须钉住 HOME/USERPROFILE（见 wiring.test.mjs 的做法），或给 apply() 显式传 state_path——' +
        '否则它会读写开发者的真实 ~/.dsh 状态，在 CI 上却是绿的：' +
        unpinned.join(', '),
    );
    // The predicate itself must be able to say "no" — a planted sample proves it.
    assert.equal(mountsHostBundle(withoutComments(`const B = join(ROOT, 'lib', 'index.js');`)), true);
    assert.equal(mountsHostBundle(withoutComments(`// mentions lib/index.js in prose only`)), false);
  });
});
