/**
 * inject.test.mjs — delivering the post-review continuation to the session's model.
 *
 * ONE delivery path lives here now: after `/atomcode-review` finishes, its text
 * is handed to the session's model as "continue your original task". The risk is
 * not that it throws — it is that the message reaches the model with the WRONG
 * attribution, or that a failure looks like a success. So this suite pins three
 * things rather than the happy path alone —
 *
 *   1. the message is stamped `source.kind: 'atomcode-bridge'` and its text tells
 *      the model where it came from (a message that reads as user speech is the
 *      failure mode this feature can produce);
 *   2. every refusal is a NAMED code, because the command reply renders that path
 *      and a silent no-op would look like a successful delivery;
 *   3. the METHOD follows the driver's phase: idle → `steer()` (wake the one turn
 *      that will read it), running → `inject()` (attach to the turn in flight,
 *      never interrupt). Picking the wrong one is silent — the message just parks
 *      in the inbox forever — which is exactly how it shipped wrong the first time.
 *
 * WHAT USED TO BE HERE, and why it is not. `composeInjection` and
 * `injectAtomcodeAnswer` served the retired `/inject` route: a panel button that
 * pushed an AtomCode answer into a session by hand. The route was deleted
 * (2026-10-19 — no in-repo caller, no identity gate) but its two helpers survived
 * on test-only callers, with doc comments still describing the deleted mount. The
 * cases below cover the SAME risks through the one path that still exists: the
 * message shape, the attribution, the phase split, and every named refusal are all
 * exercised on `injectReviewContinuation`.
 *
 * The fake agent stands in for `invocation.agent`, which the command handler holds
 * already (no registry lookup). The message factory is a LOCAL stub: the real one
 * lives in the Host's module graph (`dsh-llm` is a neverBundle external), so a
 * machine without a DSH install — CI above all — cannot resolve it, and a delivery
 * assertion that reached for it failed there for an environmental reason rather
 * than a code one. Exactly one case still pins the real resolution, and it is
 * SKIPPED, visibly, where there is no Host to resolve from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INJECT_SOURCE_KIND,
  INJECT_TEXT_LIMIT,
  composeContinuation,
  injectReviewContinuation,
  resolveCreateUserMessage,
} from '../lib/inject.js';

/**
 * A recording agent whose `status` is settable, because the module picks its
 * method from that one getter: idle → `steer()` (wake), running → `inject()`
 * (attach). A stub without `status` would silently pin one branch.
 */
function recordingAgent(status = 'running') {
  const calls = [];
  const agent = {
    calls,
    get status() {
      return agent.__status;
    },
    __status: status,
    inject(message) {
      calls.push({ ...message, __method: 'inject' });
    },
    steer(message) {
      calls.push({ ...message, __method: 'steer' });
    },
    followup(message) {
      calls.push({ ...message, __method: 'followup' });
    },
  };
  return agent;
}

/**
 * A stand-in for the Host's `createUserMessage`, minting the identity a delivery
 * reports back.
 *
 * The shape is copied from what the Host's factory RETURNS (`{ id, role,
 * content, source }`), not from what this module hands it: `role` is the
 * factory's to stamp, and a stub that merely echoed its input would let a
 * delivery with no role pass.
 */
let stubMessageSeq = 0;
function stubMessageFactory(input) {
  stubMessageSeq += 1;
  return {
    id: `stub-message-${stubMessageSeq}`,
    role: 'user',
    content: input.content,
    source: input.source,
  };
}

// Resolved ONCE, at import time, so the two cases below describe one
// environment instead of racing each other.
const hostFactory = resolveCreateUserMessage();

describe('resolveCreateUserMessage — the Host copy, or an honest null', () => {
  it('is the Host factory or an honest null — never a throw', () => {
    // This is the half that holds in CI: a machine WITH a DSH install resolves a
    // function here, a machine without one (CI installs this repo's
    // devDependencies only) gets null — and null is REPORTED as `llm-unavailable`
    // by the delivery path, which the refusal cases below pin.
    assert.ok(
      hostFactory === null || typeof hostFactory === 'function',
      `expected the factory or null, got ${typeof hostFactory}`,
    );
  });

  it(
    'resolves the DSH factory when this environment has a Host install',
    // Not a tautology where it runs: `dsh-llm` is a neverBundle external, so
    // this asserts the artifact does NOT carry a bundled duplicate and that the
    // name resolves through the Host's own graph. Skipped — visibly, in the CI
    // log — where there is no Host to resolve from.
    { skip: hostFactory === null ? 'no @deepseek-ai/dsh-llm to resolve here' : false },
    () => {
      assert.equal(typeof hostFactory, 'function');
      const message = hostFactory({
        content: [{ type: 'text', text: 'x' }],
        source: { kind: INJECT_SOURCE_KIND },
      });
      assert.equal(typeof message.id, 'string');
      assert.ok(message.id.length > 0, 'the Host mints the identity the session log understands');
      assert.equal(message.role, 'user', 'the Host factory is what stamps the role');
    },
  );

  it('is cached, so a hot path does not re-resolve per delivery', () => {
    assert.equal(resolveCreateUserMessage(), resolveCreateUserMessage());
  });
});

