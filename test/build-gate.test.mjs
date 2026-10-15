/**
 * build-gate.test.mjs — the artifacts must never drift from their sources.
 *
 * `client.js` and everything under `lib/` are COMMITTED BUILD OUTPUTS, not
 * sources. They have to be committed because pnpm refuses to run build scripts
 * for git dependencies (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), so a
 * GitHub-direct install gets no `prepare` step — see the header of
 * `tsdown.config.mjs`.
 *
 * The cost of that arrangement is staleness: editing `src/` and forgetting
 * `npm run build` ships a package whose behavior does not match its sources, and
 * nothing in the runtime would notice. So this suite rebuilds from `src/` into a
 * temp directory and requires the result to be BYTE-identical to the committed
 * artifact — every emitted file, and the same SET of files. A mismatch means
 * exactly one thing, and the message says it.
 *
 * It builds through the REAL `tsdown.config.mjs` (imported, with only `outDir`
 * redirected) rather than a copy of its options: a gate that used its own private
 * settings would keep passing while the real build drifted.
 *
 * A second case asserts the build is DETERMINISTIC. Without it a
 * non-reproducible bundler would make this gate flaky, and a flaky gate gets
 * ignored or deleted — which is worse than having none.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it, before } from 'node:test';
import { build } from 'tsdown';
import configs from '../tsdown.config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ALL = Array.isArray(configs) ? configs : [configs];

/**
 * The declared build targets. `artifact` is the committed counterpart to
 * whatever the build emits: a FILE for the client (one IIFE at the package
 * root), a DIRECTORY for the host (one ESM file per source module).
 */
const TARGETS = [
  {
    config: 'client',
    artifact: join(ROOT, 'client.js'),
    source: 'src/client/index.ts',
    kind: 'file',
  },
  {
    config: 'host',
    artifact: join(ROOT, 'lib'),
    source: 'src/host/*.ts',
    kind: 'dir',
  },
];

const PLANNED = TARGETS.map((t) => t.config);
const DECLARED = ALL.map((c) => c.name);

const findConfig = (name) => {
  const declared = ALL.find((c) => c.name === name);
  assert.ok(declared, `tsdown.config.mjs declares no "${name}" build target`);
  return declared;
};

/** Build ONE target from the real config into `outDir`. */
async function buildInto(target, outDir) {
  const declared = findConfig(target.config);
  await build({
    ...declared,
    // Resolve against the repo root, not the caller's cwd, so the suite is
    // runnable from anywhere.
    entry: resolveEntry(declared.entry),
    outDir,
    clean: true,
    // A gate has no business writing declarations.
    dts: false,
  });
  return outDir;
}

function resolveEntry(entry) {
  const abs = (e) => (isAbsolute(e) ? e : join(ROOT, e));
  if (Array.isArray(entry)) return entry.map(abs);
  if (entry && typeof entry === 'object') {
    return Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, abs(v)]));
  }
  return entry;
}

/** Read a directory as `{ relativeName: contents }`, so a renamed or extra file fails. */
async function readDirAsMap(dir) {
  const out = {};
  for (const name of (await readdir(dir)).sort()) {
    out[name] = await readFile(join(dir, name), 'utf8');
  }
  return out;
}

async function readArtifact(target) {
  if (target.kind === 'file') {
    assert.ok(
      existsSync(target.artifact),
      `the committed artifact ${target.artifact} is missing; run \`npm run build\` (it is committed on purpose)`,
    );
    return { [target.artifact.split(/[\\/]/).pop()]: await readFile(target.artifact, 'utf8') };
  }
  assert.ok(
    existsSync(target.artifact),
    `the committed artifact directory ${target.artifact} is missing; run \`npm run build\``,
  );
  return readDirAsMap(target.artifact);
}

let firstPass = new Map();

describe('build gate — committed artifacts match src/', () => {
  before(async () => {
    assert.ok(TARGETS.length > 0, 'the gate must check at least one artifact');
    const dir = await mkdtemp(join(tmpdir(), 'atomcode-gate-'));
    try {
      // One build per target, reused by every case below: the bundler is the slow part.
      for (const target of TARGETS) {
        firstPass.set(target.config, await readDirAsMap(await buildInto(target, join(dir, target.config))));
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
    it(`${target.kind === 'file' ? target.artifact.replace(`${ROOT}${sep()}`, '') : `${target.artifact.replace(`${ROOT}${sep()}`, '')}/`} is not STALE`, async () => {
      const committed = await readArtifact(target);
      const rebuilt = firstPass.get(target.config);

      // The FILE SET first: a target that silently starts or stops emitting a
      // module must fail even if every shared file is byte-identical.
      assert.deepEqual(
        Object.keys(rebuilt).sort(),
        Object.keys(committed).sort(),
        `the committed ${target.kind === 'file' ? 'file' : 'directory'} and a fresh build of ${target.source} disagree about WHICH files exist — run \`npm run build\` and commit the result`,
      );

      for (const name of Object.keys(committed)) {
        assert.equal(
          rebuilt[name],
          committed[name],
          `${name} does not match a fresh build of ${target.source} — run \`npm run build\` and commit the result`,
        );
      }
    });
  }

  it('builds deterministically (a flaky gate gets deleted)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomcode-gate2-'));
    try {
      for (const target of TARGETS) {
        const again = await readDirAsMap(await buildInto(target, join(dir, target.config)));
        assert.deepEqual(
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

function sep() {
  return process.platform === 'win32' ? '\\' : '/';
}
