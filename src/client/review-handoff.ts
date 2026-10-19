/**
 * review-handoff.ts — how the transcript's 锐评 row reaches the official
 * `/atomcode-review` command.
 *
 * WHAT THIS FILE USED TO BE, and why it is not that any more (2026-10-18,
 * 方针 A). It was the 问 Atom chip: a button in the composer tool row that
 * opened a plugin-owned popover with its own free-form box, fired the plugin's
 * own `/api/atomcode-bridge/ask` route, rendered the answer inside the popover,
 * and offered 「送到会话」 to hand it to the session model. The user's verdict
 * was 「非常失败锐评面板，输入透明，但运行过程全程黑箱」 — a second, private
 * channel beside the host's own surfaces, whose run nobody could watch.
 *
 * The decision (recorded in `docs/DECISIONS.md`) is that the plugin does not own
 * a channel:
 *
 *   · a one-click review is the `/atomcode-review` slash command — executed by
 *     the Host, zero DSH model turns, its result written into the transcript
 *     exactly like any other command's;
 *   · a free-form question is the model's own `atomcode_ask` tool.
 *
 * The popover, the ask POST, the delivery POST and their styling are GONE with
 * the `/ask` route they called. What is left is the ONE thing the 锐评 row in a
 * different seat genuinely needs, and the reason this module still exists.
 *
 * WHY A SEAT EARNS TWO LINES OF CODE. `conversation.chat.assistant-actions` —
 * where the 锐评 button lives (`./message-ask.ts`) — is handed `{ messageId }` as
 * owner props and `useChat` as a standard prop. It is NOT handed the composer's
 * `inputActions`. Only a seat inside the composer carries that rail, so the row
 * cannot fill the composer by itself. `ReviewRail` below is registered on
 * `conversation.input.left` and does exactly one thing: capture
 * `props.inputActions` into this module's closure on every render. It renders
 * `null` — deliberately, and the empty render is the honest shape: this is a
 * plumbing connection, not a control the user should ever see.
 *
 * THE HAND-OFF IS A PREFILL, NOT A SEND. Clicking 锐评 inserts
 * `/atomcode-review <quoted reply>` at the caret and stops — with the reply
 * capped at {@link QUOTE_LIMIT} characters, and a note in the text when it is
 * (see that constant: the quote is echoed onto three surfaces, so the only
 * unbounded thing in this module would be the click itself). The human presses
 * Enter, and the HOST runs the review. Nothing here talks to the network, and
 * nothing here spends a model turn (红线: the plugin's only ways to touch the
 * session model are `followup`/`steer`/`inject`, and none of them appears in this
 * file).
 *
 * WHEN THE PREFILL FAILS it says so in the console and returns false. It used to
 * paint a note into the popover; the popover is gone, and the composer is now the
 * only honest surface — if the command did not appear, the click visibly did
 * nothing. A silent `return` would be the one thing 红线 3 forbids, so the
 * failure is named on the diagnostic channel `./message-ask.ts` already uses.
 *
 * @module dsh-connect-atomcode/client/review-handoff
 */

/** The diagnostic channel, prefixed like every other client-side message. */
function warn(message: string) {
  try {
    if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
      console.warn('[atomcode-bridge] ' + message);
    }
  } catch {
    /* a console we cannot write to is not worth breaking a click over */
  }
}

/**
 * Put `text` at the composer's caret using the seat's own insertion rail.
 *
 * NEVER `setDraft`: replacing the user's draft is destructive. `captureInsertion`
 * + `insertText` appends at the caret and reports whether the draft MOVED between
 * capture and insert — that `false` is the signal that the text did not land.
 *
 * @param {any} actions the composer's `inputActions` (from the seat's props)
 * @param {string} text what to insert
 * @param {string} what the human-facing name of the text, for the failure note
 * @returns {boolean} true when the insertion landed
 */
function insertIntoDraft(actions: any, text: string, what: string): boolean {
  if (!actions || typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') {
    warn('这个宿主没有暴露输入框操作，' + what + '没插入，请手动输入 /atomcode-review');
    return false;
  }
  let span: any = undefined;
  try {
    span = actions.captureInsertion();
  } catch {
    warn('输入框当前不可写，' + what + '没插入，请手动输入 /atomcode-review');
    return false;
  }
  const moved = actions.insertText(text, span) !== true;
  if (moved) warn('输入框内容变了，' + what + '没落地，请手动输入 /atomcode-review');
  return !moved;
}

