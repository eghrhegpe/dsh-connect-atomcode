/**
 * review-live.test.mjs — end-to-end `atomcode_review` against the real CLI.
 *
 * Builds a scratch git repo with a planted off-by-one bug in an uncommitted
 * change, then runs the wrapper's real spawn path (`atomcode review --json`)
 * with tight fuses. Consumes one bounded review turn on a usable provider.
 *
 * GATED TWICE. A run needs (a) a direct `[providers.<name>]` with a non-gateway
 * base_url — on a host whose only models are AtomGit-gateway/account-resolved,
 * the review CLI cannot authenticate at all ("missing base URL" /
 * ATOMCODE_SIG_MISSING), so a green run there is impossible — and (b) an
 * explicit opt-in to spend a real review turn:
 *
 *   PowerShell:  $env:ATOMCODE_LIVE_TURNS=1; npm run test:live
 *   bash/zsh:    ATOMCODE_LIVE_TURNS=1 npm run test:live
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { runReview, checkReviewProvision } from '../lib/review.js';

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();

// Decide the gate before collecting the suite. Two independent conditions: a
// usable provider must exist, AND the caller must opt in to spending a real
// review turn (`npm run test:live` is safe by default).
const provision = checkReviewProvision();
const turnsEnabled = process.env.ATOMCODE_LIVE_TURNS === '1';
const skipReason = !provision.available
  ? `review CLI has no usable provider on this host: ${provision.reason}`
  : turnsEnabled
    ? false
    : 'consumes a real review turn (billed against the configured provider) — set ATOMCODE_LIVE_TURNS=1 to run';

if (skipReason) {
  console.log(`[review-live] SKIP — ${skipReason}`);
}

describe('review live — real CLI (skips when no usable direct provider)', { skip: skipReason }, () => {
  let repo;
  let review;

  before(async () => {
    repo = mkdtempSync(join(tmpdir(), 'atomcode-review-repo-'));
    sh('git init -q', repo);
    sh('git config user.email test@example.com && git config user.name t', repo);
    // Baseline: a correct helper, committed.
    writeFileSync(
      join(repo, 'sum.js'),
      [
        'export function sum(nums) {',
        '  let total = 0;',
        '  for (let i = 0; i < nums.length; i++) total += nums[i];',
        '  return total;',
        '}',
        '',
      ].join('\n'),
    );
    sh('git add sum.js && git commit -qm baseline', repo);
    // Plant an off-by-one in an UNCOMMITTED change (what review reads by default).
    writeFileSync(
      join(repo, 'sum.js'),
      [
        'export function sum(nums) {',
        '  let total = 0;',
        '  for (let i = 0; i <= nums.length; i++) total += nums[i];',
        '  return total;',
        '}',
        '',
      ].join('\n'),
    );
    // One bounded real review run, pinned to a provider the probe proved usable.
    // Never pin a name from another machine: take the first usable entry.
    review = await runReview({
      workingDir: repo,
      ...(provision.providers.length > 0 ? { provider: provision.providers[0] } : {}),
      maxRounds: 8,
      maxDurationSecs: 300,
      noWeb: true,
    });
  });

  after(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('binary present and process exited 0', () => {
    assert.equal(review.exitCode, 0, `review exited ${review.exitCode}: ${review.error}`);
  });

  it('produces a report (JSON or fallback text)', () => {
    assert.ok(review.report.length > 0, 'report must not be empty');
    const trimmed = review.report.trim();
    const looksStructured =
      trimmed.startsWith('{') || trimmed.startsWith('[') || /"findings"/.test(trimmed) || /severity/i.test(trimmed);
    // The --json contract should hold; if the payload drifted, still assert
    // the report mentions the planted bug or at least the changed file.
    assert.ok(
      looksStructured || /sum\.js/i.test(trimmed),
      `report lacks structure and does not mention sum.js: ${trimmed.slice(0, 300)}`,
    );
  });

  it('finished within the wall-clock fuse', () => {
    assert.ok(review.durationMs <= 320_000, `took ${review.durationMs}ms > fuse`);
  });
});
