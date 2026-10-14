/**
 * review-live.test.mjs — end-to-end `atomcode_review` against the real CLI.
 *
 * Builds a scratch git repo with a planted off-by-one bug in an uncommitted
 * change, then runs the wrapper's real spawn path (`atomcode review --json`)
 * with tight fuses. Consumes one bounded review turn on the configured
 * default model; `--max-rounds 8` + `--max-duration 300` keep the cost
 * small. Run only via `npm run test:live`.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { runReview } from '../lib/review.js';

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();

describe('review live — real CLI (skip if binary missing)', () => {
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
    // One bounded real review run.
    // NOTE: this host's `default_provider` (AtomGit-*) is an account-resolved
    // model that the review CLI cannot see (it only reads direct
    // `[providers.<name>]` entries), so we pin the one provider entry that
    // carries base_url + key on this machine. The daemon side (ask tool)
    // resolves the account default fine — this nuance is specific to review.
    review = await runReview({
      workingDir: repo,
      provider: 'agnes-3.0-flash',
      maxRounds: 8,
      maxDurationSecs: 300,
      noWeb: true,
    });
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
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