/**
 * How much of the reply is quoted into the prefill.
 *
 * The prefill is the ONE place the quote is created, and everything downstream
 * inherits its size: the composer holds it, Enter commits it as the user
 * message, the command result repeats it inside `（指令：…）`
 * (`src/host/command.ts`), and the continuation instruction injects that label
 * back to the session model. An uncapped quote therefore turns a long answer
 * into a wall the human scrolls past in three places and the reviewer pays for
 * in tokens — while what a review actually needs from an answer is its point,
 * which is at the top.
 *
 * The limit is NOT about the composer's cost: the host's trigger scan is linear
 * at ~1.5 µs/KB of draft (measured), so a 30 KB quote costs ~40 µs per
 * keystroke — no jank to avoid. This is about the three surfaces a human reads.
 */
const QUOTE_LIMIT = 4000;

/** The sentence that makes the omission visible instead of silent. */
function truncatedNote(originalLength: number, keptLength: number): string {
  return `\n…（此处只引回答前 ${keptLength} 字，原文共 ${originalLength} 字，其余已省略；要 AtomCode 看别的片段，请手动补进这条指令）`;
}

/**
 * Cut `text` to `limit` characters without splitting a surrogate pair.
 *
 * `String.prototype.slice` counts UTF-16 units, so cutting between an emoji's
 * halves leaves an orphaned high surrogate — it renders as `�` in the composer
 * and travels that way into the reviewer's instruction.
 */
function cutAt(text: string, limit: number): string {
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * The command line one click pre-fills: the official command, plus the asked-for
 * reply as its argument — capped, and saying so when it caps.
 *
 * @param reply the quoted reply; `''` for none.
 * @returns the text to insert (never empty).
 */
function prefillFor(reply: string): string {
  if (reply === '') return '/atomcode-review';
  if (reply.length <= QUOTE_LIMIT) return '/atomcode-review ' + reply;
  const kept = cutAt(reply, QUOTE_LIMIT);
  return '/atomcode-review ' + kept + truncatedNote(reply.length, kept.length);
}

/**
 * Build the hand-off pair: the null-rendering rail and the prefill function.
 *
 * @returns {{
 *   ReviewRail: (props: any) => null,
 *   requestReview: (input: { text: string | null }) => boolean,
 *   __setInsertForTest: (fn: ((text: string, what: string) => boolean) | null) => void,
 * }}
 */
export function createReviewHandoff() {
  /**
   * Set by `ReviewRail` on every render (it owns `inputActions`); null before the
   * composer has rendered. Module-closure state, not a hook: `requestReview` is
   * called from a DIFFERENT seat's component, outside this tree.
   */
  let insertDraftFor: ((text: string, what: string) => boolean) | null = null;

  /**
   * Hand one assistant message over by pre-filling the official
   * `/atomcode-review` slash command.
   *
   * WHY THE SLASH COMMAND: it is the canonical path. It runs in the Host (zero
   * DSH model turns), its result is written to the transcript, and it is
   * session-scoped. The button's only job is to save the user from typing the
   * command and quoting the reply by hand.
   *
   * @param {{ text?: string | null }} input the quoted reply; `null`/`''` is
   * legal and degrades to a directory-scoped review.
   * @returns {boolean} true when the command reached the composer.
   */
  function requestReview(input: { text?: string | null }): boolean {
    const reply = input && input.text !== null && input.text !== undefined ? String(input.text) : '';
    // `/atomcode-review <additional instruction>`: the host handler always adds
    // its own review brief; the quoted reply becomes the extra instruction that
    // tells AtomCode what the DSH model just did and asks it to check the change.
    // `prefillFor` owns the cap and the note that explains it.
    if (insertDraftFor === null) {
      warn('输入框还没挂载，锐评指令没插入，请手动输入 /atomcode-review');
      return false;
    }
    return insertDraftFor(prefillFor(reply), '锐评指令');
  }

  /**
   * The `conversation.input.left` occupant: `null`, and that is the whole point.
   *
   * It exists so the composer's `inputActions` has an owner inside a seat that
   * carries it. Registration costs nothing visually — the seat renders an empty
   * child — and it is what makes the 锐评 row able to fill the composer at all.
   */
  function ReviewRail(props: any) {
    const actions = props && props.inputActions;
    insertDraftFor = (text: string, what: string) => insertIntoDraft(actions, text, what);
    return null;
  }

  return {
    ReviewRail,
    requestReview,
    /**
     * TEST SEAM, not an API: installs the insertion rail before any rail has
     * rendered, which is the only way to exercise `requestReview` without a
     * component tree. Production sets it from `ReviewRail`; nothing in the
     * plugin calls this.
     */
    __setInsertForTest(fn: ((text: string, what: string) => boolean) | null) {
      insertDraftFor = fn;
    },
  };
}