describe('composeContinuation — an instruction, not a second opinion', () => {
  it('asks the model to continue the ORIGINAL task without waiting for the user', () => {
    const text = composeContinuation('第 42 行有个 off-by-one。');
    assert.match(text, /继续原任务/);
    assert.match(text, /不必等用户确认/);
    assert.match(text, /第 42 行有个 off-by-one。/, 'the review text must survive verbatim');
  });

  it('is NOT the "do not treat this as an instruction" framing', () => {
    // The deleted `composeInjection` said the opposite on purpose ("this is not a
    // new instruction"). Reusing that framing here would produce a message that
    // reaches the model, disclaims itself, and then the one-click loop does
    // nothing. The two texts differed for a reason; this keeps the difference.
    const text = composeContinuation('x');
    assert.doesNotMatch(text, /不是用户本人说的/);
    assert.doesNotMatch(text, /不要把它当成用户的新指令/);
  });

  it('names AtomCode exactly ONCE — the first wording said it three times', () => {
    // Not cosmetic: the intro, a separate 来源 line and the fence label all
    // said "AtomCode", so the model read the same provenance three times and
    // the actual instruction got buried. The profile is folded into the one
    // mention instead of getting a line of its own.
    const text = composeContinuation('x', { model: 'AtomGit-glm5.3-flash' });
    assert.equal(text.match(/AtomCode/g)?.length, 1);
    assert.match(text, /档位 AtomGit-glm5\.3-flash/);
  });

  it('drops the profile when none was given', () => {
    assert.doesNotMatch(composeContinuation('x'), /档位/);
    assert.doesNotMatch(composeContinuation('x', { model: '' }), /档位/);
  });

  it('carries the instruction, so the model knows WHAT was asked for', () => {
    // Without this the model reads a review and has to guess the requirement
    // before it can judge the conclusion.
    const text = composeContinuation('x', { scope: '（指令：只看 diff）' });
    assert.match(text, /刚完成一次工作区评审（指令：只看 diff），结论如下/);
  });

  it('leaves the scope out when the command carried no words of its own', () => {
    assert.match(composeContinuation('x'), /刚完成一次工作区评审，结论如下/);
    assert.match(composeContinuation('x', { scope: '   ' }), /刚完成一次工作区评审，结论如下/);
  });

  it("frames the review text so a truncation marker cannot read as the model's own words", () => {
    const text = composeContinuation('…（已按字段上限截断）');
    assert.match(text, /--- 评审开始 ---/);
    assert.match(text, /--- 评审结束 ---/);
  });
});

