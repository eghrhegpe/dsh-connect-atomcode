/**
 * command.test.mjs — `/atomcode-review`: the review itself runs with NO model
 * in the loop.
 *
 * The claim this suite defends is narrow and easy to lose: a slash command is
 * the only host channel that can do real work "against the receiving agent
 * without sending the command to the model" (the `CommandDefinition.handler`
 * contract, the same shape `/compact` uses). The failure mode is subtle — if
 * the handler ever ran the REVIEW through a model turn, it would still pass a
 * happy-path test while quietly spending a turn the user did not ask for, and
 * the panel would show a review that cost DSH quota.
 *
 * The refined 红线 (方针 A+continue, 2026-10) allows EXACTLY ONE exception: after
 * a review succeeds, the handler may hand the outcome back as a single named
 * "continue your original task" turn (`injectReviewContinuation`). Everything
 * else still holds — the three raw delivery methods (`followup` / `steer` /
 * `inject`) must not appear in the review path at all, and a REFUSED or FAILED
 * review must not deliver anything. That is what the assertions below pin: the
 * fake agent records every delivery, and every test here drives a branch where
 * the daemon is unreachable, so `agent.calls` must stay empty.
 *
 * `runReviewCommand` goes through `runAsk` (the daemon channel) rather than a
 * spawned CLI. The refusal branch (no working directory) fires BEFORE any
 * daemon I/O, so the hermetic test needs no fake daemon.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REVIEW_COMMAND_NAME,
  composeReviewPrompt,
  formatReviewOutcome,
  mountReviewCommand,
  reviewScopeLabel,
  runReviewCommand,
} from '../lib/command.js';

// ── fakes ─────────────────────────────────────────────────────────────────────

/**
 * An agent that RECORDS every delivery. The REVIEW path must not touch these;
 * the assertions below read the array to prove it, rather than trusting that the
 * code "obviously" does not call them. (The one allowed delivery — the named
 * continuation after a SUCCESSFUL review — cannot fire in this suite, because
 * every branch here ends with an unreachable daemon.)
 */
function recordingAgent({ id = 'session-a', cwd = 'C:\\work\\repo', sessionless = false } = {}) {
  const calls = [];
  return {
    calls,
    id,
    session: sessionless ? { header: {} } : { header: { cwd } },
    status: 'idle',
    followup(message) {
      calls.push({ method: 'followup', message });
    },
    steer(message) {
      calls.push({ method: 'steer', message });
    },
    inject(message) {
      calls.push({ method: 'inject', message });
    },
  };
}

/**
 * A config/runtime pair just complete enough for `runReviewCommand` to reach
 * its working-directory refusal before any daemon I/O.
 *
 * `defaultWorkingDir` (not `working_dir`) is what `runAsk` destructures; it is
 * the HostConfig field derived from the patch config.
 */
function sandboxDeps({ defaultWorkingDir = '', reviewBriefMode = 'when-empty', log } = {}) {
  return {
    config: {
      port: 0,
      autoStart: false,
      approvalMode: 'bypass',
      defaultWorkingDir,
      askMaxRounds: 25,
      defaultProvider: '',
      reviewBriefMode,
      baseUrl: 'http://127.0.0.1:0',
    },
    runtime: {
      stats: { ask: { calls: 0, ok: 0, err: 0, msTotal: 0 }, review: { calls: 0, ok: 0, err: 0, msTotal: 0 } },
      sessions: { get: () => null, set: () => {} },
      resolveProvider: () => ({ name: '' }),
      resolveBriefMode: () => ({ mode: reviewBriefMode, source: 'config' }),
      resolveDefaultWorkingDir: () => '',
      ensureDaemon: async () => {},
      // Added with the durable 工具调用统计 card: runAsk persists the counters
      // after every ask turn (including refusals). A stub that omits it makes the
      // refusal path throw instead of returning its message.
      persistAskUsage: () => {},
    },
    log: log ?? (() => {}),
  };
}

/** Capture what a command registration received. */
function captureCommands() {
  const registered = [];
  return {
    registered,
    service: {
      register(definition) {
        registered.push(definition);
        let disposed = false;
        return () => {
          disposed = true;
          definition.__disposed = true;
        };
      },
    },
  };
}

