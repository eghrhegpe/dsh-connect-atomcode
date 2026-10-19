/**
 * closed-sets.ts — the two closed enumerations this plugin knows about, in ONE
 * place shared by both halves.
 *
 * `config.ts` (host validation) and `panel-controls.ts` (the panel's dropdowns)
 * used to carry their own literal copies of the same two lists, with the
 * premium/approval set also duplicated in `panel-settings-store.ts`. A new
 * daemon mode then had to be edited in three files, and nothing pinned the
 * panel's menus to the validator's set — the dropdown could drift from what the
 * route accepts.
 *
 * This module is the single source. The host side reads it for validation and
 * rejection messages; the client side reads it for the dropdown options; a
 * client-render test pins the rendered <option> values back to this list.
 *
 * TL;DR of the two enums:
 *
 *  - `APPROVAL_MODES` — values the daemon ACCEPTS for `approval_mode`, a closed
 *    enum measured, not assumed (`docs/AtomCode-CLI与daemon接口参考.md`
 *    §approval_mode; probe `scripts/probes/approval-mode.mjs`, 2026-10-17
 *    against daemon 5.2.3, which enumerated it through the 422 parameter gate
 *    at zero quota). The daemon answers an unknown value with a 422 on EVERY
 *    `/chat`, so a typo in the patch file would fail every ask turn at the wire
 *    instead of at validation — the closed set exists to catch it earlier.
 *    When this list is ever widened, widen `test/stats-route.test.mjs` with it.
 *
 *  - `REVIEW_BRIEF_MODES` — the closed set the review brief injection accepts,
 *    a plugin-side enum (no daemon gate): it picks which prompt
 *    `runReviewCommand` / `/atomcode-review` send when the user text is empty.
 *    `always` — brief on every review, user text appended after it;
 *    `when-empty` — brief only when user text is empty (shipped default);
 *    `never` — brief never sent, empty text refused by the caller.
 *
 * @module dsh-connect-atomcode/shared/closed-sets
 */

/**
 * The `approval_mode` values the daemon accepts.
 *
 * A value outside the set is refused at config time and the field falls back to
 * `DEFAULT_APPROVAL_MODE` (config.ts); the raw spelling rides on
 * `approvalModeRejected` so failures stay observable.
 */
export const APPROVAL_MODES = ['build', 'accept_edits', 'bypass', 'plan'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Human-readable list for the panel/log, derived so it can never drift from the enum above. */
export const APPROVAL_MODES_TEXT = APPROVAL_MODES.join(' / ');

/**
 * The closed set `review_brief_mode` accepts (see the module header for the
 * per-mode semantics). A spelling outside the set is refused and the field
 * falls back to `DEFAULT_REVIEW_BRIEF_MODE` (config.ts); the raw spelling rides
 * on `reviewBriefModeRejected`, mirroring `approvalModeRejected`.
 */
export const REVIEW_BRIEF_MODES = ['always', 'when-empty', 'never'] as const;
export type ReviewBriefMode = (typeof REVIEW_BRIEF_MODES)[number];