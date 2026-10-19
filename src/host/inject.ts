/**
 * Delivering the post-review continuation to the session's model.
 *
 * WHAT THIS MODULE IS NOW
 * -----------------------
 * Exactly ONE named message: after `/atomcode-review` finishes, the review text
 * is handed to the session's model as "continue your original task". That is the
 * single sanctioned use of `steer`/`inject` in this plugin (红线 3, refined
 * 2026-10): the review BODY never touches the model, and this continuation is
 * the one follow-up the user's click authorises.
 *
 * Anything else that once lived here is GONE, deliberately. `injectAtomcodeAnswer`
 * and `composeInjection` served the retired `/inject` route — a panel button that
 * pushed an AtomCode answer into a session by hand. When that route was deleted
 * (2026-10-19: no in-repo caller, no identity gate, a POST that can wake an idle
 * driver) its composing helper and its delivery entry point stayed behind with
 * zero production callers, kept alive only by their own tests. `routes.ts` warns
 * about exactly that shape — "zero callers is how a dead ABI surface survives" —
 * and the doc comments here had already started describing a mount that did not
 * exist. `setCreateUserMessageOverride` went with them: it existed so a route
 * that built its own deps could be tested, and there is no such route.
 *
 * WHY THIS PATH IS LEGAL AT ALL
 * -----------------------------
 * DSH has a first-class, PUBLIC channel for this — `Agent.inject(message)`
 * (`dsh-agent`, runtime-types.d.ts), documented as "Queue model-facing context
 * for the next pre-step without waking the driver". It is a `UserMessage` by
 * construction, but its `source` is whatever the producer writes, and that is
 * merge-extensible on purpose: the shipped goal driver writes
 * `source: { kind: 'goal', … }` and prepends it to `next-step` itself. So "a
 * plugin puts a message in front of the model, attributed to itself rather than
 * to the user" is a designed pathway, not a workaround.
 *
 * WHICH METHOD, AND WHY IT IS NOT OPTIONAL
 * ----------------------------------------
 * `inject()` never wakes the driver. **That first reading was wrong for an idle
 * session**: the message waited forever and the button looked broken. The split
 * now lives in one place — running sessions take `inject()` (attach to the turn
 * in flight, never interrupt it), idle ones take `steer()` (wake, and start the
 * one turn that reads this) — and the outcome names which happened. 红线 3 sits
 * here too: every refusal is NAMED, never a silent no-op.
 *
 * "Pending is not delivered": the same doc comment says a driver may miss a
 * message whose pre-step already claimed its batch, and that cancellation or
 * disposal may discard pending context. So `ok: true` means QUEUED, never "the
 * model has read it" — the outcome word is `delivered: 'next-step'` for that
 * reason, and the review's own copy/insert path stays the path that cannot be
 * dropped.
 *
 * @module dsh-connect-atomcode/host/inject
 */
import { createRequire } from 'node:module';

/** Bound on one injected message. A review can be long; a runaway one is a bug. */
export const INJECT_TEXT_LIMIT = 200000;

/**
 * The message factory, resolved lazily from the Host.
 *
 * `@deepseek-ai/dsh-llm` is a `neverBundle` external (see `tsdown.config.mjs`),
 * so `require` here reaches the copy the Host process already loaded — the one
 * whose message identities the session log understands. Cached after the first
 * success; a failed lookup is cached too, because a Host that cannot resolve it
 * will not resolve it a second later, and a retry loop would just re-throw.
 */
let createUserMessageCache: { value: ((input: any) => any) | null } | undefined;

/**
 * Resolve `createUserMessage` from the Host's module graph.
 *
 * @returns the factory, or null when this Host cannot resolve `dsh-llm`. Null is
 *   REPORTED by the caller as a named refusal — never used to skip delivery.
 */
export function resolveCreateUserMessage(): ((input: any) => any) | null {
  if (createUserMessageCache !== undefined) return createUserMessageCache.value;
  try {
    // `createRequire` with this file's URL keeps the resolution anchored to the
    // plugin's own dependency graph, which is how it finds the Host's copy
    // rather than a bundler-private duplicate.
    const require = createRequire(import.meta.url);
    const loaded = require('@deepseek-ai/dsh-llm');
    const factory = loaded?.createUserMessage;
    createUserMessageCache = { value: typeof factory === 'function' ? factory : null };
  } catch {
    // The failure is not swallowed: the caller turns a null factory into the
    // `llm-unavailable` refusal, which the command reply renders by name (红线 3).
    createUserMessageCache = { value: null };
  }
  return createUserMessageCache.value;
}

/**
 * The `source.kind` stamped on every message this module writes.
 *
 * It is what makes the message attributable: the DSH UI and any later reader
 * can tell this apart from something the user typed, and the model is told the
 * same thing in the text itself (see `composeContinuation`). Do not reuse
 * `'user'` — that is the claim this avoids making.
 */
