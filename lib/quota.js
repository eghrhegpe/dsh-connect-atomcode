//#region src/host/quota.ts
/**
* quota.ts — CodingPlan quota extraction from the daemon's `status` command.
*
* There is NO structured quota API: the daemon exposes `/health`, `/models`,
* `/providers`, `/config` and a catch-all SPA, and the SSE `done.stats` carries
* token counts only. The one place quota appears is the human-readable `text`
* returned by `POST /command {"command":"status"}`:
*
*   CodingPlan：CodingPlan Lite-体验版  ·  到期 2026-10-19（5d / 共 7d）
*   用量：当前时间窗口用量约 77%  ·  重置于 20:32（29m 13s 后）
*
* That text is LOCALIZED, so this parser keys on structure rather than prose
* wherever it can: "CodingPlan" is a proper noun, `%` is `%`, ISO dates and
* `Hh Mm Ss` durations are numerals. Label words are matched in both Chinese and
* English as a fallback. Anything unrecognized yields nulls plus the raw lines,
* so a caller can always fall back to showing the source text rather than
* inventing a number.
*
* Pure and dependency-free so it can be unit-tested against captured payloads.
*
* @module dsh-connect-atomcode/quota
*/
/** A plan line looks like `CodingPlan：<name> · 到期 <date>（<used> / 共 <total>）`. */
const PLAN_LABEL = /coding\s*plan/i;
/**
* Usage line: a percentage plus a reset hint.
*
* Deliberately NOT matching the bare word "window": English status text says
* "Usage: current window ~45%" (matched via `usage`), and a loose `window`
* would let an unrelated line like "Smoothing window: 50%" be mistaken for the
* usage line. The `%` gate in the caller already narrows this, but the label
* should still name the quota concept, not a generic noun.
*/
const USAGE_LABEL = /(用量|usage|quota)/i;
/**
* Usage-line selection.
*
* Both branches require a `%` (without one there is no usage number to report)
* AND a label that names the quota concept. The second branch exists for builds
* that dropped the label word but kept the reset wording; it is anchored on
* `重置于`/`resets at` rather than on any line merely CONTAINING "重置", so a
* shape-alike line about something else ("下一窗口 12:00") is not adopted as
* "the" usage line — a false positive there shows a fabricated percentage.
*/
const RESET_LABEL = /(?:重置于|resets?\s*(?:at)?\b|reset\s+at)/i;
/**
* Reverse-semantics markers: a percentage on a usage line that says what is
* LEFT rather than what is SPENT. `100% remaining` read as `limited` would
* tell the user their window is exhausted when it is full, so a line matching
* this is refused outright (see `parseIssue`).
*
* Deliberately narrow — `剩余|remaining|\bleft\b` are the shapes an English
* drift could actually produce. A bare `余` would also match 余额/余裕 and
* silently black out a healthy quota, which is the failure mode this guards.
*/
const REMAINING_LABEL = /(剩余|remaining|\bleft\b)/i;
const COLON = /[：:]/;
/**
* The daemon's OWN failure message, which is not a quota reading at all.
*
* Captured verbatim (AtomCode 5.2.3, a Lite trial that had expired):
*
*   CodingPlan：（状态获取失败 — parse status-v2 response (body: {"codingplan_free":
*   {"plan_name":"CodingPlan Lite","plan_type":null,"status":-1,"claimed_at":null,
*   "expires_at":null,"remaining_days":null,"total_days":30,"apply_id":null},
*   "current_usage":…): invalid type: null, expected i32 at line 1 column 136）
*
* Anchored on the daemon's own wording (`parse status-v2 response` is a
* private-protocol token, not translated prose), so a mere vocabulary change
* does NOT match here: this branch exists to say "the upstream is broken", which
* is a different fact from "we no longer recognize the text" — and a panel that
* confuses the two sends the reader hunting the wrong machine.
*/
const UPSTREAM_FAILURE = /parse\s+status-v2\s+response|状态获取失败/i;
/** The plan name inside the response body the daemon echoes back, when present. */
const BODY_PLAN_NAME = /"plan_name"\s*:\s*"([^"]*)"/;
/**
* "No live window" evidence inside that echoed body: a negative status, or the
* expiry / remaining-days fields answered as `null`. An EXPIRED plan answers
* exactly like this (verified by re-claiming with `atomcode login`, after which
* the same command carried a dated window again) — and it is the body that says
* so, not this parser guessing from the error text.
*/
const BODY_INACTIVE = /"status"\s*:\s*-\d|"expires_at"\s*:\s*null|"remaining_days"\s*:\s*null/;
/**
* Parse a duration like `29m 13s`, `1h29m`, `45s`, or `1h 2m 3s` into seconds.
* @param text
*/
function parseDurationSecs(text) {
	if (typeof text !== "string" || text.trim() === "") return null;
	const m = text.match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?!s))?\s*(?:(\d+)\s*s)?/i);
	if (!m || m[1] === void 0 && m[2] === void 0 && m[3] === void 0) return null;
	const hours = m[1] ? Number(m[1]) : 0;
	const mins = m[2] ? Number(m[2]) : 0;
	const secs = m[3] ? Number(m[3]) : 0;
	const total = hours * 3600 + mins * 60 + secs;
	return Number.isFinite(total) ? total : null;
}
/** First `HH:MM` (optionally seconds) token on a line. */
function firstClockTime(line) {
	const m = line.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
	return m ? m[1] ?? null : null;
}
/**
* Extract the CodingPlan quota from a daemon `status` command payload (or its
* raw `text`). Never throws.
*
* `parseIssue` names a line we REFUSED to interpret
* (`multiple-percentages` / `reverse-semantics`); it is the caller's cue to
* surface drift rather than render a number that may not be the usage.
*
* @param input - the command payload, or just its text.
*/
function parseStatusQuota(input) {
	const empty = {
		plan: null,
		expires: null,
		planWindow: null,
		usagePercent: null,
		resetAt: null,
		resetIn: null,
		resetInSecs: null,
		limited: false,
		parseIssue: null,
		upstreamFailure: null,
		raw: {
			planLine: null,
			usageLine: null
		}
	};
	const text = typeof input === "string" ? input : input && typeof input.text === "string" ? input.text : "";
	if (text.trim() === "") return empty;
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const planLine = lines.find((l) => PLAN_LABEL.test(l) && COLON.test(l)) ?? null;
	const usageLine = lines.find((l) => l.includes("%") && USAGE_LABEL.test(l)) ?? lines.find((l) => l.includes("%") && RESET_LABEL.test(l)) ?? null;
	const out = {
		...empty,
		raw: {
			planLine,
			usageLine
		}
	};
	if (lines.some((l) => UPSTREAM_FAILURE.test(l))) {
		const named = text.match(BODY_PLAN_NAME);
		out.upstreamFailure = {
			kind: BODY_INACTIVE.test(text) ? "plan-inactive" : "upstream-parse",
			planName: named ? (named[1] ?? "").trim() || null : null
		};
		return out;
	}
	if (planLine) {
		const [namePart = "", ...rest] = planLine.slice(planLine.search(COLON) + 1).trim().split(/\s*[·|]\s*/);
		const name = namePart.trim();
		out.plan = name.replace(/^coding\s*plan\s*/i, "").trim() || name || null;
		const tail = rest.join(" · ");
		const date = tail.match(/\b(\d{4}-\d{2}-\d{2})\b/);
		if (date) out.expires = date[1] ?? null;
		const paren = tail.match(/[（(]([^）)]*)[）)]/);
		if (paren) out.planWindow = (paren[1] ?? "").trim() || null;
		if (!out.planWindow) {
			const bare = tail.match(/(\d+\s*d\s*\/\s*[^·|]*\d+\s*d)/i);
			if (bare) out.planWindow = (bare[1] ?? "").trim();
		}
	}
	if (usageLine) {
		const pcts = usageLine.match(/\d+(?:[.,]\d+)?\s*%/g) ?? [];
		if (pcts.length > 1) out.parseIssue = "multiple-percentages";
		else if (REMAINING_LABEL.test(usageLine)) out.parseIssue = "reverse-semantics";
		else if (pcts.length === 1) {
			const value = Number((pcts[0] ?? "").replace(/[^0-9.,]/g, "").replace(",", "."));
			if (Number.isFinite(value)) out.usagePercent = value;
		}
		const labelled = usageLine.match(/(?:重置于|resets?\s*(?:at)?)\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/i);
		out.resetAt = labelled ? labelled[1] ?? null : firstClockTime(usageLine);
		const paren = usageLine.match(/[（(]([^）)]*)[）)]/);
		if (paren) {
			const inner = (paren[1] ?? "").trim();
			const secs = parseDurationSecs(inner);
			if (secs !== null) {
				out.resetIn = inner;
				out.resetInSecs = secs;
			}
		}
	}
	out.limited = out.usagePercent !== null && out.usagePercent >= 100;
	return out;
}
/**
* Shape the quota section of the plugin stats snapshot.
*
* @param result - a `runCommand('status')` outcome.
* @param fetchedAt - epoch ms of the fetch (for client-side countdown).
* @returns the `quota` branch of the stats body.
*/
function buildQuotaReport(result, fetchedAt) {
	if (!result || result.ok !== true) return {
		available: false,
		reason: result && (result.message || result.error) || "status command unavailable",
		fetchedAt
	};
	const parsed = parseStatusQuota(result.text);
	const found = parsed.usagePercent !== null && parsed.parseIssue === null;
	const ISSUE_REASON = {
		"multiple-percentages": "用量行含多个百分数，无法判定哪个是窗口用量（已拒绝猜测，不显示百分比）",
		"reverse-semantics": "用量行按\"剩余\"语义表述，与本面板的\"已用\"语义相反（已拒绝换算，不显示百分比）"
	};
	const UPSTREAM_REASON = {
		"plan-inactive": "额度未生效：网关未给出生效窗口（到期时间与剩余天数都是空 —— 本机实测的 CodingPlan 过期形态）",
		"upstream-parse": "额度不可用：AtomCode 解析网关的 status-v2 响应失败（原文见下）"
	};
	return {
		available: true,
		...parsed,
		fetchedAt,
		reason: parsed.upstreamFailure ? UPSTREAM_REASON[parsed.upstreamFailure.kind] + (parsed.upstreamFailure.planName ? `（网关报的套餐是 ${parsed.upstreamFailure.planName}）` : "") : parsed.parseIssue ? ISSUE_REASON[parsed.parseIssue] : found ? "" : parsed.plan !== null ? "用量行未被识别（daemon 的 status 文本可能已升级），计划行正常" : "status text carried no recognisable quota line",
		drift: !found
	};
}

//#endregion
export { buildQuotaReport, parseDurationSecs, parseStatusQuota };