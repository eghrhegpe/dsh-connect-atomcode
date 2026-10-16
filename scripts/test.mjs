#!/usr/bin/env node
/**
 * Offline test runner — auto-discovers every `test/*.test.mjs` and hands the list
 * to Node's built-in test runner (`node --test`), replacing what used to be a
 * 13-term `&&` chain hand-edited in `package.json`.
 *
 * Why a runner instead of just `node --test test/`:
 *
 *  1. The two LIVE suites (`*-live.test.mjs`) live in the same directory and must
 *     NOT join the offline gate — they touch the local daemon, and one of them is
 *     opt-in behind `ATOMCODE_LIVE_TURNS=1`. A directory glob would sweep them in.
 *  2. `--test-concurrency=1` is load-bearing: `build-gate.test.mjs` re-runs the
 *     real `tsdown` build with `clean: true`, which rewrites `lib/` in place. Any
 *     suite reading a `lib/*.js` while that runs would see a half-built tree. The
 *     old `&&` chain was serial by accident; the runner keeps that property on
 *     purpose, so adding a suite can never silently reintroduce the race.
 *
 * Adding a suite is now just dropping a `test/whatever.test.mjs` in — no more
 * forgetting to append the file to a chain in `package.json` (AGENTS.md records
 * that this exact mistake shipped once).
 *
 * Node's runner prints ONE aggregate summary at the end (`ℹ tests / pass / fail`)
 * instead of thirteen separate ones, and exits non-zero on any failure.
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs') && !f.includes('-live'))
  .sort()
  .map((f) => join(testDir, f));

if (files.length === 0) {
  console.error('test: no offline suites found in test/');
  process.exit(1);
}

// `stdio: 'inherit'` so the runner's TAP output reaches the terminal unchanged.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);