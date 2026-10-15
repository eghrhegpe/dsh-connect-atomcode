// Step ③: one REAL atomcode_review run through the CLI, now that a direct
// provider (atomcode-local -> local proxy) exists. Tight fuses: 5 rounds/120s.
//
// ⚠️ COST: consumes ONE bounded review turn. Requires a usable direct provider
// (the local proxy, per docs/AtomGit-网关与-review-通路.md).
//
// Archived from the repo root as `.probe-review.mjs` (2026-10-16) so the
// evidence behind that document is reproducible instead of only narrated.
// Run from the REPO ROOT (`node scripts/probes/real-review.mjs`): the working
// dir handed to the review task is `process.cwd()`.
import { runReview, checkReviewProvision } from '../../lib/review.js';

console.log('provision:', JSON.stringify(checkReviewProvision()));
const t0 = Date.now();
const result = await runReview({
  task: 'Read the file package.json of this repository and report its "version" field value in one short sentence. Do not touch anything else.',
  workingDir: process.cwd(),
  provider: 'atomcode-local',
  maxRounds: 5,
  maxDurationSecs: 120,
  noWeb: true,
  log: (m) => console.log('[log]', m),
});
console.log('---');
console.log('ok:', result.ok, 'exit:', result.exitCode, 'ms:', Date.now() - t0);
console.log('error:', result.error || '(none)');
console.log('report:', (result.report || '').slice(0, 1500));
