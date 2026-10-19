/**
 * message-ask.ts — the 锐评 entry in one assistant message's action row.
 *
 * WHAT IT DOES NOW (2026-10-18, 方针 A): clicking it PRE-FILLS the official
 * `/atomcode-review <quoted reply>` command into the composer. The user presses
 * Enter once and the HOST runs the review (zero DSH model turns), then hands the
 * outcome back with one named "continue your task" instruction. Nothing is sent
 * by this component, nothing is delivered, and no popover opens.
 *
 * WHAT IT USED TO DO, and why the change: it opened the plugin's own 问 Atom
 * popover with the reply already quoted — a private channel that fired the
 * plugin's `/ask` route and rendered the answer where only that popover could
 * show it. The user's verdict on that panel was 「非常失败锐评面板，输入透明，但
 * 运行过程全程黑箱」, and the official command already does the same job with a
 * transcript row and a session scope. See `./review-handoff.ts` for the
 * the removal decision and `docs/DECISIONS.md` for the record.
 *
 * THE PROBLEM IT STILL SOLVES, in the user's words: 「把 dsh 的最终回复填入开头，
 * 然后末尾补一句，锐评改动是否合理」. The slash command needs that reply as its
 * argument, and typing it out by hand is the friction this button removes.
 *
 * WHY IT IS LEGAL: `conversation.chat.assistant-actions`'s OWNER passes
 * `{ messageId }` as owner props and `useChat` as a standard prop, so the button
 * READS the message the host's own 复制 button reads, via `messageTextOf` — the
 * text is handed to us by the conversation: not fetched, not scraped, not
 * synthesised. The P2 verdict in docs/DECISIONS.md forbids the plugin SPEAKING
 * into the session; reading a rendered reply and prefilling a composer the human
 * then submits is the opposite of that.
 *
 * ONE component, no full/degraded pair: it needs no portal, no anchoring, and no
 * primitive hooks — a single button that calls `requestReview({ text })`.
 *
 * @module dsh-connect-atomcode/client/message-ask
 */
import type { ReactElement } from 'react';
import { messageTextOf } from './rows.ts';
import { MESSAGE_ACTION_STYLE } from './styles.ts';

/** What the button needs from the factory: renders one element, hands back the
 * quoted reply. No React imports, no browser globals. */
export interface MessageAskDeps {
  h: (type: any, props?: any, ...children: any[]) => ReactElement;
  /**
   * Holds the inline "指令没插入" note after a failed prefill. OPTIONAL on
   * purpose: the button's job — pre-filling `/atomcode-review` — does not need
   * it, and every other hook here is injected at the factory. When it is absent
   * the note is dropped and the failure stays on the console (`review-handoff.ts`),
   * exactly as before this note existed.
   */
  useState?: <T>(initial: T) => [T, (value: T | ((prev: T) => T)) => void];
  /**
   * Pre-fill `/atomcode-review` with this message's prose.
   *
   * Returns false when the composer could not take the text (no rail, draft
   * moved, input not writable). The caller has no surface to paint that into —
   * the composer is the surface — so the boolean is informational, and
   * `review-handoff.ts` names the failure on the console.
   *
   * `text` is null when the projection did not carry the message's prose; the
   * command is then inserted WITHOUT an argument, which reviews the working tree
   * — "quoted nothing" and "could not find it" stay different failures (红线 3:
   * a silent failure must become a named one, and the console line says which).
   */
  requestReview: (request: { text: string | null }) => boolean;
}

/**
 * Build the row button.
 *
 * @param {MessageAskDeps} deps
 * @returns {(props: any) => ReactElement | null} the component; null when the
 * row's ownerProps carry no `messageId` (the host skips the whole row in that
 * case, so this is a belt-and-braces guard, not a normal path).
 */