export const INJECT_SOURCE_KIND = 'atomcode-bridge';

/**
 * What a successful delivery actually did, in the driver's own vocabulary.
 *
 * - `'next-step'` — `agent.inject()`. The session was RUNNING, so the message is
 *   claimed at the nearest later step boundary of the turn already in flight.
 *   Non-waking by contract, and the reason it is only used when there is already
 *   a turn to attach to.
 * - `'new-turn'` — `agent.steer()`. The session was IDLE, and `inject()` would
 *   have left the message parked forever ("idle drivers leave it pending until
 *   follow-up or steering wakes them" — the runtime-types contract). Steering
 *   wakes the driver and starts ONE turn whose only content is this message.
 *
 * Both are "accepted by the driver", neither is "the model has read it": a
 * cancellation or a disposal may still discard pending context.
 */
export type InjectDelivery = 'next-step' | 'new-turn';

export type InjectOutcome =
  | { ok: true; messageId: string; sessionId: string; delivered: InjectDelivery; woke: boolean }
  | { ok: false; error: string; code: InjectErrorCode };

/**
 * Every refusal this module can produce, by name.
 *
 * Deliberately only the codes a REACHABLE path can return: `agents-unavailable`
 * and `session-id-required` belonged to the deleted `injectAtomcodeAnswer`
 * (which looked an agent up in the registry and therefore needed both a service
 * and an id). The continuation receives the agent directly, so neither state
 * exists here — keeping them in the union would be a vocabulary for branches
 * that cannot run.
 */
export type InjectErrorCode =
  | 'llm-unavailable'
  | 'text-required'
  | 'text-too-large'
  | 'agent-not-live'
  | 'inject-failed';

/**
 * The continuation message handed to the model after a review finishes.
 *
 * This IS an instruction to continue the original task — the user asked for
 * one-click automation (方针 A+continue, 2026-10). It still stamps the same
 * `source.kind` (`atomcode-bridge`, never `'user'`) so the model can tell it
 * apart from user speech; what differs from a "second opinion" is only what the
 * model is asked to do with it.
 *
 * @param reviewReply - the review outcome text (already trimmed by the caller).
 * @param meta - optional provenance and scope; each field is omitted when absent.
 * @param meta.scope - the already-rendered label for the user's own words
 *   (`（指令：…）` / `（附加要求：…）`), so the model knows what was asked for.
 * @returns the model-facing text.
 */
export function composeContinuation(
  reviewReply: string,
  meta: { model?: string; scope?: string } = {},
): string {
  const who =
    meta.model !== undefined && meta.model !== ''
      ? `AtomCode（另一个独立的 AI 编程助手，档位 ${meta.model}）`
      : 'AtomCode（另一个独立的 AI 编程助手）';
  // The user's own words, carried into the injection. Without them the model
  // reads a review and cannot tell WHAT was asked — it would have to guess the
  // requirement before judging the conclusion. The label is rendered by the
  // command (see `reviewScopeLabel`) so the human's command reply and the
  // model's continuation name the instruction identically.
  const scope = typeof meta.scope === 'string' && meta.scope.trim() !== '' ? meta.scope.trim() : '';
  return [
    `${who}刚完成一次工作区评审${scope}，结论如下：`,
    '',
    '--- 评审开始 ---',
    reviewReply,
    '--- 评审结束 ---',
    '',
    '据此继续原任务，不必等用户确认；结论可能有误，必要时读代码核对。',
  ].join('\n');
}

/**
 * Build the message, then hand it to the driver in the phase-correct way.
 *
 * One caller today, kept as its own function because it is the part that carries
 * the phase split and the attribution contract — the reasoning below is the
 * module's whole risk surface, and a second caller would otherwise copy it.
 *
 * `buildText` is a function, not a string, so a throw from composing still lands
 * in the `inject-failed` catch below.
 */
