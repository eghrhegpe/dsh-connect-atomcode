/**
 * typecheck.test.mjs — `npm test` must not be green while `tsc --noEmit` is red.
 *
 * WHY THIS SUITE EXISTS. `tsc --noEmit` was only ever a SEPARATE command
 * (`npm run typecheck`) plus a separate CI step. Nothing tied it to the offline
 * gate, so a type error could sit at HEAD while `npm test` reported 24/24 green:
 * the gate that everyone (and the release checklist) reads as "the tree is fine"
 * did not cover the compiler. A sibling repo hit exactly that — its typecheck sat
 * red at HEAD for an unknown number of commits because no suite ran it.
 *
 * It is a SUITE and not a `scripts.test` chain entry for the same reason every
 * other check here is: `scripts/test.mjs` auto-discovers `test/*.test.mjs`, so a
 * new suite cannot fall outside the gate. A chain step could be dropped by an
 * edit and nothing would notice.
 *
 * The compiler is resolved from `node_modules` LOCAL to the repo, never as a
 * bare `tsc`: a global one can be a different major and would typecheck against
 * different lib types than the one CI installs.
 *
 * Missing compiler: loud skip locally (fresh clone without `npm ci`), but a
 * FAILURE when `CI`/`GITHUB_ACTIONS` is set — there `npm ci` is supposed to have
 * run, and a silently skipped gate is the failure mode this file exists to close.
 *
 * The child's stdio is INHERITED, never piped: piped child stdio is what a
 * confined sandbox denies, and capturing it bought nothing — the assertion needs
 * only the exit status, while the compiler's own lines read better live in the log.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const IN_CI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';

test('typecheck — the offline gate is red when `tsc --noEmit` is red', () => {
  if (!existsSync(TSC)) {
    const why = `typescript is not installed at ${TSC} (run \`npm ci\`)`;
    if (IN_CI) assert.fail(`typecheck cannot run: ${why} — skipping in CI would hide a broken gate`);
    console.log(`[skip] typecheck — ${why}`);
    return;
  }
  const result = spawnSync(process.execPath, [TSC, '--noEmit'], { cwd: ROOT, stdio: 'inherit' });
  assert.equal(result.status, 0, 'tsc --noEmit is red (the same command ci.yml runs) — the compiler output is above');
});