// ── composeReviewPrompt ───────────────────────────────────────────────────────

describe('composeReviewPrompt — the brief obeys the review_brief_mode setting', () => {
  it('when-empty (the shipped default): a bare invocation sends only the brief', () => {
    const msg = composeReviewPrompt('');
    assert.ok(msg.includes('未提交的改动'));
    assert.ok(msg.includes('不要猜'));
    assert.ok(!msg.includes('另外'));
  });

  it('when-empty: non-empty text goes through VERBATIM, without the brief', () => {
    // This is the fix for "打个招呼 ran a six-round review": a greeting is a
    // greeting, not a review with a scope. The brief only backstops an empty
    // line.
    const msg = composeReviewPrompt('重点看并发');
    assert.equal(msg, '重点看并发');
  });

  it('always: the brief comes first on every call, extra text appended', () => {
    const bare = composeReviewPrompt('', 'always');
    assert.ok(bare.includes('未提交的改动'));
    assert.ok(!bare.includes('另外'));
    const extra = composeReviewPrompt('重点看并发', 'always');
    assert.ok(extra.includes('未提交的改动'), 'the brief must still be there');
    assert.ok(extra.includes('另外：重点看并发'), 'the extra is a suffix');
  });

  it('never: the brief is never sent; an empty text yields ""', () => {
    assert.equal(composeReviewPrompt('', 'never'), '');
    assert.equal(composeReviewPrompt('   ', 'never'), '');
    assert.equal(composeReviewPrompt('只看 diff', 'never'), '只看 diff');
  });

  it('whitespace-only extra is treated as empty in every mode', () => {
    for (const mode of ['always', 'when-empty']) {
      const msg = composeReviewPrompt('   ', mode);
      assert.ok(!msg.includes('另外'), `mode ${mode}`);
      assert.ok(msg.includes('未提交的改动'), `mode ${mode} still backstops with the brief`);
    }
  });
});

// ── formatReviewOutcome ───────────────────────────────────────────────────────

describe('formatReviewOutcome — one message shape for both entry points', () => {
  it('a successful review with content', () => {
    const text = formatReviewOutcome({ ok: true, reply: '两处问题：…', error: '' }, {});
    assert.ok(text.includes('两处问题'));
    assert.ok(!text.includes('失败'));
  });

  it('a failed review names the error', () => {
    const text = formatReviewOutcome({ ok: false, reply: '', error: 'provider 不可用' }, {});
    assert.ok(text.includes('失败'));
    assert.ok(text.includes('provider 不可用'));
  });

  it('an empty successful reply says so in words', () => {
    const text = formatReviewOutcome({ ok: true, reply: '   ', error: '' }, {});
    assert.ok(text.includes('没有输出任何结论'));
  });

  it('a task-scoped review names its scope', () => {
    const text = formatReviewOutcome({ ok: true, reply: 'x', error: '' }, { extra: '只看 diff' });
    assert.ok(text.includes('只看 diff'));
    // Default mode is when-empty: the text went through verbatim, so the label
    // says 「指令」, not 「附加要求」 (that one is the `always` mode's).
    assert.ok(text.includes('（指令：只看 diff）'));
    assert.ok(!text.includes('附加要求'));
  });

  it('in always mode the same text is an addendum', () => {
    const text = formatReviewOutcome(
      { ok: true, reply: 'x', error: '' },
      { extra: '只看 diff', mode: 'always' },
    );
    assert.ok(text.includes('（附加要求：只看 diff）'));
  });

  it('says out loud what happened to the auto-follow-up (红线 3: never silent)', () => {
    const woke = formatReviewOutcome(
      { ok: true, reply: 'x', error: '' },
      { continuation: { ok: true, code: '', error: '', woke: true, delivered: 'new-turn' } },
    );
    assert.match(woke, /已唤醒会话/);
    const queued = formatReviewOutcome(
      { ok: true, reply: 'x', error: '' },
      { continuation: { ok: true, code: '', error: '', woke: false, delivered: 'next-step' } },
    );
    assert.match(queued, /已排队交给模型/);
  });

  it('names a continuation that could not be delivered, and never on a failed review', () => {
    const undelivered = formatReviewOutcome(
      { ok: true, reply: 'x', error: '' },
      { continuation: { ok: false, code: 'agent-not-live', error: 'no live agent', woke: false, delivered: 'none' } },
    );
    assert.match(undelivered, /未能自动通知模型/);
    assert.match(undelivered, /agent-not-live/);
    // A failed review has no continuation line at all — there is nothing to
    // continue FROM, and rendering one would claim a handoff that never happened.
    const failed = formatReviewOutcome(
      { ok: false, reply: '', error: 'provider 不可用' },
      { continuation: { ok: true, code: '', error: '', woke: true, delivered: 'new-turn' } },
    );
    assert.doesNotMatch(failed, /已唤醒会话/);
  });
});

