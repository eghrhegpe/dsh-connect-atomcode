/**
 * probe-gate-diff.mjs — why does the gate's programmatic build disagree with the CLI build?
 *
 * 2026-10-17: `npm test` went red on ONE case — `lib/ is not STALE`, specifically
 * `tools.js`, 21 characters longer in a fresh build than on disk — right after a
 * client-only change. This probe rebuilds the host config into a temp dir the same
 * way `test/build-gate.test.mjs` does and prints the first differing region, so the
 * cause can be read instead of guessed.
 *
 * CONCLUSION of that run: the drift was NOT a forgotten build. A parallel session
 * edited `src/host/tools.ts` (the working_dir refusal wording) 19 seconds after
 * this machine's last `npm run build`, so the on-disk `lib/tools.js` was one edit
 * behind the sources — the gate was red on THEIR mid-edit, not on the client
 * change that had just landed. The probe's diff named the exact region
 * (`approvalMode === "bypass" &&` gate vs the ungated rewrite), which attributed
 * it without touching their files. Keep this probe: the next "lib/ is not STALE"
 * during a parallel host edit is one command away from being attributed.
 *
 * Usage: node scripts/probes/probe-gate-diff.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
import configs from '../../tsdown.config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL = Array.isArray(configs) ? configs : [configs];
const abs = (e) => (isAbsolute(e) ? e : join(ROOT, e));

const dir = await mkdtemp(join(tmpdir(), 'probe-gate-'));
try {
  for (const declared of ALL) {
    await build({
      ...declared,
      entry:
        typeof declared.entry === 'string'
          ? abs(declared.entry)
          : Array.isArray(declared.entry)
            ? declared.entry.map(abs)
            : Object.fromEntries(Object.entries(declared.entry).map(([k, v]) => [k, abs(v)])),
      outDir: join(dir, declared.name),
      clean: true,
      dts: false,
    });
  }
  for (const name of ['tools.js']) {
    const fresh = await readFile(join(dir, 'host', name), 'utf8');
    const disk = await readFile(join(ROOT, 'lib', name), 'utf8');
    if (fresh === disk) {
      console.log(`${name}: identical`);
      continue;
    }
    console.log(`${name}: DIFFERS (fresh ${fresh.length} chars, disk ${disk.length} chars)`);
    let i = 0;
    while (i < Math.min(fresh.length, disk.length) && fresh[i] === disk[i]) i++;
    let j = 0;
    while (
      j < Math.min(fresh.length, disk.length) - i &&
      fresh[fresh.length - 1 - j] === disk[disk.length - 1 - j]
    )
      j++;
    console.log('--- fresh-only region ---');
    console.log(JSON.stringify(fresh.slice(i, fresh.length - j)));
    console.log('--- disk-only region ---');
    console.log(JSON.stringify(disk.slice(i, disk.length - j)));
  }
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
