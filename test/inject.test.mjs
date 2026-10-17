/**
 * inject.test.mjs — delivering an AtomCode answer to the session's model.
 *
 * The delivery path is one call, and the risk is not that it throws: it is that
 * a message reaches the model with the WRONG attribution, or that a failure
 * looks like a success. So this suite pins three things rather than the happy
 * path alone —
 *
 *   1. the message is stamped `source.kind: 'atomcode-bridge'` and its text says
 *      out loud that the user did not write it (a "second opinion" that reads as
 *      a user instruction is the failure mode this feature can produce);
 *   2. every refusal is a NAMED code, because the chip renders the code path and
 *      a silent no-op would look like a successful delivery;
 *   3. the METHOD follows the driver's phase: idle → `steer()` (wake the one
 *      turn that will read it), running → `inject()` (attach to the turn in
 *      flight, never interrupt). Picking the wrong one is silent — the message
 *      just parks in the inbox forever — which is exactly how it shipped wrong
 *      the first time.
 *
 * `injectReviewContinuation` is the one extra shape: it is the named
 * "continue your task" turn the refined 红线 allows after a host-side review,
 * and it takes the agent DIRECTLY (no registry lookup). Its text is an
 * instruction, unlike `composeInjection`'s "second opinion — do not treat this
 * as a new instruction".
 *
 * The fake agent stands in for `ctx.agents.get()` (or is passed directly, for
 * the continuation); the real `createUserMessage` is resolved through the built
 * artifact, so the message shape under test is the Host's own (an override is
 * passed only where a test needs to force a throw).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INJECT_SOURCE_KIND,
  INJECT_TEXT_LIMIT,
  composeContinuation,
  composeInjection,
  injectAtomcodeAnswer,
  injectReviewContinuation,
  resolveCreateUserMessage,
} from '../lib/inject.js';

/** A registry stub holding one agent, recording what was delivered to it. */
function registryWith(agent) {
  return {
    get(id) {
      return id === 'session-a' ? agent : undefined;
    },
  };
}

