/**
 * `/atomcode-review` — one AtomCode review started from the composer, without
 * passing through the model.
 *
 * WHY THIS EXISTS AT ALL. A `tool/result` row in the transcript can only be
 * produced by the agent loop from a model-returned tool call — a plugin cannot
 * fabricate one, and `ctx.tools.execute()` runs a tool without leaving any
 * transcript trace. A slash command is the one host channel that executes
 * against the receiving agent WITHOUT sending the command to the model (see
 * `CommandDefinition.handler`: "Execute against the receiving agent without
 * sending the command to the model"), which is exactly the `/compact` shape:
 * zero LLM calls, the work happens in the Host, and the human sees the result.
 *
 * ONE CHANNEL, NOT TWO. This used to call `runReview`, which spawned the
 * `atomcodex` CLI and demanded a direct-provider endpoint (a local sidecar,
 * usually). That second channel meant a second provider NAMESPACE, a second set
 * of failure modes, and a feature that went dark whenever the sidecar was down
 * while `atomcode_ask` kept working. It now runs through `runAsk` — the daemon,
 * the same channel the tool uses — so a review cannot be "unavailable" while
 * asking works. What it gives up is the CLI's structured `findings[]` document;
 * AtomCode still reads the tree and writes a report, it just writes prose.
 *
 * NOT A TOOL CALL. Deliberately not dressed up as one: no `tool/result` row is
 * fabricated, and this does not pretend to be one.
 *
 * CLOSING THE LOOP (方针 A+continue, 2026-10-18). A review alone left the model
 * unaware that anything had happened — the human saw the report, the model did
 * not. On success this now hands the outcome to the session's model with ONE
 * named "continue your task" instruction (`injectReviewContinuation`). That is
 * the single steer/inject the refined 红线 allows: the REVIEW itself stays
 * host-side and zero DSH turns; only the follow-up touches the model, and the
 * command reply names what happened.
 *
 * @module
 */
import { runAsk } from './tools.ts';
import { injectReviewContinuation } from './inject.ts';
import type { InjectOutcome } from './inject.ts';
import type { HostConfig, ReviewBriefMode } from './config.ts';
import type { Runtime } from './runtime.ts';

/** The command name as registered (no leading slash). */
export const REVIEW_COMMAND_NAME = 'atomcode-review';

/**
 * The review brief `composeReviewPrompt` fills in — which depends on the plugin
 * config `review_brief_mode` (always / when-empty / never, see that function's
 * doc block). Historically the brief was sent on EVERY invocation, and that is
 * still the `always` mode; the shipped default is `when-empty`, so the brief is
 * the fallback for an empty composer line and non-empty text goes through
 * verbatim.
 */
const REVIEW_BRIEF =
  '评审当前工作区里未提交的改动（git 未提交改动；没有未提交改动时看最近一次提交）。' +
  '自己运行 git 命令确认范围，必要时读相关文件理解上下文，然后给出评审结论：' +
  '哪些地方有问题、为什么、怎么改。只报你确实看见的问题，不要猜。';

/**
 * Build the message one review turn sends to AtomCode.
 *
 * What an empty composer line becomes depends on `mode` (the plugin config
 * `review_brief_mode`, closed set `REVIEW_BRIEF_MODES`):
 *
 * - `always` — the brief is sent on every review, and non-empty text is
 *   appended after it. The pre-2026-10-18 behaviour: a greeting like 「打个
 *   招呼」 still ran a full review because the brief was never omitted.
 * - `when-empty` (shipped default) — the brief is sent only when the text is
 *   empty; non-empty text goes through verbatim, without the brief.
 * - `never` — the brief is never sent; the text goes through verbatim, and an
 *   empty text yields `''`, which the CALLER must refuse (a review with no
 *   target and no scope is a wasted turn, so it fails fast and visibly).
 *
 * This is the brief text for the `/atomcode-review` command. It used to have a
 * twin (`DEFAULT_REVIEW_TASK` in `tools.ts`) for the retired `atomcode_review`
 * tool; the command keeps its own copy so a command-started review still asks
 * the same thing.
 */