describe('injectReviewContinuation — the ONE named turn the refined 红线 allows', () => {
  it('calls inject() on a RUNNING session — attach, never interrupt', () => {
    const agent = recordingAgent('running');
    const outcome = injectReviewContinuation(
      { agent, createUserMessage: stubMessageFactory },
      { reviewReply: '  这段代码有并发问题。  ' },
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.delivered, 'next-step', 'a running turn claims it at its next step');
    assert.equal(outcome.woke, false, 'nothing was woken: a turn was already in flight');
    assert.equal(agent.calls.length, 1);
    const [message] = agent.calls;
    assert.equal(message.role, 'user');
    assert.equal(message.__method, 'inject', 'steer() here would cut into the turn in flight');
    // STRICT shape, no "array or string" tolerance: `content` is
    // `readonly ContentBlock[]` ("Exact model-facing blocks"). An earlier
    // version of this module sent a bare string, and the live turn died with
    // `content.some is not a function` plus ~200 「未知内容块」in the UI.
    const body = message.content;
    assert.equal(Array.isArray(body), true, 'content must be an array of blocks, never a bare string');
    assert.equal(body.length, 1);
    assert.equal(body[0].type, 'text', 'the block must carry a known type tag; an unknown one renders as 未知内容块');
    assert.equal(typeof body[0].text, 'string');
    assert.match(body[0].text, /这段代码有并发问题/, 'the trimmed review text must be included');
  });

  // The failure this pins is SILENT, which is why it shipped: `inject()` does
  // not wake an idle driver ("idle drivers leave it pending until follow-up or
  // steering wakes them"), so on the session the user was actually looking at,
  // the continuation parked in the inbox forever and the click looked dead.
  // Idle must therefore steer.
  it('calls steer() on an IDLE session — otherwise the continuation parks forever', () => {
    const agent = recordingAgent('idle');
    const outcome = injectReviewContinuation(
      { agent, createUserMessage: stubMessageFactory },
      { reviewReply: '这段要进对话。', model: 'AtomGit-glm5.3-flash' },
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.delivered, 'new-turn', 'the wake IS the delivery here');
    assert.equal(outcome.woke, true, 'the caller is told a turn was started');
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].__method, 'steer');
    assert.equal(agent.calls[0].__method === 'inject', false, 'inject() would never be read');
    const block = agent.calls[0].content[0];
    assert.equal(block.type, 'text');
    assert.match(block.text, /这段要进对话。/);
    assert.equal(agent.calls[0].source.kind, INJECT_SOURCE_KIND);
  });

  it('treats a missing or unreadable status as running, never as a reason to fail', () => {
    // No `status` at all (an older agent stub): the safe choice is the
    // non-waking method — a delivery that parks beats spurious turns.
    const blind = { calls: [], inject(m) { this.calls.push({ ...m, __method: 'inject' }); } };
    const outcome = injectReviewContinuation(
      { agent: blind, createUserMessage: stubMessageFactory },
      { reviewReply: 'x' },
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.delivered, 'next-step');
    assert.equal(blind.calls[0].__method, 'inject');
  });

  it('stamps a source the session can attribute to this plugin', () => {
    const agent = recordingAgent();
    injectReviewContinuation({ agent, createUserMessage: stubMessageFactory }, { reviewReply: 'x' });
    assert.equal(agent.calls[0].source.kind, INJECT_SOURCE_KIND);
    assert.notEqual(agent.calls[0].source.kind, 'user');
  });

  // The id the caller reports must be the id that was actually delivered — a
  // caller pointing at a message that does not exist is worse than no id at all.
  it('reports the id the factory minted, so the caller can point at the message', () => {
    const agent = recordingAgent();
    const outcome = injectReviewContinuation(
      { agent, createUserMessage: stubMessageFactory },
      { reviewReply: 'x' },
    );
    assert.equal(typeof outcome.messageId, 'string');
    assert.ok(outcome.messageId.length > 0);
    assert.equal(outcome.messageId, String(agent.calls[0].id));
  });

  it('forwards the scope label into the delivered body', () => {
    const agent = recordingAgent('idle');
    injectReviewContinuation(
      { agent, createUserMessage: stubMessageFactory },
      { reviewReply: '第 42 行有个 off-by-one。', scope: '（附加要求：只看 diff）' },
    );
    assert.match(agent.calls[0].content[0].text, /（附加要求：只看 diff）/);
  });

  it('names the absent agent instead of throwing, and delivers nothing', () => {
    const outcome = injectReviewContinuation(
      { agent: null, createUserMessage: stubMessageFactory },
      { reviewReply: 'x' },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'agent-not-live');
  });

  it('refuses empty text and oversized text with named codes', () => {
    const agent = recordingAgent('idle');
    const empty = injectReviewContinuation(
      { agent, createUserMessage: stubMessageFactory },
      { reviewReply: '   ' },
    );
    assert.equal(empty.code, 'text-required');
    const big = injectReviewContinuation(
      { agent, createUserMessage: stubMessageFactory },
      { reviewReply: 'x'.repeat(INJECT_TEXT_LIMIT + 1) },
    );
    assert.equal(big.code, 'text-too-large');
    assert.match(big.error, new RegExp(String(INJECT_TEXT_LIMIT)), 'the message names the bound instead of truncating');
    assert.deepEqual(agent.calls, [], 'neither refusal may touch the driver');
  });

  it('reports llm-unavailable when the Host exposes no message factory', () => {
    const agent = recordingAgent('idle');
    const outcome = injectReviewContinuation({ agent, createUserMessage: null }, { reviewReply: 'x' });
    assert.equal(outcome.code, 'llm-unavailable');
    assert.deepEqual(agent.calls, []);
  });

  it('inject-failed carries the thrown reason rather than swallowing it', () => {
    const boom = () => {
      throw new Error('message store is closed');
    };
    const outcome = injectReviewContinuation(
      { agent: recordingAgent(), createUserMessage: boom },
      { reviewReply: 'x' },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'inject-failed');
    assert.match(outcome.error, /message store is closed/);
  });

  it('a throwing agent.inject is reported, not crashed on', () => {
    const agent = {
      // `running`, so the module picks inject() and this pins THAT call's throw.
      status: 'running',
      inject() {
        throw new Error('driver disposed');
      },
    };
    const outcome = injectReviewContinuation(
      { agent, createUserMessage: stubMessageFactory },
      { reviewReply: 'x' },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'inject-failed');
    assert.match(outcome.error, /driver disposed/);
  });
});