/**
 * A recording agent whose `status` is settable, because the module now picks
 * its method from that one getter: idle → `steer()` (wake), running →
 * `inject()` (attach). A stub without `status` would silently pin one branch.
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

describe('composeInjection — the model must be able to tell this apart from the user', () => {
  it('states that the user did not write it, and that it may be wrong', () => {
    const text = composeInjection('这里有个 off-by-one。');
    assert.match(text, /不是用户本人说的/);
    assert.match(text, /可能有误/);
    assert.match(text, /这里有个 off-by-one。/, 'the answer itself must survive verbatim');
  });

  it('says what to do with it: judge it, do not treat it as a new instruction', () => {
    const text = composeInjection('x');
    assert.match(text, /不要把它当成用户的新指令/);
  });

  it('carries provenance only when the caller has it', () => {
    const bare = composeInjection('x');
    assert.doesNotMatch(bare, /来源：/);
    const full = composeInjection('x', { model: 'glm5.3', sessionId: 'abc-123' });
    assert.match(full, /模型 glm5\.3/);
    assert.match(full, /AtomCode 会话 abc-123/);
  });

  it('never renders an empty provenance field', () => {
    const text = composeInjection('x', { model: '', sessionId: '' });
    assert.doesNotMatch(text, /来源：/);
    assert.doesNotMatch(text, /undefined/);
  });
});

describe('injectAtomcodeAnswer — the happy path delivers a self-attributed message', () => {
  it('calls inject() on a RUNNING session — attach, never interrupt', () => {
    const agent = recordingAgent('running');
    const outcome = injectAtomcodeAnswer(
      { agents: registryWith(agent), createUserMessage: resolveCreateUserMessage() },
      { sessionId: 'session-a', text: '  这段代码有并发问题。  ' },
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
    // version of this assertion joined `block.text` when it saw an array and
    // fell back to `String(body)` otherwise — so it happily passed the string
    // this module used to send, and the live turn died with
    // `content.some is not a function` plus ~200 「未知内容块」in the UI.
    const body = message.content;
    assert.equal(Array.isArray(body), true, 'content must be an array of blocks, never a bare string');
    assert.equal(body.length, 1);
    assert.equal(body[0].type, 'text', 'the block must carry a known type tag; an unknown one renders as 未知内容块');
    assert.equal(typeof body[0].text, 'string');
    assert.match(body[0].text, /这段代码有并发问题/, 'the trimmed answer must be included');
  });

  // The failure this pins is SILENT, which is why it shipped: `inject()` does
  // not wake an idle driver ("idle drivers leave it pending until follow-up or
  // steering wakes them"), so on the session the user was actually looking at,
  // the answer parked in the inbox forever and the click looked dead. Idle must
  // therefore steer.
  it('calls steer() on an IDLE session — otherwise the answer parks forever', () => {
    const agent = recordingAgent('idle');
    const outcome = injectAtomcodeAnswer(
      { agents: registryWith(agent), createUserMessage: resolveCreateUserMessage() },
      { sessionId: 'session-a', text: '这段回答要进对话。' },
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.delivered, 'new-turn', 'the wake IS the delivery here');
    assert.equal(outcome.woke, true, 'the caller is told a turn was started');
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].__method, 'steer');
    assert.equal(agent.calls[0].__method === 'inject', false, 'inject() would never be read');
  });

  it('treats a missing or unreadable status as running, never as a reason to fail', () => {
    // No `status` at all (an older agent stub): the safe choice is the
    // non-waking method — a delivery that parks beats spurious turns.
    const blind = { calls: [], inject(m) { this.calls.push({ ...m, __method: 'inject' }); } };
    const outcome = injectAtomcodeAnswer(
      { agents: registryWith(blind), createUserMessage: resolveCreateUserMessage() },
      { sessionId: 'session-a', text: 'x' },
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.delivered, 'next-step');
    assert.equal(blind.calls[0].__method, 'inject');
  });

  it('stamps a source the session can attribute to this plugin', () => {
    const agent = recordingAgent();
    injectAtomcodeAnswer(
      { agents: registryWith(agent), createUserMessage: resolveCreateUserMessage() },
      { sessionId: 'session-a', text: 'x' },
    );
    assert.equal(agent.calls[0].source.kind, INJECT_SOURCE_KIND);
    assert.notEqual(agent.calls[0].source.kind, 'user');
  });

  it('builds the message with the Host factory, so its identity is a real one', () => {
    const agent = recordingAgent();
    const outcome = injectAtomcodeAnswer(
      { agents: registryWith(agent), createUserMessage: resolveCreateUserMessage() },
      { sessionId: 'session-a', text: 'x' },
    );
    assert.equal(typeof outcome.messageId, 'string');
    assert.ok(outcome.messageId.length > 0);
    assert.equal(outcome.messageId, String(agent.calls[0].id));
  });
});

describe('injectAtomcodeAnswer — every refusal is named', () => {
  it('agents-unavailable when the host has no registry', () => {
    const outcome = injectAtomcodeAnswer({ agents: undefined }, { sessionId: 's', text: 'x' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'agents-unavailable');
  });

  it('session-id-required for a missing or blank id', () => {
    const agents = registryWith(recordingAgent());
    for (const sessionId of [undefined, '', '   ', 42]) {
      const outcome = injectAtomcodeAnswer({ agents }, { sessionId, text: 'x' });
      assert.equal(outcome.code, 'session-id-required');
    }
  });

  it('text-required for a missing or blank answer', () => {
    const agents = registryWith(recordingAgent());
    for (const text of [undefined, '', '  \n ']) {
      const outcome = injectAtomcodeAnswer({ agents }, { sessionId: 'session-a', text });
      assert.equal(outcome.code, 'text-required');
    }
  });

  it('text-too-large names the bound instead of truncating', () => {
    const agents = registryWith(recordingAgent());
    const outcome = injectAtomcodeAnswer(
      { agents },
      { sessionId: 'session-a', text: 'x'.repeat(INJECT_TEXT_LIMIT + 1) },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'text-too-large');
    assert.match(outcome.error, new RegExp(String(INJECT_TEXT_LIMIT)));
  });

  it('agent-not-live tells the user the session has to be open, and delivers nothing', () => {
    const agent = recordingAgent();
    const outcome = injectAtomcodeAnswer(
      { agents: registryWith(agent) },
      { sessionId: 'session-closed', text: 'x' },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'agent-not-live');
    assert.match(outcome.error, /open it/i);
    assert.equal(agent.calls.length, 0);
  });

  it('llm-unavailable when the Host factory cannot be resolved', () => {
    const outcome = injectAtomcodeAnswer(
      { agents: registryWith(recordingAgent()), createUserMessage: null },
      { sessionId: 'session-a', text: 'x' },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'llm-unavailable');
  });

  it('inject-failed carries the thrown reason rather than swallowing it', () => {
    const boom = () => {
      throw new Error('message store is closed');
    };
    const outcome = injectAtomcodeAnswer(
      { agents: registryWith(recordingAgent()), createUserMessage: boom },
      { sessionId: 'session-a', text: 'x' },
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
    const outcome = injectAtomcodeAnswer(
      { agents: registryWith(agent), createUserMessage: resolveCreateUserMessage() },
      { sessionId: 'session-a', text: 'x' },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'inject-failed');
    assert.match(outcome.error, /driver disposed/);
  });
});

describe('resolveCreateUserMessage — the Host copy, or an honest null', () => {
  it('resolves the DSH factory in this environment', () => {
    // Not a tautology: `dsh-llm` is a neverBundle external, so this asserts the
    // artifact does NOT carry a bundled duplicate and that the name resolves.
    const factory = resolveCreateUserMessage();
    assert.equal(typeof factory, 'function');
  });

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
    // The two compose* helpers deliberately differ. Reusing composeInjection
    // here would produce a message that reaches the model, says "this is not an
    // instruction", and then the one-click loop would do nothing.
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

  it('frames the review text so a truncation marker cannot read as the model\'s own words', () => {
    const text = composeContinuation('…（已按字段上限截断）');
    assert.match(text, /--- 评审开始 ---/);
    assert.match(text, /--- 评审结束 ---/);
  });
});

describe('injectReviewContinuation — the ONE named turn the refined 红线 allows', () => {
  it('steers an IDLE session so the turn actually runs', () => {
    const agent = recordingAgent('idle');
    const outcome = injectReviewContinuation(
      { agent, createUserMessage: resolveCreateUserMessage() },
      { reviewReply: '  并发写同一个 map。  ', model: 'AtomGit-glm5.3-flash' },
    );
    assert.equal(outcome.ok, true);
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].__method, 'steer');
    const block = agent.calls[0].content[0];
    assert.equal(block.type, 'text');
    assert.match(block.text, /并发写同一个 map。/);
    assert.equal(agent.calls[0].source.kind, INJECT_SOURCE_KIND);
  });

  it('injects (never interrupts) a RUNNING session', () => {
    const agent = recordingAgent('running');
    const outcome = injectReviewContinuation(
      { agent, createUserMessage: resolveCreateUserMessage() },
      { reviewReply: 'x' },
    );
    assert.equal(outcome.ok, true);
    assert.equal(agent.calls[0].__method, 'inject');
  });

  it('forwards the scope label into the delivered body', () => {
    const agent = recordingAgent('idle');
    injectReviewContinuation(
      { agent, createUserMessage: resolveCreateUserMessage() },
      { reviewReply: '第 42 行有个 off-by-one。', scope: '（附加要求：只看 diff）' },
    );
    assert.match(agent.calls[0].content[0].text, /（附加要求：只看 diff）/);
  });

  it('reads an ABSENT status as running — the recoverable direction', () => {
    // An extra queued message is recoverable; an extra model turn is not.
    const agent = {
      calls: [],
      inject(m) { this.calls.push({ ...m, __method: 'inject' }); },
      steer(m) { this.calls.push({ ...m, __method: 'steer' }); },
    };
    const outcome = injectReviewContinuation(
      { agent, createUserMessage: resolveCreateUserMessage() },
      { reviewReply: 'x' },
    );
    assert.equal(outcome.ok, true);
    assert.equal(agent.calls.length, 1, 'still delivered, just without waking');
    assert.equal(agent.calls[0].__method, 'inject');
  });

  it('names the absent agent instead of throwing', () => {
    const outcome = injectReviewContinuation(
      { agent: null, createUserMessage: resolveCreateUserMessage() },
      { reviewReply: 'x' },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'agent-not-live');
  });

  it('refuses empty text and oversized text with named codes', () => {
    const agent = recordingAgent('idle');
    const empty = injectReviewContinuation(
      { agent, createUserMessage: resolveCreateUserMessage() },
      { reviewReply: '   ' },
    );
    assert.equal(empty.code, 'text-required');
    const big = injectReviewContinuation(
      { agent, createUserMessage: resolveCreateUserMessage() },
      { reviewReply: 'x'.repeat(INJECT_TEXT_LIMIT + 1) },
    );
    assert.equal(big.code, 'text-too-large');
    assert.deepEqual(agent.calls, [], 'neither refusal may touch the driver');
  });

  it('reports llm-unavailable when the Host exposes no message factory', () => {
    const agent = recordingAgent('idle');
    const outcome = injectReviewContinuation({ agent, createUserMessage: null }, { reviewReply: 'x' });
    assert.equal(outcome.code, 'llm-unavailable');
    assert.deepEqual(agent.calls, []);
  });
});