// ── mountReviewCommand — registration shape ──────────────────────────────────

describe('reviewScopeLabel — ONE renderer for the human reply and the model continuation', () => {
  it('is empty when the command carried no words of its own', () => {
    assert.equal(reviewScopeLabel('', 'when-empty'), '');
    assert.equal(reviewScopeLabel(undefined, 'always'), '');
    assert.equal(reviewScopeLabel('   ', 'never'), '');
  });

  it('calls the text an instruction in the two verbatim modes', () => {
    assert.equal(reviewScopeLabel('只看 diff', 'when-empty'), '（指令：只看 diff）');
    assert.equal(reviewScopeLabel('只看 diff', 'never'), '（指令：只看 diff）');
  });

  it('calls the same text an addendum when the built-in brief was still prepended', () => {
    assert.equal(reviewScopeLabel('只看 diff', 'always'), '（附加要求：只看 diff）');
  });

  it('trims, so padding does not travel into both readers', () => {
    assert.equal(reviewScopeLabel('  只看 diff  ', 'when-empty'), '（指令：只看 diff）');
  });
});

describe('mountReviewCommand — one registration, no service means no command', () => {
  it('registers a command whose name carries no leading slash', () => {
    const { registered, service } = captureCommands();
    const deps = sandboxDeps();
    const dispose = mountReviewCommand({ commands: service, ...deps });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, REVIEW_COMMAND_NAME);
    assert.equal(REVIEW_COMMAND_NAME, 'atomcode-review');
    assert.ok(!registered[0].name.startsWith('/'), 'the registry adds the slash, not us');
    assert.equal(typeof registered[0].handler, 'function');
    assert.equal(typeof registered[0].description, 'string');
    assert.ok(registered[0].description.length > 0, 'the picker needs a description to show');
    dispose();
  });

  it('advertises that the input may be EMPTY', () => {
    const { registered, service } = captureCommands();
    mountReviewCommand({ commands: service, ...sandboxDeps() });
    const hint = registered[0].input?.hint ?? '';
    assert.match(hint, /留空/, 'the hint must say the box can be left empty');
  });

  it('in never mode the hint stops promising an empty box', () => {
    const { registered, service } = captureCommands();
    mountReviewCommand({ commands: service, ...sandboxDeps({ reviewBriefMode: 'never' }) });
    const hint = registered[0].input?.hint ?? '';
    assert.match(hint, /需写明/);
    assert.ok(!hint.includes('可留空'), '「可留空」 would lie: an empty line is refused in never mode');
  });

  it('returns a disposer that unregisters, and a no-op when the service is absent', () => {
    const { service, registered } = captureCommands();
    const dispose = mountReviewCommand({ commands: service, ...sandboxDeps() });
    dispose();
    assert.equal(registered[0].__disposed, true);

    for (const absent of [undefined, null, {}, { register: 'not-a-function' }]) {
      assert.equal(typeof mountReviewCommand({ commands: absent, ...sandboxDeps() }), 'function');
    }
  });

  it('survives a registry that throws on register — the tools must still mount', () => {
    const logs = [];
    const dispose = mountReviewCommand({
      commands: {
        register() {
          throw new Error('duplicate command name');
        },
      },
      ...sandboxDeps(),
      log: (msg) => logs.push(msg),
    });
    assert.equal(typeof dispose, 'function', 'a failed registration still yields a disposer');
    assert.ok(
      logs.some((line) => line.includes('duplicate command name')),
      'a swallowed registration failure is 红线 3 — it must be logged by name',
    );
  });
});

