/**
 * daemon-down-reason.test.mjs — `describeDaemonDown` must give every cause its
 * own sentence.
 *
 * Both readers of this function quote it verbatim: the panel prints `downMessage`,
 * and the ask/review tool errors embed the same string. So two causes that share
 * a sentence are one cause the user cannot act on — and that was the live shape
 * until this suite existed: `'unreachable'` (the classified catch-all: "we looked
 * at the failure and could not name it") and `default` (a value THIS BUILD does
 * not know) returned the identical `'探活失败，原因未能归类'`. 红线 3 forbids exactly
 * that: a diagnosis surface in which those two are indistinguishable has already
 * lost the distinction, and the second one is a drift signal (事实 3) that should
 * be named rather than absorbed.
 *
 * `default` is unreachable against the `HealthFailure` union but reachable at
 * runtime — an older `lib/daemon.js`, or a JS caller, can hand over a value this
 * build has never heard of. That is why it is asserted here and not deleted.
 *
 * This suite guards the SPLIT, not the wording: it fails if any two causes
 * collapse back into one sentence, which is the regression, and it stays green
 * when a sentence is reworded, which is not.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeDaemonDown } from '../lib/stats.js';

/** The causes `probeFailure` can actually classify, plus `''` (serving). */
const CLASSIFIED = ['refused', 'timeout', 'http-error', 'unreadable', 'not-atomcode', 'unreachable'];

describe('describeDaemonDown — one cause, one sentence', () => {
  it('every classified cause gets a sentence nobody else uses', () => {
    const owner = new Map();
    for (const cause of CLASSIFIED) {
      const sentence = describeDaemonDown(cause);
      assert.match(sentence, /\S/, `${cause} must produce a sentence, not a blank`);
      assert.equal(
        owner.has(sentence),
        false,
        `"${sentence}" is returned by both ${owner.get(sentence)} and ${cause}`,
      );
      owner.set(sentence, cause);
    }
  });

  it('a value this build does not know is NAMED, not folded into the catch-all', () => {
    const unknown = describeDaemonDown('not-responding');
    assert.match(unknown, /not-responding/, 'the unrecognized value must be quoted back, not swallowed');
    assert.notEqual(unknown, describeDaemonDown('unreachable'));
  });

  it('an un-probed daemon says so instead of borrowing a failure cause', () => {
    // The panel polls before the mount's first probe resolves; '' is "no answer
    // yet", not "down for a reason".
    assert.match(describeDaemonDown(''), /尚未探活/);
    assert.notEqual(describeDaemonDown(''), describeDaemonDown('refused'));
  });
});