export function composeReviewPrompt(extra: string, mode: ReviewBriefMode = 'when-empty'): string {
  const note = typeof extra === 'string' ? extra.trim() : '';
  if (mode === 'always') return note === '' ? REVIEW_BRIEF : `${REVIEW_BRIEF}\n\n另外：${note}`;
  if (mode === 'never') return note;
  return note === '' ? REVIEW_BRIEF : note;
}

/**
 * Render the one auto-follow-up a successful review issues (方针 A+continue).
 *
 * The refined 红线 allows exactly ONE steer/inject after a host-side review:
 * handing the outcome to the session's model as "continue your task". The line
 * is rendered into the command reply so the human sees what happened (红线 3 —
 * named, never silent).
 */
export function continuationLine(cont: InjectOutcome | undefined): string {
  if (!cont) return '';
  if (cont.ok) {
    return cont.woke
      ? '\n\n（已唤醒会话：评审结论已交给模型，让它继续原任务）'
      : '\n\n（评审结论已排队交给模型，随下一轮继续原任务）';
  }
  return `\n\n（未能自动通知模型继续原任务：${cont.code} — ${cont.error}）`;
}

/**
 * How the user's own words entered the review message, as the ONE label shared
 * by the command reply and the model-facing continuation.
 *
 * `always` APPENDS the text to the brief (「附加要求」); the two other modes sent
 * it VERBATIM (「指令」). One renderer, not two: the human reads the label in the
 * command result and the model reads it in the continuation, and if the two
 * disagreed the continuation's premise ("review this") would be unverifiable.
 */
export function reviewScopeLabel(extra: unknown, mode: ReviewBriefMode): string {
  const note = typeof extra === 'string' ? extra.trim() : '';
  if (note === '') return '';
  return mode === 'always' ? `（附加要求：${note}）` : `（指令：${note}）`;
}

/** Render one review outcome as the plain text a command result carries. */
export function formatReviewOutcome(
  outcome: { ok: boolean; reply?: string; error?: string },
  args: { extra?: string; mode?: ReviewBriefMode; continuation?: InjectOutcome } = {},
): string {
  const extra = typeof args.extra === 'string' ? args.extra.trim() : '';
  const mode = args.mode === 'always' || args.mode === 'when-empty' || args.mode === 'never' ? args.mode : 'when-empty';
  const scope = reviewScopeLabel(extra, mode);
  if (outcome.ok) {
    const body = (outcome.reply || '').trim();
    // A review that succeeded but produced no text is not an error, but an
    // empty message would render as a bare heading, so say it in words.
    const base =
      body === '' ? `AtomCode 审查完成${scope}：没有输出任何结论。` : `AtomCode 审查完成${scope}：\n\n${body}`;
    return base + continuationLine(args.continuation);
  }
  return `AtomCode 审查失败${scope}：${outcome.error || '未知错误'}`;
}

/**
 * Run one review for a command invocation and answer with its text.
 *
 * Returns a `CommandResult`, never throws: the command contract records a
 * thrown handler as `kind: 'error'`, and that path would lose the turn's own
 * explanation. Every failure becomes a message the human can read.
 */