// ── runReviewCommand — the review never becomes a model turn ─────────────────

describe('runReviewCommand — a refusal or a failure never touches the model', () => {
  it('in never mode an empty composer line is refused BEFORE any turn', async () => {
    // A review with no target and no scope would ask AtomCode to guess — so
    // the refusal fires before any daemon I/O, and the message names both
    // fixes (pass a target, or set the mode back to when-empty).
    const agent = recordingAgent({ cwd: 'C:\\work\\repo' });
    const deps = sandboxDeps({ reviewBriefMode: 'never' });
    const result = await runReviewCommand(
      { agent, rawInput: '', signal: new AbortController().signal },
      deps,
    );
    assert.equal(result.kind, 'error');
    assert.match(result.text, /不注入/);
    assert.match(result.text, /review_brief_mode/);
    assert.deepEqual(agent.calls, [], 'a refusal must not touch the model');
  });

  it('in never mode a NON-empty composer line still runs', async () => {
    // The refusal is about EMPTY text only: with a target the turn proceeds
    // (and hits the dead test port, which is the point of this branch — it
    // proves the message was composed, not refused).
    const agent = recordingAgent({ cwd: 'C:\\some\\repo' });
    const deps = sandboxDeps({ reviewBriefMode: 'never' });
    const result = await runReviewCommand(
      { agent, rawInput: '评审最近一次提交', signal: new AbortController().signal },
      deps,
    );
    assert.equal(result.kind, 'error', 'unreachable daemon → error result');
    assert.ok(!result.text.includes('不注入'), 'the composed message was not empty, so no refusal');
    assert.deepEqual(agent.calls, []);
  });

  it('refuses when no working directory is available (no daemon needed)', async () => {
    // The refusal fires BEFORE any daemon I/O: a sessionless agent with no
    // configured working_dir cannot resolve a target, so `runAsk` reports
    // `ok: false` with a working_dir refusal message.
    const agent = recordingAgent({ sessionless: true });
    const deps = sandboxDeps({ defaultWorkingDir: '' });
    const result = await runReviewCommand(
      { agent, rawInput: '', signal: new AbortController().signal },
      deps,
    );

    assert.equal(result.kind, 'error', 'no working dir → error');
    assert.match(result.text, /working_dir|拒绝|refus/i, 'the refusal must name the missing dir');
    assert.deepEqual(agent.calls, [], 'the command must not deliver anything to the model');
  });

  it('answers an invocation with no agent at all instead of crashing', async () => {
    const deps = sandboxDeps({ defaultWorkingDir: '' });
    const result = await runReviewCommand({ rawInput: '', signal: new AbortController().signal }, deps);
    assert.ok(result.kind === 'error', 'no agent and no working dir → error, not a crash');
    assert.equal(typeof result.text, 'string');
  });

  it('passes the composer line into the prompt as an addendum', async () => {
    // With a session cwd, runAsk WILL reach the daemon. Point it at a dead
    // port: the daemon is unreachable, `runAsk` returns `ok: false` with a
    // network error, and the command converts that to a readable message.
    // The key assertion: the composer text made it into the prompt, not
    // silently dropped.
    const agent = recordingAgent({ cwd: 'C:\\some\\repo' });
    const logs = [];
    const deps = sandboxDeps({ defaultWorkingDir: '', log: (m) => logs.push(m) });
    const result = await runReviewCommand(
      { agent, rawInput: '只看并发', signal: new AbortController().signal },
      deps,
    );
    // The daemon is at 127.0.0.1:0 — unreachable. The error is captured.
    assert.equal(result.kind, 'error', 'unreachable daemon → error result');
    assert.equal(typeof result.text, 'string');
    assert.ok(result.text.length > 0);
    assert.deepEqual(agent.calls, [], 'even a failure must not touch the model');
  });
});
