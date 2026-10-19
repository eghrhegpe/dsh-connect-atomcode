//#region src/host/codingplan.ts
/** A string field, or null — an empty/whitespace string is an ABSENT value here. */
function str(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
/** A finite number, or null. Booleans and numeric strings are NOT numbers here. */
function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** A plain object, or null — arrays and null are rejected. */
function rec(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function parseWindow(input) {
	const w = rec(input);
	if (!w) return null;
	const out = {
		metric: str(w.metric),
		hours: num(w.window_hours),
		limit: num(w.limit),
		used: num(w.used),
		usagePercent: num(w.usage_percent),
		exhausted: w.quota_exhausted === true,
		resetAt: str(w.next_reset_display) ?? str(w.next_reset_at),
		resetInSecs: num(w.seconds_until_reset)
	};
	return out.usagePercent === null ? null : out;
}
/**
* Parse `GET /codingplan/usage/summary`.
*
* @returns the reduced summary, or `null` when the payload is not a usable
*          reading (unavailable, not an object, or nothing the panel can show).
*/
function parseUsageSummary(input) {
	const root = rec(input);
	if (!root || root.available !== true) return null;
	const plan = rec(root.plan);
	const name = plan ? str(plan.name) : null;
	const totalDays = plan ? num(plan.total_days) : null;
	const remainingDays = plan ? num(plan.remaining_days) : null;
	const out = {
		planName: name ? name.replace(/^coding\s*plan\s*/i, "").trim() || name : null,
		expires: plan ? str(plan.expires_at) : null,
		planWindow: remainingDays !== null && totalDays !== null ? `${remainingDays}d / 共 ${totalDays}d` : null,
		window: parseWindow(root.primary_window)
	};
	return out.window === null ? null : out;
}
/**
* Parse `GET /codingplan/usage/daily`.
*
* @param input - the raw payload.
* @param keepDays - how many trailing days to keep. The endpoint returns 60; the
*   panel shows a week, and the stats route is polled every 5s, so the whole
*   history would be re-sent for nothing.
* @returns the trimmed history, or `null` when there is none to show.
*/
function parseUsageDaily(input, keepDays = 14) {
	const root = rec(input);
	if (!root || root.available !== true || !Array.isArray(root.rows)) return null;
	const rows = [];
	for (const entry of root.rows) {
		const row = rec(entry);
		if (!row) continue;
		const date = str(row.date);
		if (date === null) continue;
		rows.push({
			date,
			tokens: num(row.total_tokens) ?? 0,
			requests: num(row.total_requests) ?? 0
		});
	}
	if (rows.length === 0) return null;
	rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
	const models = Array.isArray(root.models) ? root.models.filter((m) => typeof m === "string" && m !== "") : [];
	return {
		schemaVersion: num(root.schema_version),
		days: num(root.days),
		startDate: str(root.start_date),
		endDate: str(root.end_date),
		models,
		rows: rows.slice(-Math.max(1, keepDays))
	};
}
/**
* Map a structured summary onto the stats body's `quota` branch, so the panel
* keeps ONE reading shape and the existing card renders it unchanged.
*
* @param summary - a `parseUsageSummary` result.
* @param fetchedAt - epoch ms of the fetch (the client counts down from it).
*/
function summaryQuotaReport(summary, fetchedAt) {
	const w = summary.window;
	const usagePercent = w ? w.usagePercent : null;
	return {
		available: true,
		source: "codingplan-json",
		sourceNote: "",
		plan: summary.planName,
		expires: summary.expires,
		planWindow: summary.planWindow,
		usagePercent,
		resetAt: w ? w.resetAt : null,
		resetIn: null,
		resetInSecs: w ? w.resetInSecs : null,
		limited: w !== null && (w.exhausted || usagePercent !== null && usagePercent >= 100),
		parseIssue: null,
		upstreamFailure: null,
		windowLimit: w ? w.limit : null,
		windowUsed: w ? w.used : null,
		windowHours: w ? w.hours : null,
		windowMetric: w ? w.metric : null,
		raw: {
			planLine: null,
			usageLine: null
		},
		reason: "",
		drift: false,
		fetchedAt
	};
}

//#endregion
export { parseUsageDaily, parseUsageSummary, summaryQuotaReport };