export async function runReviewCommand(
  invocation: any,
  { config, runtime, log }: { config: HostConfig; runtime: Runtime; log: (msg: string) => void },
) {
  const sessionId = typeof invocation?.agent?.id === 'string' ? invocation.agent.id : '';
  const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';

  if (sessionId !== '' && runtime.isReviewInFlight(sessionId)) {
    return {
      kind: 'error',
      text: '这个会话已有一个 AtomCode 审查在跑，等它结束再发一次。',
    };
  }

  // A command invocation carries no tool-call context, so the workspace comes
  // from the session header — the same field `dsh-code-review` reads. `runAsk`
  // then runs its own ladder: explicit arg > this session cwd > the plugin's
  // `working_dir` > refuse (红线 8 — never the host process cwd).
  const cwd = invocation?.agent?.session?.header?.cwd;
  const mode = runtime.resolveBriefMode().mode as import('./config.ts').ReviewBriefMode;
  const message = composeReviewPrompt(raw, mode);
  if (message === '') {
    // Only reachable in `never` mode with an empty composer line: a review with
    // no target and no scope would ask AtomCode to guess, so refuse it here,
    // before any turn is spent. The message names the fix on both sides.
    return {
      kind: 'error',
      text:
        '当前 review_brief_mode 是「不注入」（never），/atomcode-review 后面必须写明评审目标（内置简报不再自动补上）。' +
        '例如「/atomcode-review 评审最近一次提交」；或在 patch 里把 review_brief_mode 改回 when-empty，留空即评审未提交改动。',
    };
  }

  // The guard is runtime-owned (not a module-level set) so teardown releases a
  // session id left mid-review by an unmount — see `runtime.ts`.
  if (sessionId !== '') runtime.beginReview(sessionId);
  const startedAt = Date.now();
  try {
    const outcome = await runAsk(
      { message, ...(typeof cwd === 'string' ? { working_dir: cwd } : {}) },
      // No host tool-call context exists here. `signal` is forwarded so Ctrl-C
      // in the composer cancels the turn instead of orphaning it.
      invocation?.signal ? { signal: invocation.signal } : {},
      { config, runtime },
    );
    log(`command /${REVIEW_COMMAND_NAME} finished in ${Date.now() - startedAt}ms (ok=${outcome.ok})`);
    // 方针 A+continue: on success, hand the review outcome to the session's
    // model as a NAMED "continue your task" instruction — the ONE steer/inject
    // the refined 红线 allows. The review itself stayed host-side and zero DSH
    // turns; only this follow-up touches the model, and its result is rendered
    // into the command reply so the human sees it (红线 3).
    const continuation =
      outcome.ok && sessionId !== ''
        ? injectReviewContinuation(
            { agent: invocation?.agent ?? null },
            { reviewReply: outcome.reply, model: outcome.provider, scope: reviewScopeLabel(raw, mode) },
          )
        : undefined;
    return {
      kind: outcome.ok ? 'success' : 'error',
      text: formatReviewOutcome(outcome, { extra: raw, mode, continuation }),
    };
  } catch (error: any) {
    // `runAsk` reports failures as `ok: false` rather than throwing, but a
    // plugin must not rest its own no-crash guarantee on that contract.
    const message = String(error && error.message ? error.message : error);
    log(`command /${REVIEW_COMMAND_NAME} threw: ${message}`);
    return { kind: 'error', text: `AtomCode 审查异常终止：${message}` };
  } finally {
    if (sessionId !== '') runtime.endReview(sessionId);
  }
}

/**
 * Register the command, returning the disposer.
 *
 * `commands` is passed in rather than looked up, so a Host without the service
 * degrades to "no command" instead of failing the mount — the same shape the
 * other optional services in `apply()` use.
 */
export function mountReviewCommand({
  commands,
  config,
  runtime,
  log,
}: {
  commands: any;
  config: HostConfig;
  runtime: Runtime;
  log: (msg: string) => void;
}): () => void {
  if (typeof commands?.register !== 'function') return () => {};
  try {
    return commands.register({
      name: REVIEW_COMMAND_NAME,
      description: '用 AtomCode 审查当前工作区改动（不经过模型，不消耗 DSH 额度）',
      // The composer line is OPTIONAL extra guidance — EXCEPT in `never` brief
      // mode, where an empty line is refused, so the hint must not promise it.
      // The hint is registered at mount time, and the mount-time config value
      // is the one the next invocation honours (a patch edit only takes
      // effect on reload), so naming the mode here is a mount-time fact, not
      // a prediction. `attachments` stays undeclared (false): the executor
      // rejects an invocation carrying them, and a review reads the TREE, not
      // pasted files.
      input: {
        hint: config.reviewBriefMode === 'never'
          ? '需写明评审目标（brief 注入模式为「不注入」，留空会被拒绝）'
          : '可留空：直接审查未提交改动；或补充要求（如"重点看并发"）',
      },
      handler: (invocation: any) => runReviewCommand(invocation, { config, runtime, log }),
    });
  } catch (error: any) {
    // A duplicate name or a rejected definition must not take the tools down
    // with it — the command is an addition, not a load-bearing part of the mount.
    log(`command registration failed: ${String(error && error.message ? error.message : error)}`);
    return () => {};
  }
}
