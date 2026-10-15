/**
 * build-gate.test.mjs — the artifact must never drift from its sources.
 *
 * `client.js` (and, in the host phase, `lib/`) is a COMMITTED BUILD OUTPUT, not a
 * source. It has to be committed because pnpm refuses to run build scripts for git
 * dependencies (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), so a GitHub-direct install
 * gets no `prepare` step — see the header of `tsdown.config.mjs`.
 *
 * The cost of that arrangement is staleness: editing `src/` and forgetting
 * `npm run build` ships a package whose behavior does not match its sources, and
 * nothing in the runtime would notice. So this suite rebuilds from `src/` into a
 * temp directory and requires the result to be BYTE-identical to the committed
 * artifact. A mismatch means exactly one thing, and the message says it.
 *
 * It builds through the REAL `tsdown.config.mjs` (imported, with only `outDir`
 * redirected) rather than a copy of its options: a gate that used its own private
 * settings would keep passing while the real build drifted.
 *
 * A second case asserts the build is DETERMINISTIC. Without it a non-reproducible
 * bundler would make this gate flaky, and a flaky gate gets ignored or deleted —
 * which is worse than having none.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'node:test';
import { build } from 'tsdown';
import configs from '../tsdown.config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** The declared build targets, in the form the gate needs to check each one. */
const TARGETS = [
  {
    config: 'client',
    artifact: join(ROOT, 'client.js'),
    source: 'src/client/index.ts',
  },
  // The host half lands here with `src/host/`: { config: 'host',
  // artifact: join(ROOT, 'lib', 'index.js'), source: 'src/host/index.ts' }.
];

const PLANNED = TARGETS.map((t) => t.config);
const DECLARED = (Array.isArray(configs) ? configs : [configs]).map((c) => c.name);

/** Build ONE entry from the real config into `outDir`, returning the emitted file. */
async function buildInto(target, outDir) {
  const declared = (Array.isArray(configs) ? configs : [configs]).find((c) => c.name === target.config);
  assert.ok(declared, `tsdown.config.mjs declares no "${target.config}" build target`);
  await build({
    ...declared,
    // Resolve against the repo root, not the caller's cwd, so the suite is
    // runnable from anywhere.
    entry: (declared.entry ?? []).map((e) => (isAbsolute(e) ? e : join(ROOT, e))),
    outDir,
    clean: true,
    // A gate has no business writing declarations.
    dts: false,
  });
  const emitted = join(outDir, declared.outputOptions?.entryFileNames ?? 'index.js');
  assert.ok(existsSync(emitted), `build emitted no ${emitted}`);
  return readFile(emitted, 'utf8');
}

let firstPass = null;

describe('build gate — committed artifacts match src/', () => {
  before(async () => {
    assert.ok(TARGETS.length > 0, 'the gate must check at least one artifact');
    const dir = await mkdtemp(join(tmpdir(), 'atomcode-gate-'));
    try {
      // One build, reused by every case below: the bundler is the slow part.
      firstPass = new Map();
      for (const target of TARGETS) {
        firstPass.set(target.config, await buildInto(target, join(dir, target.config)));
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('declares a build target for every artifact this gate checks', () => {
    for (const name of PLANNED) {
      assert.ok(
        DECLARED.includes(name),
        `tsdown.config.mjs no longer declares a "${name}" target, so its artifact would never be rebuilt`,
      );
    }
  });

  for (const target of TARGETS) {
    it(`${target.artifact.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '')} is not STALE`, async () => {
      assert.ok(
        existsSync(target.artifact),
        `the committed artifact is missing; run \`npm run build\` (it is committed on purpose)`,
      );
      const committed = await readFile(target.artifact, 'utf8');
      const rebuilt = firstPass.get(target.config);
      assert.equal(
        rebuilt,
        committed,
        `${target.artifact} does not match a fresh build of ${target.source} — run \`npm run build\` and commit the result`,
      );
    });
  }

  it('builds deterministically (a flaky gate gets deleted)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomcode-gate2-'));
    try {
      for (const target of TARGETS) {
        const again = await buildInto(target, join(dir, target.config));
        assert.equal(
          again,
          firstPass.get(target.config),
          `building ${target.config} twice produced different bytes, so the staleness check cannot be trusted`,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
