#!/usr/bin/env node
/**
 * Capture the EXACT tool definitions the host registers, as one JSON snapshot.
 *
 * WHY THIS EXISTS
 * ---------------
 * `apply()` in src/host/index.ts is being split apart in stages. A pure-movement
 * refactor must not change a single byte of what a tool looks like — and every
 * offline suite covers BEHAVIOUR (does a turn work, does a route answer) rather
 * than WORDING (is the 200-line Chinese description assembled the same way).
 * They can all be green while a description silently loses a clause, because a
 * description is a string nobody asserts on character by character.
 *
 * So: snapshot before, snapshot after, `diff`. That is byte-level evidence, and
 * it is what turns "nothing but movement happened" from a claim into a fact.
 *
 * USAGE
 * -----
 *   npm run build                                         # the snapshot reads lib/
 *   node scripts/tools-snapshot.mjs > /tmp/before.json     # BEFORE moving code
 *   ...move code...
 *   npm run build
 *   node scripts/tools-snapshot.mjs > /tmp/after.json
 *   diff /tmp/before.json /tmp/after.json                  # must be empty
 *
 * JSON goes to stdout (so `>` is clean); the one-line summary goes to stderr.
 * Deliberately NOT part of `npm test`: this is a tool for whoever is doing the
 * refactor, not an assertion the suite depends on.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || '';

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);

const defs = [];
const ctx = {
  get(name) {
    if (name === 'tools') return { register: (def) => { defs.push(def); return () => {}; } };
    if (name === 'webServer') return { register: () => () => {} };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
  fiber: { entry: { options: { id: 'dsh-connect-atomcode' } } },
  inject() {},
  effect() {},
  on() {},
};

// A fresh temp state dir, so the snapshot never depends on what the developer's
// real ~/.dsh state happens to hold.
const stateDir = mkdtempSync(join(tmpdir(), 'atomcode-snapshot-'));
mod.apply(ctx, { auto_start: false, port: 45999, state_path: join(stateDir, 'sessions.json') });

const snap = defs.map((def) => ({
  name: def.name,
  description: def.description,
  parameters: def.parameters,
  output: def.output,
}));

const json = JSON.stringify(snap, null, 2);
if (OUT) writeFileSync(OUT, json, 'utf8');
else process.stdout.write(json);
process.stderr.write(`tools=${defs.length} bytes=${json.length}${OUT ? ` -> ${OUT}` : ''}\n`);