export function createMessageAsk(deps: MessageAskDeps) {
  const { h, useState, requestReview } = deps;

  function MessageAsk(props: any) {
    // Hook order matters and both hooks sit ABOVE the `messageId` guard (see the
    // note on the `useChat` call below): a hook after an early return is a
    // conditional hook, and React would throw once `messageId` started arriving
    // late. `note` is what a failed prefill looks like to the human who just
    // clicked — the console line `review-handoff.ts` writes is invisible next to
    // a button that visibly did nothing, so it is echoed here instead. The
    // fallback arms the branch with a no-op pair when the factory did not hand
    // `useState` over; the hook count stays constant either way (it only depends
    // on whether `useState` exists, which never changes for one component).
    const [note, setNote] =
      typeof useState === 'function' ? useState('') : ['', () => {}];
    const messageId = props && props.messageId;
    // The hook runs before the `messageId` guard, on purpose. A hook called
    // AFTER an early return is a conditional hook: if `messageId` ever arrived
    // late the hook count would change between renders and React would throw.
    //
    // SUBSCRIBE HERE, IN RENDER. `useChat` is a store SUBSCRIPTION hook, not a
    // getter: calling it inside an event handler reads the store once, outside
    // any subscription, and — measured on this host — handed back an EMPTY
    // snapshot (`nodes=0 kinds=none`) every single time. That was the real
    // reason 锐评 could never find the reply; the two earlier fixes chased the
    // node SHAPE while the store was empty all along.
    //
    // The selector returns the whole snapshot because `messageTextOf` needs the
    // node store, not one derived string; the extra re-renders are acceptable
    // for a leaf button, and narrowing it would have to be re-derived anyway
    // when the projection changes.
    let snapshot: any = null;
    try {
      snapshot = typeof props.useChat === 'function' ? props.useChat((state: any) => state) : null;
    } catch {
      snapshot = null;
    }
    const onClick = () => {
      // `messageTextOf` returns null when the message is not in the snapshot and
      // '' when it is there but carries no prose (a tool-only step). Both are
      // passed through: the command still runs, just without a quote.
      let text: string | null = null;
      try {
        text = messageTextOf(snapshot, messageId);
      } catch {
        text = null;
      }
      if (text === null) consoleWarning(messageId, snapshot);
      const ok = requestReview({ text });
      // `false` means the composer could not take the text: the rail was not
      // mounted, or the draft moved underneath us. The prefill did NOT land, so
      // leaving the row silent would read as a broken button; name it here.
      if (ok) setNote('');
      else setNote('指令没插入：请在输入框手动输入 /atomcode-review，再按回车。');
    };
    // The guard sits BELOW the hook (see above); the row is simply empty without
    // an id, which the host never sends.
    if (typeof messageId !== 'string' || messageId === '') return null;
    const button = h(
      'button',
      {
        type: 'button',
        style: MESSAGE_ACTION_STYLE,
        onClick,
        title: '把这条回复一起填入 /atomcode-review，按回车让 AtomCode 核对改动是否合理',
      },
      '锐评'
    );
    if (note === '') return button;
    // A note and the button it qualifies, side by side. `role="status"` makes the
    // failure announceable (live region) instead of only visible.
    return [
      button,
      h(
        'span',
        {
          key: 'note',
          role: 'status',
          style: {
            color: '#b26b4b',
            fontSize: 11,
            lineHeight: MESSAGE_ACTION_STYLE.lineHeight,
            marginLeft: 6,
            whiteSpace: 'nowrap',
          },
        },
        note
      ),
    ];
  }

  return MessageAsk;
}

/**
 * Say WHY the reply could not be read. This is a diagnostic, not a fallback: the
 * click still inserts the command, and the human still gets a directory-scoped
 * review. The line exists because "quoted nothing" and "could not find the
 * message" look identical from the composer, and the second one means the chat
 * projection changed shape.
 */
function consoleWarning(messageId: any, snapshot: any) {
  try {
    if (typeof console === 'undefined' || !console || typeof console.warn !== 'function') return;
    let report = 'snapshot unavailable';
    try {
      const values =
        snapshot && snapshot.nodes && typeof snapshot.nodes.values === 'function' ? snapshot.nodes.values() : [];
      const kinds: string[] = [];
      for (const node of values) {
        if (node && typeof node.kind === 'string' && !kinds.includes(node.kind)) kinds.push(node.kind);
      }
      report = 'nodes=' + values.length + ' kinds=' + (kinds.length === 0 ? 'none' : kinds.join(','));
    } catch (error: any) {
      report = 'store unreadable: ' + String(error && error.message ? error.message : error);
    }
    console.warn('[atomcode-bridge] 锐评: message ' + messageId + ' not found in the chat snapshot; ' + report);
  } catch {
    /* a console we cannot write to must not break the click */
  }
}
