/**
 * review-findings.test.mjs — the review tool must hand back a READING of the
 * findings document, not just its bytes.
 *
 * `atomcode_review` used to return the raw `--json` stdout (log lines included)
 * and leave the model to grep the conclusions out of it. The failure that fix
 * leaves open is invisible: a model that misses one finding believes the review
 * was complete, and nothing in the output says "you did not read all of it" —
 * a noisy turn masquerading as a clean one, which is what `OUTPUT_CAP_BYTES`
 * exists to prevent on the byte level.
 *
 * The parser's honesty rules are the assertions here:
 *   1. no document / unparseable → `parsed: false` WITH a reason, never silently
 *      "zero findings";
 *   2. a field the entry does not carry → `null` (unknown), never a default;
 *   3. the digest is bounded at `FINDINGS_CAP`, and `count` stays the real total.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractJsonDocument,
  parseReviewFindings,
  runReview,
  FINDINGS_CAP,
} from '../lib/review.js';

describe('parseReviewFindings — one document in, one reading out', () => {
  it('finds the document inside log lines', () => {
    // The normal case on a real machine, not an edge case: `JSON.parse(report)`
    // on the whole buffer fails whenever the CLI prints anything else.
    const report = 'INFO  starting review\n{"findings":[{"severity":"high","message":"x"}]}\nINFO  done\n';
    const parsed = parseReviewFindings(report);
    assert.equal(parsed.parsed, true);
    assert.equal(parsed.count, 1);
    assert.deepEqual(parsed.findings[0].severity, 'high');
  });

  it('a brace inside a message does not end the document early', () => {
    const report = JSON.stringify({ findings: [{ message: 'unbalanced } brace', severity: 'low' }] });
    const doc = extractJsonDocument('noise ' + report);
    assert.equal(doc, report, 'the scan must be string-aware');
    assert.equal(parseReviewFindings(report).findings[0].message, 'unbalanced } brace');
  });

  it('a top-level array is a findings list too', () => {
    const parsed = parseReviewFindings('[{"message":"a"},{"message":"b"}]');
    assert.equal(parsed.parsed, true);
    assert.equal(parsed.count, 2);
  });

  it('a field the entry does not carry is null — unknown, not "none"', () => {
    const parsed = parseReviewFindings('{"findings":[{"message":"leaky"}]}');
    const only = parsed.findings[0];
    assert.equal(only.severity, null, 'an absent severity must not be invented');
    assert.equal(only.file, null);
    assert.equal(only.line, null);
    assert.equal(only.message, 'leaky');
  });

  it('an entry with no recognizable text still appears, as its own JSON', () => {
    // Dropping it would be worse than a clumsy line: the finding EXISTS and a
    // digest that omits it reads as "nothing else wrong here".
    const parsed = parseReviewFindings('{"findings":[{"severity":"high","note":"see diff"}]}');
    assert.equal(parsed.count, 1);
    assert.match(parsed.findings[0].message, /see diff/);
  });

  it('no document at all is reported as NOT parsed — not as zero findings', () => {
    // The distinction that matters: `count: 0` with parsed:true means "clean";
    // parsed:false means "I could not read it". Collapsing them is the bug.
    const parsed = parseReviewFindings('INFO nothing to review\n');
    assert.equal(parsed.parsed, false);
    assert.equal(parsed.count, 0);
    assert.match(parsed.reason, /找不到完整的 JSON 文档/);
  });

  it('a clipped document is not parsed', () => {
    const parsed = parseReviewFindings('{"findings":[{"message":"a"}');
    assert.equal(parsed.parsed, false);
    assert.match(parsed.reason, /找不到完整的 JSON 文档/);
  });

  it('an unrecognized shape names the keys it DID find, instead of guessing', () => {
    const parsed = parseReviewFindings('{"result":{"rows":[1]}}');
    assert.equal(parsed.parsed, false);
    assert.match(parsed.reason, /result/, 'the reason must be evidence for the next fix');
  });

  it(`the digest is bounded at ${FINDINGS_CAP}, and count stays the real total`, () => {
    const many = Array.from({ length: FINDINGS_CAP + 50 }, (_, i) => ({ message: `f${i}` }));
    const parsed = parseReviewFindings(JSON.stringify({ findings: many }));
    assert.equal(parsed.parsed, true);
    assert.equal(parsed.count, FINDINGS_CAP + 50);
    assert.equal(parsed.findings.length, FINDINGS_CAP);
    assert.equal(parsed.capped, true, 'a clipped digest must say it is clipped');
  });
});

describe('runReview — the outcome carries the reading', () => {
  const withRepo = async (fn) => {
    const repo = mkdtempSync(join(tmpdir(), 'atomcode-findings-repo-'));
    try {
      return await fn(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };

  /** A child that prints `stdout` and exits `code`. */
  const spawnWith = (stdout, code = 0, stderr = '') => () => ({
    stdout: { on(_event, cb) { if (stdout) cb(stdout); } },
    stderr: { on(_event, cb) { if (stderr) cb(stderr); } },
    on(event, cb) {
      if (event === 'exit') setImmediate(() => cb(code));
    },
    kill() {},
  });

  it('a successful review reports what it found', async () => {
    await withRepo(async (repo) => {
      const doc = JSON.stringify({
        findings: [
          { severity: 'high', file: 'src/a.ts', line: 12, message: 'null deref' },
          { severity: 'low', file: 'src/b.ts', message: 'naming' },
        ],
      });
      const r = await runReview({
        workingDir: repo,
        task: 'x',
        spawn: spawnWith('WARN noise\n' + doc + '\nWARN more\n'),
      });
      assert.equal(r.ok, true);
      assert.equal(r.findings.parsed, true);
      assert.equal(r.findings.count, 2);
      assert.deepEqual(r.findings.findings[0], {
        severity: 'high',
        file: 'src/a.ts',
        line: '12',
        message: 'null deref',
      });
      // The raw document is still there — parsing does not replace it.
      assert.match(r.report, /WARN noise/);
    });
  });

  it('a failed review reports NO reading, never an empty clean one', async () => {
    // `parsed: false, count: 0` must not be readable as "the review found
    // nothing": the run did not produce a document at all.
    await withRepo(async (repo) => {
      const r = await runReview({
        workingDir: repo,
        task: 'x',
        spawn: spawnWith('', 1, 'boom'),
      });
      assert.equal(r.ok, false);
      assert.equal(r.findings.parsed, false);
      assert.equal(r.findings.count, 0);
      assert.equal(r.findings.findings.length, 0);
    });
  });
});