function deliverMessage(options: {
  agent: any;
  createUserMessage: (input: any) => any;
  buildText: () => string;
  /** Omitted by the continuation path, which reads the id off the agent itself. */
  sessionId?: string;
  /** The caller's own wording for an unexpected throw. */
  failPrefix: string;
}): InjectOutcome {
  const { agent, createUserMessage, buildText, failPrefix } = options;
  try {
    const message = createUserMessage({
      // `content` is `readonly ContentBlock[]`, NOT a string — the field's own
      // doc comment says "Exact model-facing blocks". Passing a bare string here
      // shipped once and blew up a live turn: the UI showed ~200 「未知内容块」
      // (one per character of an unknown `type`) and the step died with
      // `content.some is not a function`, because a string has no `.some`.
      // `TextBlock` is exactly `{ type: 'text', text }`.
      content: [{ type: 'text', text: buildText() }],
      source: { kind: INJECT_SOURCE_KIND },
    });
    // WHICH METHOD depends on the driver's phase, and getting this wrong is
    // silent, which is how it shipped wrong the first time: `inject()` does not
    // wake an idle driver, so on a session nobody is running the message parked
    // in the inbox forever and the click looked like nothing happened. The
    // contract is explicit — "idle drivers leave it pending until follow-up or
    // steering wakes them" — so an idle session gets `steer()`, the non-silent
    // twin that differs from `inject()` by exactly one argument:
    //     inject(input) { this.send(input, 'next-step', false) }
    //     steer(input)  { this.send(input, 'next-step', true)  }
    //
    // The old text here argued a click "must never start a model turn". That was
    // the wrong reading of the UI: the verb is a request for the model to read
    // this, so when nothing is running, starting the turn IS the verb. What stays
    // true is the weaker promise — started ≠ read — so the outcome says which of
    // the two happened and never claims the model saw it.
    //
    // `status` is the driver's own getter ('idle' | 'running'), not an inbox
    // guess: maintenance counts as idle there, which is what we want (a
    // maintenance phase sets `wakeRequested` and runs a turn next).
    //
    // An ABSENT status is read as running, i.e. the conservative direction: a
    // message that parks is recoverable (the next turn picks it up) while an
    // extra model turn costs money and cannot be taken back. Only a positive
    // `'idle'` earns the wake.
    const idle = agent.status === 'idle';
    if (idle) agent.steer(message);
    else agent.inject(message);
    return {
      ok: true,
      messageId: String(message.id),
      sessionId: options.sessionId !== undefined ? options.sessionId : String(agent.id ?? ''),
      delivered: idle ? 'new-turn' : 'next-step',
      woke: idle,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'inject-failed', error: `${failPrefix}: ${reason}` };
  }
}

/**
 * Hand the "review complete, continue your task" instruction to the agent that
 * just ran the review.
 *
 * This is the host-side half of the one-click automation (方针 A+continue): the
 * `/atomcode-review` handler stays zero-DSH-turns for the REVIEW itself, then
 * wakes (idle) or queues (running) exactly ONE follow-up turn whose only content
 * is the continuation. The agent is passed directly — the command handler
 * already holds `invocation.agent` — so no `ctx.agents` lookup is involved.
 * 红线 (refined 2026-10): a named continuation is the ONE steer/inject the
 * handler may issue; it must never use them to run the review itself.
 *
 * @param deps.agent - the live agent for the session the review ran in.
 * @param deps.createUserMessage - optional override; when omitted this module
 *   resolves the Host's own copy through {@link resolveCreateUserMessage}. The
 *   parameter exists so tests can drive the pure function without a module graph.
 * @param input.reviewReply - the review outcome text to hand to the model.
 * @param input.model - optional AtomCode model profile for provenance.
 * @param input.scope - optional already-rendered label for the user's own words.
 * @returns what happened, with every refusal named.
 */
export function injectReviewContinuation(
  deps: { agent: any; createUserMessage?: (input: any) => any },
  input: { reviewReply?: unknown; model?: unknown; scope?: unknown },
): InjectOutcome {
  // `??` would treat an explicit `null` override as "not given" and resolve the
  // real factory instead — which silently defeats the caller that passes null on
  // purpose (the tests that pin the llm-unavailable branch). Only an OMITTED
  // property means "resolve it yourself".
  const createUserMessage =
    'createUserMessage' in deps ? deps.createUserMessage : resolveCreateUserMessage();

  if (deps.agent === undefined || deps.agent === null) {
    return {
      ok: false,
      code: 'agent-not-live',
      error: 'no live agent for the session the review ran in: the continuation was not delivered',
    };
  }

  if (typeof input.reviewReply !== 'string' || input.reviewReply.trim() === '') {
    return { ok: false, code: 'text-required', error: 'reviewReply is required and must be a non-empty string' };
  }
  if (input.reviewReply.length > INJECT_TEXT_LIMIT) {
    return { ok: false, code: 'text-too-large', error: `reviewReply is larger than ${INJECT_TEXT_LIMIT} characters` };
  }

  // A Host whose module graph does not expose `dsh-llm` cannot build the message
  // at all, and saying so beats a TypeError from inside `createUserMessage`.
  if (typeof createUserMessage !== 'function') {
    return {
      ok: false,
      code: 'llm-unavailable',
      error: 'this host did not expose @deepseek-ai/dsh-llm: cannot build the continuation message',
    };
  }

  const reviewReply = input.reviewReply.trim();

  return deliverMessage({
    agent: deps.agent,
    createUserMessage,
    // No sessionId: the continuation names the session the review ran in, which
    // the agent already knows.
    buildText: () =>
      composeContinuation(reviewReply, {
        model: typeof input.model === 'string' ? input.model : undefined,
        scope: typeof input.scope === 'string' ? input.scope : undefined,
      }),
    failPrefix: 'could not deliver the continuation',
  });
}
