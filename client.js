(function() {

//#region src/client/styles.ts
/** The shared small button skin (刷新 / 折叠头). */
	const BUTTON = {
		height: 28,
		padding: "0 10px",
		borderRadius: 8,
		border: "1px solid var(--dsw-alias-border-l2)",
		background: "var(--dsw-alias-bg-layer-2)",
		color: "var(--dsw-alias-label-primary)",
		fontSize: 12,
		cursor: "pointer",
		appearance: "none",
		fontFamily: "inherit"
	};
	const S = {
		page: {
			flex: "1 1 auto",
			height: "100%",
			minHeight: 0,
			display: "flex",
			flexDirection: "column",
			overflow: "hidden",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			lineHeight: "20px"
		},
		cluster: {
			display: "inline-flex",
			alignItems: "center",
			gap: 10,
			flexWrap: "wrap",
			justifyContent: "flex-end",
			alignSelf: "center"
		},
		live: {
			fontSize: 11,
			padding: "2px 8px",
			borderRadius: 999,
			color: "var(--dsw-alias-state-success-primary)",
			border: "1px solid var(--dsw-alias-state-success-primary)"
		},
		liveStale: {
			color: "var(--dsw-alias-state-error-primary)",
			borderColor: "var(--dsw-alias-state-error-primary)"
		},
		updated: {
			fontSize: 11,
			color: "var(--dsw-alias-label-tertiary)"
		},
		staleReason: {
			color: "var(--dsw-alias-state-error-primary)",
			maxWidth: "40ch",
			fontSize: 11
		},
		refresh: BUTTON,
		scroll: {
			flex: "1 1 auto",
			minHeight: 0,
			overflowY: "auto",
			overflowX: "hidden"
		},
		content: {
			padding: "2px 0 24px",
			display: "flex",
			flexDirection: "column",
			gap: 12
		},
		inFlight: {
			display: "flex",
			alignItems: "center",
			gap: 8,
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-bg-layer-1)",
			borderRadius: 10,
			padding: "8px 12px",
			fontSize: 12.5,
			lineHeight: "18px"
		},
		inFlightDot: {
			width: 6,
			height: 6,
			borderRadius: "50%",
			background: "var(--dsw-alias-state-success-primary)",
			flexShrink: 0
		},
		inFlightLabel: {
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)",
			whiteSpace: "nowrap"
		},
		inFlightText: {
			color: "var(--dsw-alias-label-secondary)",
			wordBreak: "break-word"
		},
		notice: {
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-bg-layer-1)",
			borderRadius: 10,
			padding: "12px 14px",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12.5
		},
		error: {
			color: "var(--dsw-alias-state-error-primary)",
			fontSize: 12.5
		},
		tabs: {
			display: "flex",
			flexDirection: "column",
			gap: 12
		},
		tabRow: {
			display: "flex",
			alignItems: "stretch",
			gap: 12,
			borderBottom: "1px solid var(--dsw-alias-border-l1)"
		},
		tabBar: {
			display: "flex",
			gap: 4,
			overflowX: "auto"
		},
		spacer: { flex: "1 1 auto" },
		tab: {
			appearance: "none",
			background: "none",
			border: "none",
			borderBottom: "2px solid transparent",
			padding: "8px 12px",
			display: "flex",
			alignItems: "center",
			gap: 4,
			fontSize: 13,
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			outline: "none",
			fontFamily: "inherit",
			whiteSpace: "nowrap"
		},
		tabActive: {
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600,
			borderBottom: "2px solid var(--dsw-alias-accent, #6C5CE7)"
		},
		tabAlert: {
			color: "var(--dsw-alias-state-warn-primary)",
			fontWeight: 700
		},
		paneBanner: { gridColumn: "1 / -1" },
		tabPane: {
			display: "grid",
			gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
			gap: 12,
			alignItems: "start"
		},
		section: {
			border: "1px solid var(--dsw-alias-border-l1)",
			borderRadius: 12,
			background: "var(--dsw-alias-bg-layer-1)",
			overflow: "hidden"
		},
		sectionHead: {
			appearance: "none",
			display: "flex",
			alignItems: "center",
			gap: 10,
			width: "100%",
			padding: "10px 14px",
			background: "none",
			border: "none",
			cursor: "pointer",
			textAlign: "left",
			fontFamily: "inherit"
		},
		sectionTitle: {
			margin: 0,
			flex: "1 1 auto",
			minWidth: 0,
			fontSize: 13,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		},
		chevron: {
			display: "inline-flex",
			flex: "none",
			transition: "transform 0.15s ease",
			color: "var(--dsw-alias-label-secondary)"
		},
		chevronOpen: { transform: "rotate(180deg)" },
		sectionBody: {
			borderTop: "1px solid var(--dsw-alias-border-l1)",
			margin: "0 14px",
			padding: "10px 0 12px"
		},
		row: {
			display: "flex",
			alignItems: "baseline",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 12.5,
			lineHeight: "18px",
			minHeight: "18px"
		},
		key: {
			color: "var(--dsw-alias-label-tertiary)",
			flexShrink: 0
		},
		val: {
			color: "var(--dsw-alias-label-primary)",
			wordBreak: "break-word",
			textAlign: "right"
		},
		pill: {
			display: "inline-block",
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			fontWeight: 600,
			lineHeight: "18px",
			whiteSpace: "nowrap"
		},
		valIdle: {
			color: "var(--dsw-alias-label-secondary)",
			wordBreak: "break-word",
			textAlign: "right"
		},
		valWarn: {
			color: "var(--dsw-alias-state-warn-primary)",
			wordBreak: "break-word",
			textAlign: "right"
		},
		provGrid: {
			display: "flex",
			gap: 12,
			fontSize: 12.5
		},
		provCell: {
			display: "flex",
			flexDirection: "column",
			gap: 4,
			flex: "1 1 0",
			minWidth: 0
		},
		provFieldRow: {
			display: "flex",
			alignItems: "center",
			gap: 8,
			minWidth: 0
		},
		provLabel: {
			color: "var(--dsw-alias-label-tertiary)",
			flexShrink: 0
		},
		select: {
			font: "inherit",
			fontSize: 12.5,
			color: "var(--dsw-alias-label-primary)",
			background: "transparent",
			border: "1px solid rgba(128, 128, 128, 0.35)",
			borderRadius: 5,
			padding: "2px 6px",
			maxWidth: "100%",
			width: "100%"
		},
		selectOff: { opacity: .55 },
		metric: {
			display: "flex",
			flexDirection: "column",
			gap: 2,
			padding: "10px 12px",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-layer-2)"
		},
		metricNum: {
			fontSize: 20,
			fontWeight: 650,
			lineHeight: "24px",
			letterSpacing: "-0.02em",
			fontVariantNumeric: "tabular-nums"
		},
		metricLabel: {
			fontSize: 11,
			color: "var(--dsw-alias-label-secondary)"
		},
		bar: {
			height: 6,
			borderRadius: 3,
			background: "var(--dsw-alias-bg-layer-1)",
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l1)"
		},
		barFill: {
			height: "100%",
			borderRadius: 3
		},
		callGroups: {
			display: "flex",
			gap: 16,
			flexWrap: "wrap",
			alignItems: "baseline"
		},
		callGroup: {
			display: "flex",
			gap: 12,
			alignItems: "baseline",
			paddingRight: 16,
			borderRight: "1px solid var(--dsw-alias-border-l1)"
		},
		callGroupLabel: {
			fontSize: 11,
			color: "var(--dsw-alias-label-tertiary)",
			whiteSpace: "nowrap"
		},
		callStat: {
			fontSize: 13,
			fontWeight: 600,
			whiteSpace: "nowrap",
			fontVariantNumeric: "tabular-nums"
		},
		callStatLabel: {
			marginLeft: 3,
			fontSize: 11,
			fontWeight: 400,
			color: "var(--dsw-alias-label-tertiary)"
		},
		panelHead: {
			display: "flex",
			alignItems: "baseline",
			gap: "8px",
			margin: "0 0 8px"
		},
		panelTitle: {
			fontSize: "12px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-secondary)"
		},
		panelPct: {
			marginLeft: "auto",
			fontSize: "16px",
			fontWeight: 700,
			lineHeight: "20px",
			fontVariantNumeric: "tabular-nums",
			color: "var(--dsw-alias-label-primary)",
			display: "inline-flex",
			alignItems: "baseline",
			gap: "6px"
		},
		panelLimited: {
			fontSize: "11px",
			fontWeight: 600,
			color: "var(--dsw-alias-state-error-primary)"
		},
		panelTrack: {
			height: "6px",
			borderRadius: "3px",
			border: "1px solid var(--dsw-alias-border-l1)",
			overflow: "hidden",
			margin: "0 0 8px"
		},
		panelFact: {
			margin: "0 0 2px",
			fontSize: "12px",
			lineHeight: "18px",
			color: "var(--dsw-alias-label-secondary)"
		},
		panelFactLead: {
			margin: "0 0 2px",
			fontSize: "12px",
			lineHeight: "18px",
			color: "var(--dsw-alias-label-secondary)"
		},
		panelSurface: {
			zIndex: 1100,
			boxSizing: "border-box",
			position: "fixed",
			borderRadius: "var(--dsw-radius-lg)",
			background: "var(--dsw-specific-menu)",
			backdropFilter: "var(--dsw-menu-backdrop-filter)",
			boxShadow: "var(--dsw-elevation-prominent)",
			"--dsw-elevation-stroke-color": "var(--dsw-alias-border-l1)",
			border: 0,
			color: "var(--dsw-alias-label-primary)",
			cursor: "default",
			padding: "12px",
			width: "min(264px, 100vw - 24px)",
			fontSize: "12px",
			lineHeight: "20px"
		}
	};
	/**
	* The chip's outer pill, drawn as one of the dock's READOUTS.
	*
	* Deliberately weaker than a control: no pill background, no border.
	* Its neighbours (`1 轮 1 步`, `19.1K tok`) are session-scoped products;
	* this one is an account-scoped environment fact that happens to be
	* visible here. The `tertiary` token alone carries that distinction.
	*
	* `color` overrides the text color ONLY for the one state that is a real
	* alarm — an exhausted window throttles turns, so it must not be styled
	* like decoration.
	*/
	function CHIP_STYLE(color) {
		return {
			fontSize: "11px",
			lineHeight: "16px",
			color,
			whiteSpace: "nowrap",
			display: "inline-flex",
			alignItems: "center"
		};
	}
	/**
	* The trigger: bare text, no chrome of its own. `font: inherit` keeps the
	* host's composer typography so the strip does not change height when the
	* chip mounts.
	*/
	const CHIP_TRIGGER_STYLE = {
		font: "inherit",
		fontSize: "inherit",
		lineHeight: "inherit",
		color: "inherit",
		background: "transparent",
		border: "none",
		padding: 0,
		cursor: "pointer",
		whiteSpace: "nowrap",
		WebkitAppearance: "none"
	};
	/**
	* The 锐评 entry in an assistant message's own action row. One state only: the
	* button pre-fills a slash command and returns, so it has no busy state to show
	* (the turn it starts belongs to the composer, not to this row).
	*/
	const MESSAGE_ACTION_STYLE = {
		font: "inherit",
		fontSize: "11px",
		lineHeight: "16px",
		color: "var(--dsw-alias-label-tertiary)",
		background: "transparent",
		border: "none",
		borderRadius: "4px",
		padding: "2px 4px",
		cursor: "pointer",
		whiteSpace: "nowrap",
		WebkitAppearance: "none"
	};

//#endregion
//#region src/client/quota.ts
	function fmtDuration(ms) {
		if (!Number.isFinite(ms) || ms <= 0) return "—";
		const n = ms;
		if (n < 1e3) return Math.round(n) + " ms";
		return (n / 1e3).toFixed(1) + " s";
	}
	/**
	* Compact countdown for the CodingPlan rolling-window reset.
	*
	* Rounds ONCE, up front, then does integer arithmetic. Rounding the seconds
	* remainder on its own (`Math.round(s % 60)`) prints "4m60s" during the half
	* second before every minute ticks over — 299.99 came out as `4m60s`, a
	* countdown that reads like a bug in the panel it is meant to reassure.
	*/
	function fmtCountdown(secs) {
		if (!Number.isFinite(secs) || secs < 0) return "—";
		const s = Math.round(secs);
		if (s >= 3600) return Math.floor(s / 3600) + "h" + Math.floor(s % 3600 / 60) + "m";
		if (s >= 60) return Math.floor(s / 60) + "m" + s % 60 + "s";
		return s + "s";
	}
	/**
	* Compact token count: `951K` / `23.9M` / `1.2B`.
	*
	* Tokens are the one quantity this panel ever shows in the tens of millions, and
	* the daemon's own digits (`23851383`) are unreadable at a glance while a fully
	* localized number is noise in a column of rows. One decimal below 100 of a unit,
	* none above; `—` for anything that is not a finite non-negative number, so a
	* missing field can never reach the panel as `NaN`.
	*/
	function fmtTokens(n) {
		if (!Number.isFinite(n) || n < 0) return "—";
		const v = n;
		for (const [size, suffix] of [
			[1e9, "B"],
			[1e6, "M"],
			[1e3, "K"]
		]) if (v >= size) {
			const scaled = v / size;
			return (scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1)) + suffix;
		}
		return String(Math.round(v));
	}
	/** Quota colour: the window being exhausted is the only true error state. */
	function quotaColor(percent, limited) {
		if (limited || typeof percent === "number" && percent >= 100) return "var(--dsw-alias-state-error-primary)";
		return "var(--dsw-alias-label-primary)";
	}
	/**
	* Seconds remaining, counted down locally between polls.
	*
	* A negative result means the snapshot is stale (the window reset since the
	* fetch), which is NOT the same as "no data": the caller must clamp to 0
	* and keep showing "已重置" rather than rendering the "—" of a null input.
	*/
	function liveRemaining(resetInSecs, fetchedAt, nowMs) {
		if (typeof resetInSecs !== "number" || !Number.isFinite(resetInSecs)) return null;
		if (!Number.isFinite(fetchedAt)) return null;
		return Math.max(0, resetInSecs - Math.round((nowMs - fetchedAt) / 1e3));
	}
	/** The chip label / progress-bar width, given an already-clamped percent. */
	function pctLabel(percent) {
		if (typeof percent !== "number" || !Number.isFinite(percent)) return "—";
		return Math.round(percent) + "%";
	}
	/** Bar width percent, clamped into [0,100]. */
	function barWidth(percent) {
		if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
		return Math.max(0, Math.min(100, percent));
	}
	/**
	* Merge the panel's surface style with the measured anchor position.
	*
	* The merge ORDER is the whole bug surface here: `Object.assign({}, surface,
	* anchored, {left:0, top:0})` looks harmless but clobbers the measured
	* coordinates. The off-screen fallback may apply ONLY while the anchoring
	* hook has not measured yet (it returns null).
	*/
	function panelStyle(surface, anchored) {
		return Object.assign({}, surface, anchored ?? {
			visibility: "hidden",
			left: 0,
			top: 0
		});
	}
	/**
	* The chip's panel text, as a LIST of facts.
	*
	* Split rather than pre-joined so the panel can lay each row out on its
	* own line; `null` entries are dropped, which is what lets a partially-known
	* quota show the rows it has instead of a ragged sentence with holes.
	*
	* These rows sit UNDER a header that already says "CodingPlan 额度" next to a
	* large percent and a progress bar, so two facts are deliberately NOT here:
	*   - the product name (the header says it; "CodingPlan Lite-体验版" said it
	*     twice inside a 264px panel) — the plan row carries the PLAN alone;
	*   - "窗口已用 N%" (the big number and the bar are the same fact).
	* A row that repeats the surface above it is not a fact, it is noise. What is
	* left is what the header CANNOT show: the plan tier, the window/expiry, and
	* the live countdown.
	*/
	function quotaFacts(quota, liveSecs) {
		return [
			quota.plan || null,
			[quota.expires, quota.planWindow].filter(Boolean).join(" · "),
			liveSecs === null ? null : "约 " + fmtCountdown(liveSecs) + " 后重置"
		].filter(Boolean);
	}
	/**
	* The window descriptor, for the one place that needs to NAME the window
	* rather than time it: the "this window is exhausted" line on the detail page.
	*
	* Prefer the descriptor the daemon actually reported (`planWindow`, parsed from
	* the status text) over the historical "5小时" default — a 7-day plan must not
	* be labelled "5小时窗口". Falls back to "5小时" only when the daemon did not
	* expose one at all.
	*
	* NOT used by the dock chip any more. The chip used to read
	* `atom · 3d / 共 7d 2%`, which glued a PLAN-PERIOD figure (the `（5d / 共 7d）`
	* parenthetical sits on the `到期 <date>` line: days left of the billing
	* period) to the ROLLING-WINDOW usage percent. Two different clocks, one
	* string, so it read as "2% of 7 days". The chip now leads with the countdown
	* that actually governs when quota comes back.
	*/
	function windowLabel(planWindow) {
		return typeof planWindow === "string" && planWindow.trim() !== "" ? planWindow.trim() : "5小时";
	}
	/**
	* The dock chip's text: what is used, and when it comes back.
	*
	* `atom · 2% · 29m13s 后重置` — deliberately NOT the plan period. See
	* `windowLabel` for why that was wrong: the user cares when the rolling window
	* refills, not how many days of the subscription remain. The countdown is the
	* part that goes stale between polls, so it is omitted rather than faked when
	* the snapshot cannot support one (same rule as the panel rows).
	*/
	function chipLabel(pct, liveSecs) {
		const parts = ["atom", pct + "%"];
		if (liveSecs !== null) parts.push(fmtCountdown(liveSecs) + " 后重置");
		return parts.join(" · ");
	}
	/**
	* Everything the readout renders, derived from ONE stats snapshot.
	*
	* Extracted because both chip variants must agree on what "no quota"
	* means, and the label must be unconstructable while `known` is false:
	* building `'atom · 5小时 ' + pct + '%'` from a `pct` that defaulted to
	* null is what printed `atom · 5小时 null%` for the frame before the first
	* stats response landed. Here `label` simply does not exist unless the
	* quota is known, so the bug cannot be reintroduced by a caller.
	*/
	function quotaView(quota, nowMs) {
		if (!(!!quota && quota.available === true && typeof quota.usagePercent === "number")) return { known: false };
		const pct = Math.round(quota.usagePercent);
		const limited = quota.limited === true;
		const liveSecs = liveRemaining(quota.resetInSecs, quota.fetchedAt, nowMs);
		return {
			known: true,
			pct,
			limited,
			label: chipLabel(pct, liveSecs),
			color: limited || quota.usagePercent >= 100 ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)",
			facts: quotaFacts(quota, liveSecs),
			barWidth: barWidth(pct)
		};
	}

//#endregion
//#region src/shared/loopback.ts
/**
	* loopback.ts — "is this base_url a process on THIS machine?", asked once.
	*
	* Both halves once needed the same answer about the same string:
	*
	*  - the HOST, before spawning a review, decided whether to probe the endpoint
	*    first (a dead local proxy deserves a named diagnosis, not the CLI's bare
	*    `Cancelled`);
	*  - the RENDERER, when the user picked that entry, worded the dependency
	*    warning ("评审经本机进程转发计费，它一停 review 立刻断").
	*
	* BOTH CONSUMERS ARE GONE. The review CLI was deleted and a review is now an
	* ordinary daemon turn, so the host has nothing to probe and the panel has no
	* direct-entry list to warn about. What survives is the predicate itself, still
	* correct and still exported (`isLoopbackEndpoint` on the client), for the next
	* caller that has to tell a local process from a remote one. Deleting it is a
	* separate decision from deleting its callers: it is small, tested, and the
	* alternative is somebody re-deriving `0.0.0.0` and bracketed-IPv6 handling by
	* hand a third time.
	*
	* That is the history worth keeping: those were two hand-written copies of the
	* same four-line predicate. The copies agreed, which is exactly why nobody
	* noticed — and the day one of them learned about, say, `0.0.0.0` or a bracketed
	* IPv6 form, the panel would warn about an endpoint the host never probes (or
	* stay silent about one it does). This repository's rule is one fact, one place;
	* a predicate shared by two bundles is the case that rule exists for.
	*
	* ## Why not a `shared/` type-only module
	*
	* The client half is an IIFE (tsdown inlines this into `client.js`) and the host
	* half is ESM per source file (tsdown emits it as a shared chunk under `lib/`).
	* Both are build outputs of the same source, so the two halves cannot disagree
	* at runtime — which is the point.
	*
	* ## Scope
	*
	* Deliberately narrow: loopback by HOSTNAME, which is what the two callers mean.
	* A `base_url` of `https://gateway.example.com` is not local even if the machine
	* can reach it, so it is NOT this predicate's business. Anything unparseable is
	* NOT loopback — returning true there would produce warnings about endpoints
	* nobody can point at.
	*
	* @module dsh-connect-atomcode/shared/loopback
	*/
	/** Hostnames that mean "a process on this machine", never a remote host. */
	const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
		"localhost",
		"::1",
		"[::1]"
	]);
	/**
	* @param {unknown} baseUrl - an OpenAI-compatible base_url, e.g. `http://127.0.0.1:8899/v1`.
	* @returns {boolean} true only for a parseable loopback URL.
	*/
	function isLoopbackBaseUrl(baseUrl) {
		if (typeof baseUrl !== "string") return false;
		const trimmed = baseUrl.trim();
		if (trimmed === "") return false;
		try {
			const { hostname } = new URL(trimmed);
			if (LOOPBACK_HOSTS.has(hostname)) return true;
			return /^127\./.test(hostname);
		} catch {
			return false;
		}
	}

//#endregion
//#region src/client/rows.ts
/**
	* The one line for a turn that is running right now.
	*
	* An ask reply is aggregated and returned in ONE piece, so before this existed
	* the panel had nothing true to say for the whole turn: a frozen counter and a
	* minutes-long gap, indistinguishable from a hung plugin. This prints counts and
	* names only — never partial content, which would become a second, worse copy of
	* a deliverable rendered somewhere nobody asked for.
	*
	* The tool call that has NOT answered is named too (`rounds - completed`):
	* "3 轮 · 1 未回" says a tool call is outstanding, which is what a turn that
	* looks stuck is usually waiting on.
	*/
	function inFlightText(turn) {
		const pending = Math.max(0, (turn.rounds || 0) - (turn.completed || 0));
		return [
			`${turn.rounds || 0} 次工具调用${pending > 0 ? `（${pending} 未回）` : ""}`,
			turn.lastTool ? `最近 ${turn.lastTool}` : "尚无工具调用",
			turn.chars > 0 ? `已收 ${turn.chars} 字` : "尚无输出",
			`已跑 ${fmtCountdown(Math.round((turn.elapsedMs || 0) / 1e3))}`
		].join(" · ");
	}
	/**
	* The one line the panel puts on the bundle card about daemon liveness.
	*
	* `downMessage` is worded by the HOST (`describeDaemonDown`), and the tool errors
	* quote that same function — so the page and the model are handed one sentence,
	* not two translations of one fact. Re-deriving the cause here would put the
	* cause in two places with two independent chances to drift, which is precisely
	* how "未监听" came to be said about four different failures.
	*
	* An older host sends no `downMessage` at all. Say that, rather than leaving the
	* port standing where a reason belongs.
	*/
	function daemonStatusLine(daemon, daemonVersion) {
		const d = daemon && typeof daemon === "object" ? daemon : {};
		if (d.up) return "daemon 运行中" + (typeof daemonVersion === "string" && daemonVersion !== "" ? " " + daemonVersion : "");
		return `daemon 未运行（${typeof d.downMessage === "string" && d.downMessage !== "" ? d.downMessage : "原因未记录（宿主较旧）"}${d.autoStart ? "；可自动拉起" : ""}）`;
	}
	/**
	* The sentence for a daemon that sent event types this client does not know, or
	* `''` when there is nothing to say.
	*
	* Pure for the same reason `daemonStatusLine` is one: the rule is then testable
	* without a browser, and the panel and the tool render cannot word one fact two
	* ways.
	*
	* Silence is the DEFAULT, and here it carries meaning. An older host sends no
	* `unknownTypes` at all, and a notice that fired on absence would cry wolf on
	* every stock install — which is how a real warning gets trained out. Only a
	* NON-EMPTY list is news.
	*/
	function protocolDriftNotice(protocol) {
		const p = protocol && typeof protocol === "object" ? protocol : {};
		const types = Array.isArray(p.unknownTypes) ? p.unknownTypes.filter((t) => typeof t === "string" && t !== "") : [];
		if (types.length === 0) return "";
		return `协议漂移：daemon 发来了本插件不认识的事件类型（${types.slice().sort().join(", ")}），AtomCode 可能已升级或改了事件名。本插件的轮数熔断靠计数 tool_start 生效——若被改名的正是这类被计数的事件，熔断会少计甚至完全不触发，此时 round_count 不可信，请调小 ask 的 max_rounds 或人工盯防。`;
	}
	/**
	* Is this knob the user's choice, the plugin's shipped default, or unknowable?
	*
	* The host owns the answer: `cfg.authored` is derived from the RESOLVED value in
	* `lib/index.js`, and a renderer comparing `value === fallback` would be a second
	* copy of a number the host owns. So this asks the host when it answered, and
	* only falls back to comparing when the host said nothing.
	*
	* 'unknown' is NOT decoration — it is the only honest answer when the host
	* reports no `authored` branch AND sent no default to compare against. An older
	* host (or the desktop install copy) hands us only the RESOLVED value, and
	* `approvalMode: 'ask'` from it is either the user's choice or a build whose
	* default is 'ask' — we cannot tell. Tagging that "（插件默认）" would assert what
	* we do not know, the same class of lie as printing a guessed quota number
	* (红线 2). So when we cannot tell, we do not tag at all.
	*
	* Shared by the read-only `turnBoundaryRows` and the inline editable controls in
	* `PanelSettingsControls` (./index.ts), so both word "你改过没有" the same way.
	*/
	function boundaryVerdict(authored, key, value, fallback) {
		if (authored && key in authored) return authored[key] === true ? "changed" : "default";
		if (fallback === null || fallback === void 0 || fallback === "") return "unknown";
		return value === fallback ? "default" : "changed";
	}
	const boundaryTag = (v) => v === "changed" ? "（已改）" : v === "default" ? "（插件默认）" : "";
	/**
	* The "回合边界" card's rows — a pure function so the honesty rule below is
	* testable without a browser.
	*
	* The rule: a patch-only knob is labelled by WHAT THE HOST SAYS ABOUT IT, not by
	* whether it happens to look default-ish. `cfg.authored` means "this value
	* DEPARTS from the plugin's shipped default" — the host decides that, because a
	* renderer only sees the resolved value and could not tell a deliberate
	* `approval_mode: bypass` from our own fallback. Comparing `askMaxRounds === 25`
	* here would also be a SECOND copy of a number `lib/index.js` owns.
	*
	* Rows are KEPT (not hidden) when at their defaults, because this is the card
	* that carries the `bypass` safety posture — silently dropping it would remove
	* the one place a user can see that AtomCode's own tools run unattended.
	*/
	function turnBoundaryRows(cfg) {
		const src = cfg && typeof cfg === "object" ? cfg : {};
		const authored = src.authored && typeof src.authored === "object" ? src.authored : {};
		const defaults = src.defaults && typeof src.defaults === "object" ? src.defaults : {};
		const askDefault = Number.isInteger(defaults.askMaxRounds) ? defaults.askMaxRounds : null;
		const approvalDefault = typeof defaults.approvalMode === "string" ? defaults.approvalMode : "";
		const mode = typeof src.approvalMode === "string" ? src.approvalMode : "";
		const modeRejected = typeof src.approvalModeRejected === "string" && src.approvalModeRejected !== "" ? src.approvalModeRejected : "";
		const dir = typeof src.defaultWorkingDir === "string" ? src.defaultWorkingDir : "";
		const rounds = Number.isInteger(src.askMaxRounds) ? src.askMaxRounds : null;
		const briefMode = typeof src.reviewBriefMode === "string" ? src.reviewBriefMode : "";
		const briefRejected = typeof src.reviewBriefModeRejected === "string" && src.reviewBriefModeRejected !== "" ? src.reviewBriefModeRejected : "";
		const briefDefault = typeof defaults.reviewBriefMode === "string" ? defaults.reviewBriefMode : "";
		return [
			{
				label: "AtomCode 自动执行权限",
				text: mode === "" ? "—" : modeRejected !== "" ? `${mode}（已回落：你填的是 ${modeRejected}）` : mode + boundaryTag(boundaryVerdict(authored, "approvalMode", mode, approvalDefault)),
				title: "决定 AtomCode 在帮你跑工具（执行命令、改文件）时受多大限制。bypass = 全程自动执行、无需你逐次确认（出厂默认，且当前 daemon 对后台调用一律自动放行，所以切换这里实际不改变行为）；build / accept_edits / plan 是更保守的档位。" + (modeRejected !== "" ? `你填的「${modeRejected}」不是合法档位（只能是 build / accept_edits / bypass / plan），已回落到 ${mode}——照原样传过去每个回合都会被 daemon 以 422 拒绝。` : "")
			},
			{
				label: "AtomCode 干活的文件夹",
				text: dir === "" ? "（跟随本次会话的工作目录）" : dir + boundaryTag(boundaryVerdict(authored, "workingDir", dir, null)),
				title: dir === "" ? "没单独指定 = AtomCode 在你这次会话所在的工作目录里干活" : "AtomCode 干活所在的文件夹"
			},
			{
				label: "单次咨询最多轮数",
				text: rounds === null ? "—" : rounds > 0 ? String(rounds) + boundaryTag(boundaryVerdict(authored, "askMaxRounds", rounds, askDefault)) : "不限",
				title: "一次「问 AtomCode」最多让它自己循环多少轮（每轮可能调用工具、读文件）。到上限就停止等待结果（不是强行中止：daemon 那边可能还在后台跑完）。"
			},
			{
				label: "评审时自动补提示词",
				text: briefMode === "" ? "—" : briefRejected !== "" ? `${briefMode}（已回落：你填的是 ${briefRejected}）` : briefMode + boundaryTag(boundaryVerdict(authored, "reviewBriefMode", briefMode, briefDefault)),
				title: "用「代码评审」时，如果你没写要评什么，是否自动附一段内置评审提示词。always = 总是附上（你写了也加在后面）；when-empty = 只有你没写时才补（你写了就原样发）；never = 从不补（你没写就直接拒绝）。" + (briefRejected !== "" ? `你填的「${briefRejected}」不是合法取值（只能是 always / when-empty / never），已回落到 ${briefMode}。` : "")
			}
		];
	}
	/**
	* The model row, derived from ONE stats snapshot.
	*
	* There is exactly ONE row because there is exactly ONE ladder now
	* (per-call `provider` > panel pick > `default_provider` > AtomCode's own
	* default). It used to be two rows for two namespaces — the review row asked
	* for a `[providers.<name>]` direct entry and fed a spawned CLI — and that
	* second namespace died with the CLI (红线 8's "two namespaces" is retired).
	*/
	function providerRows(cfg) {
		const src = cfg && typeof cfg === "object" ? cfg : {};
		const name = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : "";
		const ask = name(src.defaultProvider);
		return [{
			label: "默认对话模型",
			fallback: "未插手",
			value: ask || "未插手",
			pinned: ask !== "",
			title: "「问 AtomCode」和「代码评审」都用这一个下拉选择的对话模型（形如 AtomGit-glm5.3-flash）。没选 = 不指定，用 AtomCode 自己的默认模型。只影响你没单独点名模型的那些调用。"
		}];
	}
	/**
	* Read one finished assistant message's prose out of the chat snapshot.
	*
	* WHY THIS IS POSSIBLE AT ALL (the P2 verdict says it should not be): the
	* plugin cannot INJECT anything into the session, and it cannot call back into
	* the host's conversation services. But the seat the chat's own action row uses
	* — `conversation.chat.assistant-actions` — is handed `{ messageId }` as
	* OWNER props and `useChat` as a standard prop. `useChat` is the rendered
	* projection of the conversation: it is the same data the host's own 「复制」
	* button reads (`assistantText(closing.blocks)`). So the text is not fetched,
	* not intercepted, not scraped from the DOM — it is passed to us by the owner,
	* exactly as the reply's own 复制 button gets it. The human still reads it
	* before anything is sent, so this stays "a paste slot with the paste done".
	*
	* The lookup mirrors the host's own two halves, because the id and the text are
	* built in DIFFERENT places:
	*
	*   · the id comes from the `turn-tail` node — the footer of a completed turn,
	*     whose `data.closing` is the last assistant step carrying prose
	*     (`turnTailDefinition.buildViewNode` publishes `tailData` verbatim, and
	*     `TurnTailNodeView` reads `data.closing.finalNode.messageId`);
	*   · the text comes from that closing step's own blocks.
	*
	* The first version of this function looked for `data.finalNode` on the
	* `assistant-step` node instead and never matched — the assistant node carries
	* `finalNode` under `data`, but the id the owner hands us belongs to the
	* turn-tail's `closing`, so the search walked right past it. The fix is to read
	* the same node the host reads, and to fall back to the assistant-step shape so
	* a projection that publishes both keeps working.
	*
	* Text blocks only, concatenated with no separator: the host's own 复制 button
	* does exactly this (`assistantText`). Returns null when the message is not
	* there at all, '' when it is there but carries no prose (a tool-only step), so
	* the two cases stay distinguishable.
	*/
	function messageTextOf(snapshot, messageId) {
		if (!snapshot || typeof snapshot !== "object" || messageId == null) return null;
		const nodes = snapshot.nodes;
		if (!nodes || typeof nodes.values !== "function") return null;
		const textOf = (settled) => {
			return (Array.isArray(settled.blocks) ? settled.blocks : []).filter((block) => block && block.kind === "text" && typeof block.text === "string").map((block) => block.text).join("");
		};
		try {
			for (const node of nodes.values()) {
				const closing = node && node.data && node.data.closing;
				if (!closing || !closing.finalNode || closing.finalNode.messageId !== messageId) continue;
				return textOf(closing);
			}
			for (const node of nodes.values()) {
				const data = node && node.data;
				const settled = data && data.finalNode;
				if (!settled || settled.messageId !== messageId) continue;
				return textOf(settled);
			}
		} catch {
			return null;
		}
		return null;
	}
	/**
	* The dropdown model for one provider slot — pure, so every edge is testable
	* without a browser or a daemon.
	*
	* Three things it owns:
	*  - the selected value is the PANEL pick, NOT the effective one
	*  - a panel pick missing from the catalogue is APPENDED, never dropped
	*  - an unusable slot renders a REASON, never a bare empty dropdown (红线 3)
	*/
	function providerSelectModel(provider, fallbackLabel) {
		const src = provider && typeof provider === "object" ? provider : null;
		if (!src || typeof src !== "object") return {
			value: "",
			options: [{
				value: "",
				label: fallbackLabel
			}],
			disabled: true,
			reason: "宿主没有提供档位接口（旧版本，或 /provider 路由未注册）",
			effective: "",
			source: "",
			note: "",
			warning: ""
		};
		const name = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : "";
		const panel = name(src.panel);
		const optionValue = (v) => {
			if (typeof v === "string") return name(v);
			if (v && typeof v === "object") return name(v.provider);
			return "";
		};
		const optionEntry = (v) => {
			const value = optionValue(v);
			if (value === "") return null;
			const label = !!(v && typeof v === "object" && v.isDefault === true) ? `${value}（默认）` : value;
			const effortLevels = v && typeof v === "object" && Array.isArray(v.effortLevels) && v.effortLevels.length > 0 ? v.effortLevels : void 0;
			const currentEffort = v && typeof v === "object" && typeof v.currentEffort === "string" ? v.currentEffort : null;
			return {
				value,
				label,
				...effortLevels ? { effortLevels } : {},
				...currentEffort ? { currentEffort } : {}
			};
		};
		const catalog = Array.isArray(src.catalog) ? src.catalog.map(optionEntry).filter((e) => e !== null) : null;
		const pinned = panel ? [{
			value: panel,
			label: panel
		}] : [];
		const list = catalog === null ? pinned : catalog.some((e) => e.value === panel) ? catalog : pinned.concat(catalog);
		const options = [{
			value: "",
			label: fallbackLabel
		}].concat(list);
		const effective = name(src.effective);
		const source = name(src.source);
		const branch = provider;
		let disabled = false;
		let reason = "";
		if (branch.foreignVersion === true) {
			disabled = true;
			reason = name(branch.storeError) || "状态文件由更新版本的插件写入，本版本不覆盖它";
		} else if (catalog === null) {
			disabled = true;
			reason = name(src.catalogError) || name(branch.storeError) || "档位列表暂不可用（daemon 未在线？）";
		} else if (list.length === 0) {
			disabled = true;
			reason = "daemon 未列出档位";
		}
		let note = "";
		if (!disabled && effective !== "" && effective !== panel) {
			if (source === "panel") note = "这次调用实际用 " + effective + "（不是这里选的）";
			else if (source === "config") note = "当前生效 " + effective + "（来自配置）";
			else if (source === "atomcode") note = "当前生效 " + effective + "（AtomCode 默认）";
			else if (source === "argument") note = "本次调用指定 " + effective;
		}
		const warning = "";
		const selectedOption = panel ? list.find((e) => e.value === panel) : null;
		const effortLevels = selectedOption && Array.isArray(selectedOption.effortLevels) && selectedOption.effortLevels.length > 0 ? selectedOption.effortLevels : void 0;
		const currentEffort = selectedOption && typeof selectedOption.currentEffort === "string" ? selectedOption.currentEffort : null;
		return {
			value: panel,
			options,
			disabled,
			reason,
			effective,
			source,
			note,
			warning,
			...effortLevels ? { effortLevels } : {},
			...currentEffort ? { currentEffort } : {}
		};
	}

//#endregion
//#region src/client/status-section.ts
/**
	* A counter that arrived as anything but a finite number is ZERO, never the
	* word "undefined".
	*
	* The host always sends numbers for these, but a branch can arrive as an EMPTY
	* object — `ask: {}`, a partially-built snapshot, an older host mid-upgrade —
	* and `data.ask || {calls: 0}` does not catch that: an empty object is truthy,
	* so every field under it reaches the renderer as `undefined` and
	* `String(undefined)` puts "undefined 调用" on the panel. A placeholder that
	* reads like a reading is the failure 红线 2 forbids for the quota; a count is
	* the same class of fact, so it gets the same treatment.
	*/
	const count = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
	/**
	* Build the status panel component.
	*
	* @param {StatusSectionDeps} deps
	* @returns {(props: any) => ReactElement} the `StatusSection` component.
	*/
	function createStatusSection(deps) {
		const { h, useStats, useState, StatusPill, Row, CallStat, ProviderSelectRow, PanelSettingsControls, panelId } = deps;
		/**
		* The bundle card's one-liner (`view: 'summary'`).
		*
		* DEFINED HERE, not injected: it has exactly one caller — the `view: 'summary'`
		* branch of `StatusSection` below — so it travels with the component that
		* renders it.
		*
		* Reports LIVE state only. The card already prints the localized description
		* from `locale/*.json` directly above this line, so any prose here would both
		* duplicate it and create a second place to keep the same words in sync.
		* One line, and it says something the description cannot: is the bridge up.
		*/
		function SummaryLine() {
			const { data, error } = useStats();
			if (error || !data) return h("span", { style: S.provLabel }, "状态未知");
			const d = data.daemon || {};
			const parts = [daemonStatusLine(d, data.protocol && data.protocol.daemonVersion), "端口 " + (d.port == null ? "—" : d.port)];
			return h("span", {
				style: S.provLabel,
				title: parts.join(" · ")
			}, parts.join(" · "));
		}
		/**
		* One collapsible section: a full-width toggle head (title + chevron) over the
		* body, inside a single layer-1 card.
		*
		* A SEPARATE COMPONENT, on purpose — not a helper rendered inline by
		* `StatusSection`. Each section owns its own collapse state, and React tracks
		* hooks PER COMPONENT. If `StatusSection` called `useState` once up front and
		* passed `open` down, it would add one hook to `StatusSection`'s sequence; the
		* panel also renders `ProviderSelectRow` (the model dropdown), whose own
		* `[note, pending]` pair is asserted by position in `test/client-render.test.mjs`
		* — a comment there warns the script moves if a row gains state. Keeping the
		* fold inside this component means `StatusSection`'s hook order is unchanged
		* by the collapsible layout.
		*
		* The heading is the SAME string a test or a reader greps for, and it stays in
		* the DOM whether the section is open or not (it lives in the toggle button),
		* so nothing that names a section disappears with a click. Sections START
		* open: a panel that greets the reader with six collapsed folds would hide the
		* very facts it exists to show.
		*/
		function Section(props) {
			const [open, setOpen] = useState(true);
			return h("div", { style: S.section }, h("button", {
				style: S.sectionHead,
				onClick: () => setOpen((current) => !current),
				"aria-expanded": open,
				type: "button"
			}, h("span", { style: S.sectionTitle }, props.title), props.titleRight || null, h("span", {
				style: {
					...S.chevron,
					...open ? S.chevronOpen : {}
				},
				"aria-hidden": true
			}, "▾")), open ? h("div", { style: S.sectionBody }, props.children) : null);
		}
		/**
		* The tab row and its panes. Same rule as `Section` above: it is a separate
		* component so its `useState` never shifts the hook order that
		* `test/client-render.test.mjs` asserts for `StatusSection`.
		*
		* The strip and the freshness cluster share ONE row (`S.tabRow`), whose bottom
		* border is what the active tab's underline sits on. The cluster must stay
		* OUTSIDE `role="tablist"` — a tablist may only contain tabs — so the row
		* splits them with a spacer rather than giving the cluster a header bar of its
		* own above (which is what the panel used to do: a whole row for one badge).
		*
		* Every pane STAYS RENDERED — the inactive ones are `display: none`, not
		* unmounted. Two reasons: the headings a reader (and a test) greps for must
		* not vanish with a click, and a degradation that belongs to a pane must stay
		* findable from the strip. That second one used to be bought by keeping the
		* notices ABOVE the tabs ("a silent degradation must never hide behind a
		* tab"); they now live in the pane they belong to, and such a tab carries
		* `alert` — a visible `!` next to its label plus the reason as its hover title
		* — so the signal is on the strip whichever tab is open. The cost is
		* negligible: the whole panel is a handful of rows.
		*
		* @param {{status?: any, tabs: Array<{label: string, pane: any, alert?: string}>}} props
		*   `status` is the tab-independent freshness cluster; `alert` is non-empty
		*   only on a tab whose pane is carrying a degradation.
		*/
		function Tabbed(props) {
			const [active, setActive] = useState(0);
			return h("div", { style: S.tabs }, h("div", { style: S.tabRow }, h("div", {
				style: S.tabBar,
				role: "tablist"
			}, props.tabs.map((tab, index) => h("button", {
				key: tab.label,
				style: index === active ? {
					...S.tab,
					...S.tabActive
				} : S.tab,
				onClick: () => setActive(index),
				"aria-selected": index === active,
				...tab.alert ? { title: tab.alert } : {},
				role: "tab",
				type: "button"
			}, tab.label, tab.alert ? h("span", {
				style: S.tabAlert,
				"aria-hidden": true
			}, "!") : null))), h("span", { style: S.spacer }), props.status || null), props.tabs.map((tab, index) => h("div", {
				key: tab.label,
				style: {
					...S.tabPane,
					display: index === active ? "grid" : "none"
				},
				role: "tabpanel"
			}, tab.pane)));
		}
		return function StatusSection(props) {
			const view = props && props.view;
			const subject = props && props.subject;
			if (!(view === "summary" || view === "page")) {
				if ((subject && subject.kind === "bundle" ? subject.pkg && subject.pkg.name : void 0) !== "dsh-connect-atomcode") return null;
			}
			if (view === "summary") return h(SummaryLine, null);
			const { data, error, updatedAt, reload } = useStats();
			let body;
			const failureNote = error ? "统计信息加载失败：" + error : "";
			if (error && !data) body = h("div", { style: S.notice }, h("p", { style: S.error }, failureNote));
			else if (!data) body = h("div", { style: S.notice }, "加载中…");
			else {
				const d = data.daemon || {};
				const bin = data.binary || {};
				const cfg = data.config || {};
				const quota = data.quota || {};
				const rawAsk = data.ask || {};
				const ask = {
					calls: count(rawAsk.calls),
					ok: count(rawAsk.ok),
					err: count(rawAsk.err),
					msTotal: count(rawAsk.msTotal),
					tokens: count(rawAsk.tokens),
					inFlight: rawAsk.inFlight ?? null
				};
				const proto = data.protocol || {};
				const protoNotice = protocolDriftNotice(proto);
				const trendBranch = data.usageTrend;
				const trend = trendBranch || {};
				const trendRows = Array.isArray(trend.rows) ? trend.rows : [];
				const prov = data.provider || null;
				const retryNote = cfg.daemonRetrySecs > 0 ? cfg.daemonRetrySecs + "s" : "每次轮询";
				const liveResetSecs = liveRemaining(quota.resetInSecs, quota.fetchedAt, Date.now());
				const quotaPct = typeof quota.usagePercent === "number" ? quota.usagePercent : null;
				const quotaExpiry = [quota.expires, quota.planWindow].filter(Boolean).join(" · ");
				const askAvg = ask.calls > 0 ? Math.round(ask.msTotal / ask.calls) : 0;
				const binPath = bin.configured || bin.env || "自动探测（PATH）";
				const spawnNote = d.up ? d.spawnTried ? "已自动拉起" : "运行中" : d.starting ? "正在拉起…" : d.spawnTried ? "自动拉起失败" : "未触发自动拉起";
				const quotaCard = h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 8
				} }, !quota.available ? h("p", { style: S.error }, quota.reason || "额度不可用（daemon 未运行或命令不可用）") : quotaPct == null && !quota.plan ? h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				} }, h("p", { style: S.key }, quota.reason || "未能从 status 文本中识别出额度"), quota.raw && quota.raw.usageLine ? h("p", { style: S.key }, quota.raw.usageLine) : null, quota.raw && quota.raw.planLine ? h("p", { style: S.key }, quota.raw.planLine) : null) : h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 8
				} }, quotaPct == null ? h("div", { style: S.metric }, h("span", { style: S.metricLabel }, quota.reason || "额度读数不可用")) : h("div", { style: S.metric }, h("span", { style: {
					...S.metricNum,
					color: quotaColor(quotaPct, quota.limited)
				} }, pctLabel(quotaPct)), h("span", { style: S.metricLabel }, "当前时间窗口用量" + (liveResetSecs == null ? "" : " · " + fmtCountdown(liveResetSecs) + " 后重置")), h("div", { style: S.bar }, h("div", { style: {
					width: barWidth(quotaPct) + "%",
					background: quotaColor(quotaPct, quota.limited)
				} }))), h(Row, { label: "套餐" }, quota.plan || "—"), h(Row, { label: "到期" }, quotaExpiry || "—"), h(Row, { label: "重置于" }, quota.resetAt || "—"), quota.windowLimit != null ? h(Row, { label: "本窗口" }, `${count(quota.windowUsed)} / ${count(quota.windowLimit)} ${quota.windowMetric === "calls" ? "次" : quota.windowMetric || ""}${quota.windowHours == null ? "" : `（每 ${quota.windowHours} 小时）`}`) : null, quota.limited ? h("p", { style: S.error }, "当前 " + windowLabel(quota.planWindow) + " 窗口已用尽，回合会被限流") : null, quota.sourceNote ? h("p", {
					style: S.key,
					title: quota.sourceNote
				}, quota.sourceNote) : null));
				const trendCard = h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				} }, trendBranch === void 0 ? h("p", { style: S.key }, "宿主未提供按天用量（本页连的 host 进程早于该字段，重启 DSH 后出现）") : trend.available === false ? h("p", { style: S.error }, trend.reason || "按天用量不可用") : trendRows.length === 0 ? h("p", { style: S.key }, "daemon 没有返回按天记录") : [...trendRows.slice(-7).reverse().map((row) => h(Row, {
					key: "trend-" + row.date,
					label: String(row.date).slice(5)
				}, fmtTokens(row.tokens) + " tok · " + count(row.requests) + " 次")), h(Row, { label: "区间" }, "最近 " + Math.min(7, trendRows.length) + " 天" + (trend.endDate ? " · 数据到 " + trend.endDate : ""))]);
				const startupCard = h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				} }, h(Row, { label: "监听端口" }, d.port == null ? "—" : String(d.port)), h(Row, { label: "自动启动" }, d.autoStart ? "开启" : "关闭"), h(Row, { label: "拉起状态" }, spawnNote), !d.up && !d.starting ? h(Row, { label: "未就绪原因" }, d.downMessage || "未上报（宿主较旧）") : null, h(Row, { label: "daemon 版本" }, proto.daemonVersion || (d.up ? "未知" : "—")), !d.up && d.spawnFailures > 1 ? h(Row, { label: "拉起重试" }, `失败 ${d.spawnFailures} 次（每 ${retryNote} 重试一次）`) : null);
				const envCard = h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 8
				} }, h(Row, { label: "AtomCode" }, binPath), h("div", { style: S.provGrid }, providerRows(cfg).map((row) => h(ProviderSelectRow, {
					key: "provider-" + row.label,
					label: row.label,
					provider: prov,
					fallbackLabel: row.fallback,
					title: row.title,
					reload
				}))));
				const allBoundaryRows = turnBoundaryRows(cfg);
				const boundaryCard = h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				} }, PanelSettingsControls ? null : allBoundaryRows.map((row) => h(Row, {
					key: "bound-" + row.label,
					label: row.label
				}, h("span", { title: row.title }, row.text))), PanelSettingsControls ? h(PanelSettingsControls, {
					cfg,
					reload
				}) : null);
				const sessionCard = h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				} }, h(CallStat, {
					num: count(data.sessions && data.sessions.tracked),
					label: "已跟踪会话"
				}), data.sessions && typeof data.sessions.oldestAgeMs === "number" ? h(Row, { label: "最旧一条" }, h("span", { title: "这些会话键里最老一条的存活时长。超过插件设定的存活期的键会被丢弃，之后的 continue 会开一条新线（不会静默复用一条死会话）" }, fmtDuration(data.sessions.oldestAgeMs))) : null, h(Row, { label: "运行时长" }, fmtDuration(data.uptimeMs)), data.sessions && data.sessions.error ? h("p", { style: S.error }, "会话续接已降级（回复不受影响）：" + data.sessions.error) : null);
				const toolCard = h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				} }, h("div", { style: S.callGroups }, h("div", { style: {
					...S.callGroup,
					borderRight: "none",
					paddingRight: 0
				} }, h("span", {
					style: S.callGroupLabel,
					title: "含 atomcode_ask 工具与 /atomcode-review 命令：两者走同一条 daemon /chat 通道，共用这一份计数、熔断与耗时"
				}, "经本桥的回合"), h(CallStat, {
					num: ask.calls,
					label: "调用"
				}), h(CallStat, {
					num: ask.ok,
					label: "成功",
					color: ask.ok ? "var(--dsw-alias-state-success-primary)" : void 0
				}), h(CallStat, {
					num: ask.err,
					label: "失败",
					color: ask.err ? "var(--dsw-alias-state-error-primary)" : void 0
				}))), h(Row, { label: "累计 tokens" }, String(ask.tokens)), h(Row, { label: "平均耗时" }, fmtDuration(askAvg)));
				const statusCluster = h("span", { style: S.cluster }, h("span", { style: error ? {
					...S.live,
					...S.liveStale
				} : S.live }, error ? "已断开" : "实时"), updatedAt ? h("span", {
					style: S.updated,
					title: error || ""
				}, (error ? "最后更新 " : "更新于 ") + new Date(updatedAt).toLocaleTimeString("zh-CN")) : null, error ? h("span", {
					style: S.staleReason,
					title: error
				}, failureNote) : null, h("button", {
					style: S.refresh,
					onClick: reload,
					type: "button"
				}, "刷新"));
				const upstreamKind = quota.upstreamFailure ? quota.upstreamFailure.kind : null;
				const quotaDrift = proto.quotaTextDrift ? upstreamKind === "plan-inactive" ? "额度未生效：AtomCode 自己没读到 CodingPlan 状态，网关那条响应里没有生效窗口（到期时间与剩余天数都是空）。在 AtomCode 里运行 /login 续领后刷新本页。下面显示的是 daemon 的原文而非解析结果；可手工核对 /api/atomcode-bridge/stats 的 quota.raw。" : upstreamKind === "upstream-parse" ? "额度不可用：AtomCode 解析网关的 status-v2 响应失败（原文见下）—— 这不是本面板的解析问题，上游恢复后会自动读回。可手工核对 /api/atomcode-bridge/stats 的 quota.raw。" : "额度解析失配：daemon 的 status 文本已不符合已知形状（AtomCode 可能已升级），下面显示的是原始文本而非解析结果。可手工核对 /api/atomcode-bridge/stats 的 quota.raw。" : "";
				const content = h("div", { style: S.content }, h(Tabbed, {
					status: statusCluster,
					tabs: [
						{
							label: "运行",
							alert: protoNotice || void 0,
							pane: [
								ask.inFlight ? h("div", { style: {
									...S.inFlight,
									...S.paneBanner
								} }, h("span", { style: S.inFlightDot }), h("span", {
									style: S.inFlightLabel,
									title: "有一条 atomcode_ask 回合正在跑。数字来自详情页每 5 秒一次的轮询，最多落后一个轮询周期；只报计数与耗时、不含回复内容（回复是整轮取回的）。回合结束后本行消失。模型并行发多条 ask 时这里只报「最近开始且仍在跑」的那一条（面板装不下第二条）；更早的那条跑完或最新那条先跑完，本行都会改报还活着的那条"
								}, "ask 回合进行中"), h("span", { style: S.inFlightText }, inFlightText(ask.inFlight))) : null,
								protoNotice ? h("div", { style: {
									...S.notice,
									...S.paneBanner
								} }, protoNotice) : null,
								h(Section, {
									title: "启动情况",
									titleRight: h(StatusPill, { up: !!d.up })
								}, startupCard),
								h(Section, { title: "运行环境" }, envCard),
								h(Section, { title: "回合边界" }, boundaryCard)
							]
						},
						{
							label: "用量",
							alert: quotaDrift || void 0,
							pane: [
								quotaDrift ? h("div", { style: {
									...S.notice,
									...S.paneBanner
								} }, quotaDrift) : null,
								h(Section, { title: "CodingPlan 额度" }, quotaCard),
								h(Section, { title: "按天用量" }, trendCard),
								h(Section, { title: "工具调用统计" }, toolCard)
							]
						},
						{
							label: "会话",
							pane: [h(Section, { title: "侧边会话" }, sessionCard)]
						}
					]
				}));
				body = h("div", {
					style: S.page,
					"data-dsh-plugin": panelId
				}, h("div", { style: S.scroll }, content));
			}
			return body;
		};
	}

//#endregion
//#region src/client/quota-chip.ts
/**
	* Build the pair of quota readouts.
	*
	* @param {QuotaChipDeps} deps
	* @returns {{ QuotaChip: () => any, QuotaChipDegraded: () => any }}
	*/
	function createQuotaChip(deps) {
		const { h, useStats, useState, useEffect, useRef, primitives, reactDom } = deps;
		function QuotaChip() {
			const { data } = useStats();
			const [open, setOpen] = useState(false);
			const [, setTick] = useState(0);
			const rootRef = useRef(null);
			const panelRef = useRef(null);
			const view = quotaView(data && data.quota, Date.now());
			useEffect(() => {
				if (!open) return void 0;
				const id = setInterval(() => setTick((n) => n + 1), 1e3);
				return () => clearInterval(id);
			}, [open]);
			useEffect(() => {
				if (!open) return void 0;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [open]);
			const anchored = primitives.useAnchoredPosition({
				open: open && view.known,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: 8,
				margin: 12
			});
			primitives.useDismissOnOutsidePointer(rootRef, open && view.known, setOpen, panelRef);
			if (!view.known) return null;
			const inFlight = data && data.ask ? data.ask.inFlight : null;
			return h("span", {
				ref: rootRef,
				"data-quota-percent": view.pct,
				style: CHIP_STYLE(view.color)
			}, h(primitives.Tooltip, {
				label: inFlight ? view.facts.join(" · ") + " · " + inFlightText(inFlight) : view.facts.join(" · "),
				side: "top",
				delayMs: 200,
				disabled: open
			}, h("button", {
				type: "button",
				style: CHIP_TRIGGER_STYLE,
				"aria-haspopup": "dialog",
				"aria-expanded": open,
				onClick: () => setOpen(!open)
			}, view.label)), inFlight && h("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 4,
					marginLeft: 6,
					fontSize: 11,
					color: "var(--dsw-alias-label-secondary)",
					whiteSpace: "nowrap"
				},
				title: inFlightText(inFlight)
			}, h("span", { style: {
				width: 5,
				height: 5,
				borderRadius: "50%",
				background: "var(--dsw-alias-state-success-primary)",
				flexShrink: 0
			} }), inFlightText(inFlight)), open && reactDom.createPortal(h("div", {
				ref: panelRef,
				role: "dialog",
				"aria-label": "CodingPlan 额度",
				style: panelStyle(S.panelSurface, anchored)
			}, h("div", { style: S.panelHead }, h("span", { style: S.panelTitle }, "CodingPlan 额度"), h("span", { style: S.panelPct }, pctLabel(view.pct), view.limited ? h("span", { style: S.panelLimited }, "已用尽") : null)), h("div", { style: S.panelTrack }, h("div", { style: {
				height: "100%",
				width: view.barWidth + "%",
				background: view.color
			} })), view.facts.map((fact, index) => h("p", {
				key: "fact-" + index,
				style: index === 0 ? S.panelFactLead : S.panelFact
			}, fact))), document.body));
		}
		/**
		* The seed-less host variant: same number, native `title` instead of a
		* panel. It calls NO primitive hooks, which is the whole reason it exists
		* as its own component — a single QuotaChip that branched over
		* `primitives` would have a conditional hook tail (Rules of Hooks). That
		* is survivable only because `primitives` is a factory-scope constant, and
		* it turns into "Rendered fewer hooks than expected" the moment the seed
		* table is loaded lazily, with the crash site far from the cause.
		*/
		function QuotaChipDegraded() {
			const { data } = useStats();
			const view = quotaView(data && data.quota, Date.now());
			if (!view.known) return null;
			const inFlight = data && data.ask ? data.ask.inFlight : null;
			return h("span", {
				title: inFlight ? view.facts.join(" · ") + " · " + inFlightText(inFlight) : view.facts.join(" · "),
				"data-quota-percent": view.pct,
				style: CHIP_STYLE(view.color)
			}, view.label, inFlight && h("span", { style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 4,
				marginLeft: 6,
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)",
				whiteSpace: "nowrap"
			} }, h("span", { style: {
				width: 5,
				height: 5,
				borderRadius: "50%",
				background: "var(--dsw-alias-state-success-primary)",
				flexShrink: 0
			} }), inFlightText(inFlight)));
		}
		return {
			QuotaChip,
			QuotaChipDegraded
		};
	}

//#endregion
//#region src/client/review-handoff.ts
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
	* `/atomcode-review <quoted reply>` at the caret and stops. The human presses
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
	function warn(message) {
		try {
			if (typeof console !== "undefined" && console && typeof console.warn === "function") console.warn("[atomcode-bridge] " + message);
		} catch {}
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
	function insertIntoDraft(actions, text, what) {
		if (!actions || typeof actions.captureInsertion !== "function" || typeof actions.insertText !== "function") {
			warn("这个宿主没有暴露输入框操作，" + what + "没插入，请手动输入 /atomcode-review");
			return false;
		}
		let span = void 0;
		try {
			span = actions.captureInsertion();
		} catch {
			warn("输入框当前不可写，" + what + "没插入，请手动输入 /atomcode-review");
			return false;
		}
		const moved = actions.insertText(text, span) !== true;
		if (moved) warn("输入框内容变了，" + what + "没落地，请手动输入 /atomcode-review");
		return !moved;
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
	function createReviewHandoff() {
		/**
		* Set by `ReviewRail` on every render (it owns `inputActions`); null before the
		* composer has rendered. Module-closure state, not a hook: `requestReview` is
		* called from a DIFFERENT seat's component, outside this tree.
		*/
		let insertDraftFor = null;
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
		function requestReview(input) {
			const reply = input && input.text !== null && input.text !== void 0 ? String(input.text) : "";
			const command = "/atomcode-review" + (reply !== "" ? " " + reply : "");
			if (insertDraftFor === null) {
				warn("输入框还没挂载，锐评指令没插入，请手动输入 /atomcode-review");
				return false;
			}
			return insertDraftFor(command, "锐评指令");
		}
		/**
		* The `conversation.input.left` occupant: `null`, and that is the whole point.
		*
		* It exists so the composer's `inputActions` has an owner inside a seat that
		* carries it. Registration costs nothing visually — the seat renders an empty
		* child — and it is what makes the 锐评 row able to fill the composer at all.
		*/
		function ReviewRail(props) {
			const actions = props && props.inputActions;
			insertDraftFor = (text, what) => insertIntoDraft(actions, text, what);
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
			__setInsertForTest(fn) {
				insertDraftFor = fn;
			}
		};
	}

//#endregion
//#region src/client/message-ask.ts
/**
	* Build the row button.
	*
	* @param {MessageAskDeps} deps
	* @returns {(props: any) => ReactElement | null} the component; null when the
	* row's ownerProps carry no `messageId` (the host skips the whole row in that
	* case, so this is a belt-and-braces guard, not a normal path).
	*/
	function createMessageAsk(deps) {
		const { h, useState, requestReview } = deps;
		function MessageAsk(props) {
			const [note, setNote] = typeof useState === "function" ? useState("") : ["", () => {}];
			const messageId = props && props.messageId;
			let snapshot = null;
			try {
				snapshot = typeof props.useChat === "function" ? props.useChat((state) => state) : null;
			} catch {
				snapshot = null;
			}
			const onClick = () => {
				let text = null;
				try {
					text = messageTextOf(snapshot, messageId);
				} catch {
					text = null;
				}
				if (text === null) consoleWarning(messageId, snapshot);
				if (requestReview({ text })) setNote("");
				else setNote("指令没插入：请在输入框手动输入 /atomcode-review，再按回车。");
			};
			if (typeof messageId !== "string" || messageId === "") return null;
			const button = h("button", {
				type: "button",
				style: MESSAGE_ACTION_STYLE,
				onClick,
				title: "把这条回复一起填入 /atomcode-review，按回车让 AtomCode 核对改动是否合理"
			}, "锐评");
			if (note === "") return button;
			return [button, h("span", {
				key: "note",
				role: "status",
				style: {
					color: "#b26b4b",
					fontSize: 11,
					lineHeight: MESSAGE_ACTION_STYLE.lineHeight,
					marginLeft: 6,
					whiteSpace: "nowrap"
				}
			}, note)];
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
	function consoleWarning(messageId, snapshot) {
		try {
			if (typeof console === "undefined" || !console || typeof console.warn !== "function") return;
			let report = "snapshot unavailable";
			try {
				const values = snapshot && snapshot.nodes && typeof snapshot.nodes.values === "function" ? snapshot.nodes.values() : [];
				const kinds = [];
				for (const node of values) if (node && typeof node.kind === "string" && !kinds.includes(node.kind)) kinds.push(node.kind);
				report = "nodes=" + values.length + " kinds=" + (kinds.length === 0 ? "none" : kinds.join(","));
			} catch (error) {
				report = "store unreadable: " + String(error && error.message ? error.message : error);
			}
			console.warn("[atomcode-bridge] 锐评: message " + messageId + " not found in the chat snapshot; " + report);
		} catch {}
	}

//#endregion
//#region src/client/index.ts
	const EFFORT_TITLE = "推理力度：模型每轮思考的深度。low 更快更省额度、high 更深入。选一个会让 daemon 记下来，之后的咨询默认用它；也可以在某一次咨询时临时传 reasoning_effort 覆盖";
	const REGISTRATION = {
		id: "dsh-connect-atomcode",
		factory: function(require) {
			const react = require("react");
			const h = react.createElement;
			const useState = react.useState;
			const useEffect = react.useEffect;
			const useRef = react.useRef;
			const useCallback = react.useCallback;
			let reactDom = null;
			let primitives = null;
			try {
				reactDom = require("react-dom");
			} catch (error) {}
			try {
				primitives = require("@deepseek-ai/dsh-client-ui-primitives");
			} catch (error) {}
			const STATS_PATH = "/api/atomcode-bridge/stats";
			const PROVIDER_PATH = "/api/atomcode-bridge/provider";
			const POLL_MS = 5e3;
			let statsCache = {
				data: null,
				error: null,
				fetchedAt: 0,
				promise: null,
				promiseStartedAt: 0
			};
			/**
			* The provider branch adopted from a write's own response, and WHEN.
			*
			* A poll that was already in flight when the click landed answers with a
			* snapshot the server built BEFORE the write reached it. Without re-applying
			* the adopted branch on top of that answer, the stale one wins the next
			* `commit()` and the dropdown bounces back anyway — the same bug, one race
			* narrower. The timestamp is what tells "this answer predates the click"
			* from "this answer already includes it".
			*/
			let adoptedProvider = null;
			const TESTABLE = {
				fmtDuration,
				fmtCountdown,
				quotaColor,
				liveRemaining,
				pctLabel,
				barWidth,
				quotaFacts,
				panelStyle,
				quotaView,
				providerRows,
				providerSelectModel,
				turnBoundaryRows,
				inFlightText,
				isLoopbackEndpoint: isLoopbackBaseUrl,
				daemonStatusLine,
				protocolDriftNotice,
				providerBranchOf,
				snapshotWithBranch,
				messageTextOf,
				createReviewHandoff,
				createMessageAsk
			};
			/**
			* Fold a successful write's OWN answer into the shared snapshot, before the
			* reload that follows it.
			*
			* `POST /provider` answers with the recomputed `provider` branch — the value
			* the server just accepted (`routes.ts`) — and `reload` is `load()`, whose
			* first line commits the CACHED snapshot while it is still fresh (within
			* POLL_MS). So without this, the click's own reload re-rendered the panel
			* from the pre-click snapshot: `ProviderSelectRow`'s `<select>` is
			* controlled (`value: model.value`), so React snapped the dropdown back to
			* the old pick and held it there until the next 5s poll — up to five
			* seconds in which the control looks like it ignored the click, with no
			* text anywhere saying the write succeeded (the "已选 X" line was removed
			* deliberately: only a failure needs words). Data already in hand was being
			* thrown away.
			*
			* Replacing `statsCache.data` with a NEW object — rather than mutating it —
			* is load-bearing: `commit()` calls `setData(statsCache.data)`, and React
			* bails out of a state update whose value is identical by reference, so an
			* in-place mutation would publish new content and no re-render.
			*
			* @returns {boolean} whether the snapshot actually changed.
			*/
			/**
			* The provider branch a write's response carries, or null when it carries
			* none.
			*
			* It is taken whole rather than pieced together: the server recomputes
			* `effective`/`source`/`catalog` for the entire ladder, so adopting its
			* answer keeps the one dropdown reading from the snapshot the server just
			* justified.
			*
			* There used to be TWO branches here (`ask` and `review`, one per provider
			* namespace). The review namespace died with its CLI, and the host now
			* answers with one flat branch, so this reads that branch directly — a
			* leftover loop over slot names would have found nothing in the new shape
			* and silently adopted no update at all.
			*/
			function providerBranchOf(provider) {
				if (!provider || typeof provider !== "object") return null;
				const branch = provider.provider && typeof provider.provider === "object" ? provider.provider : provider;
				return [
					"panel",
					"effective",
					"config"
				].some((key) => key in branch) || "catalog" in branch || "storePath" in branch ? branch : null;
			}
			/**
			* One snapshot plus an adopted branch in, the NEXT snapshot out — a NEW
			* object.
			*
			* "New object" is the whole point: `commit()` calls `setData(statsCache.data)`
			* and React bails out of a state update whose value is identical by
			* reference, so mutating the cached snapshot in place would publish new
			* content and no re-render — the dropdown would stay where it was.
			*
			* Kept pure and split from `adoptProviderSnapshot` so it can be asserted
			* offline: this bug lived between a network round-trip and a React commit,
			* which is exactly the seam no DOM-free suite could reach before.
			*/
			function snapshotWithBranch(current, branch) {
				if (!current) return null;
				return {
					...current,
					provider: {
						...current.provider || {},
						...branch
					}
				};
			}
			function adoptProviderSnapshot(provider) {
				const branch = providerBranchOf(provider);
				const next = branch ? snapshotWithBranch(statsCache.data, branch) : null;
				if (!next || !branch) return false;
				adoptedProvider = {
					branch,
					at: Date.now()
				};
				statsCache.data = next;
				return true;
			}
			/** Re-apply the adopted branch over an answer a pre-click poll just delivered. */
			function reapplyAdoptedProvider(startedAt) {
				if (!adoptedProvider || adoptedProvider.at <= startedAt) return;
				const next = snapshotWithBranch(statsCache.data, adoptedProvider.branch);
				if (next) statsCache.data = next;
			}
			/**
			* POST one JSON body to a bridge route and normalize the answer.
			*
			* All three write routes (`/provider`, `/panel-settings`, `/reasoning-effort`)
			* answer the same shape, so the transport, the "an unparseable body is not a
			* success" rule and the network-error wording live here once. What each
			* caller keeps is its OWN field: `postProvider` needs the branch the route
			* echoed back, the other two only need to know it was accepted.
			*
			* @returns `{ ok: true, body }` with the parsed answer, or `{ ok: false, error }`.
			*/
			async function postJson(path, payload) {
				try {
					const response = await fetch(path, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload)
					});
					let parsed = null;
					try {
						parsed = await response.json();
					} catch {
						parsed = null;
					}
					if (parsed && parsed.ok === true) return {
						ok: true,
						body: parsed
					};
					return {
						ok: false,
						error: parsed && parsed.error || "HTTP " + response.status
					};
				} catch (reason) {
					return {
						ok: false,
						error: reason && reason.message ? reason.message : String(reason)
					};
				}
			}
			async function postProvider(value) {
				const result = await postJson(PROVIDER_PATH, {
					slot: "ask",
					provider: value === "" ? null : value
				});
				if (!result.ok) return result;
				return {
					ok: true,
					provider: result.body
				};
			}
			const PANEL_SETTINGS_PATH = "/api/atomcode-bridge/panel-settings";
			/** Write the panel's briefMode / workingDir override. One field at a time. */
			async function postPanelSettings(fields) {
				const result = await postJson(PANEL_SETTINGS_PATH, fields);
				if (!result.ok) return result;
				return { ok: true };
			}
			const REASONING_EFFORT_PATH = "/api/atomcode-bridge/reasoning-effort";
			/**
			* Write the persistent reasoning-effort to the daemon (panel-side control).
			* The route forwards to the daemon's /live/reasoning_effort, which answers
			* `{ok:true}` on success or `{ok:false,error:"reasoning_effort not supported
			* by <provider>"}` when the level is not in the model's effort_levels.
			*/
			async function postReasoningEffort(effort) {
				const result = await postJson(REASONING_EFFORT_PATH, { effort });
				if (!result.ok) return result;
				return { ok: true };
			}
			/**
			* The interactive provider control: a dropdown over the ONE model ladder.
			*
			* There used to be two of these — ask listed daemon model profiles, review
			* listed config.toml direct entries, and 红线 8 existed to keep them from
			* being read as one knob. The review namespace died with its CLI, so the
			* panel shows one control for the one ladder both entry points climb.
			*
			* Pending/error state is local, and the control is never swapped back to static
			* text — a failed write must stay visible with its reason, or the user cannot
			* tell "the plugin refused" from "my click did nothing".
			*/
			function ProviderSelectRow({ label, provider, fallbackLabel, title, reload }) {
				const model = providerSelectModel(provider, fallbackLabel);
				const [note, setNote] = useState("");
				const [pending, setPending] = useState(false);
				const [effortPending, setEffortPending] = useState(false);
				const [effortError, setEffortError] = useState("");
				const effortLevels = model.effortLevels && model.effortLevels.length > 0 ? model.effortLevels : [];
				const currentEffort = typeof model.currentEffort === "string" ? model.currentEffort : "";
				const effortHasCurrent = effortLevels.indexOf(currentEffort) >= 0;
				const effortValue = effortHasCurrent ? currentEffort : "";
				const onEffortChange = async (event) => {
					const value = event && event.target ? event.target.value : "";
					if (value === "" || value === currentEffort) return;
					setEffortPending(true);
					setEffortError("");
					const result = await postReasoningEffort(value);
					setEffortPending(false);
					if (!result.ok) {
						setEffortError("保存失败：" + result.error);
						return;
					}
					if (typeof reload === "function") reload();
				};
				const onChange = async (event) => {
					const value = event && event.target ? event.target.value : "";
					setPending(true);
					setNote("");
					const result = await postProvider(value);
					setPending(false);
					if (!result.ok) {
						setNote("保存失败：" + result.error);
						return;
					}
					adoptProviderSnapshot(result.provider);
					if (typeof reload === "function") reload();
				};
				const override = model.note;
				const trouble = model.disabled ? model.reason : "";
				const warning = model.warning || "";
				const advisory = [warning, override].filter((part) => part !== "").join(" · ");
				return h("div", { style: S.provCell }, h("div", { style: S.provFieldRow }, h("span", {
					style: S.provLabel,
					title
				}, label), h("select", {
					style: {
						...model.disabled || pending ? {
							...S.select,
							...S.selectOff
						} : S.select,
						flex: "1 1 auto",
						minWidth: 0
					},
					value: model.value,
					disabled: model.disabled || pending,
					onChange,
					title: trouble || override || warning || title,
					"aria-label": label
				}, model.options.map((option, index) => h("option", {
					key: "prov-" + index,
					value: option.value
				}, option.label)))), trouble ? h("span", {
					style: S.valWarn,
					title: trouble
				}, trouble) : null, advisory ? h("span", {
					style: S.valWarn,
					title: advisory
				}, advisory) : null, note ? h("span", { style: S.valIdle }, note) : null, effortLevels.length > 0 ? h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 4
				} }, h("div", { style: S.provFieldRow }, h("span", {
					style: S.provLabel,
					title: EFFORT_TITLE
				}, "推理力度"), h("select", {
					style: {
						...effortPending ? {
							...S.select,
							...S.selectOff
						} : S.select,
						flex: "1 1 auto",
						minWidth: 0
					},
					value: effortValue,
					disabled: effortPending,
					onChange: onEffortChange,
					title: EFFORT_TITLE,
					"aria-label": "推理力度"
				}, effortLevels.map((level) => h("option", {
					key: "effort-" + level,
					value: level
				}, level)).concat(effortHasCurrent ? [] : [h("option", {
					key: "effort-unset",
					value: "",
					disabled: true
				}, "未设置")]))), effortError ? h("span", { style: S.valWarn }, effortError) : null) : null);
			}
			/**
			* The panel-settings controls: a brief-mode dropdown and a working-dir input.
			*
			* These override the patch fields at execution time (panel-settings.json),
			* so a click takes effect on the very next turn — no reload needed. The
			* current values come from the stats snapshot (`config.panelBriefMode`,
			* `config.panelWorkingDir`); `null` means "no override, patch value applies".
			*
			* P1 fix: the working-dir input is LOCAL-STATE driven (seeded from the
			* server value when it changes), so focus+blur without typing does NOT
			* POST null. A save only fires when the value differs from the current
			* server value. An explicit clear (empty string + save button click) is
			* the only way to remove the override.
			*/
			function PanelSettingsControls({ cfg, reload }) {
				const [briefPending, setBriefPending] = useState(false);
				const [briefError, setBriefError] = useState("");
				const [dirPending, setDirPending] = useState(false);
				const [dirError, setDirError] = useState("");
				const briefModes = [
					"always",
					"when-empty",
					"never"
				];
				const currentBrief = cfg && typeof cfg.panelBriefMode === "string" ? cfg.panelBriefMode : "";
				const currentDir = cfg && typeof cfg.panelWorkingDir === "string" ? cfg.panelWorkingDir : "";
				const tagFor = (key, resolved, shippedDefault) => {
					const authored = cfg && cfg.authored && typeof cfg.authored === "object" ? cfg.authored : null;
					return boundaryTag(boundaryVerdict(authored, key, resolved, shippedDefault));
				};
				const tagStyle = {
					color: "#9aa1ac",
					fontSize: 10,
					fontWeight: "normal",
					marginLeft: 4
				};
				const [dirValue, setDirValue] = useState(currentDir);
				const lastServerDir = useRef(currentDir);
				if (currentDir !== lastServerDir.current) {
					lastServerDir.current = currentDir;
					setDirValue(currentDir);
				}
				const onBriefChange = async (event) => {
					const value = event && event.target ? event.target.value : "";
					if (value === currentBrief) return;
					setBriefPending(true);
					setBriefError("");
					const result = await postPanelSettings({ briefMode: value === "" ? null : value });
					setBriefPending(false);
					if (!result.ok) {
						setBriefError("保存失败：" + result.error);
						return;
					}
					if (typeof reload === "function") reload();
				};
				/** Only saves when the value differs from the current server state. */
				const saveDir = async () => {
					const trimmed = dirValue.trim();
					if (trimmed === currentDir) return;
					setDirPending(true);
					setDirError("");
					const result = await postPanelSettings({ workingDir: trimmed === "" ? null : trimmed });
					setDirPending(false);
					if (!result.ok) {
						setDirError("保存失败：" + result.error);
						return;
					}
					if (typeof reload === "function") reload();
				};
				return h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				} }, h("div", { style: S.provCell }, h("div", { style: S.provFieldRow }, h("span", {
					style: S.provLabel,
					title: "这里的选择优先于插件配置（cordis.patch.yml）里 review_brief_mode；选「不覆盖」就回到配置值。含义：代码评审时是否自动补一段评审提示词"
				}, "评审时自动补提示词"), h("span", { style: tagStyle }, tagFor("reviewBriefMode", cfg && cfg.reviewBriefMode, cfg && cfg.defaults && cfg.defaults.reviewBriefMode)), h("select", {
					style: {
						...briefPending ? {
							...S.select,
							...S.selectOff
						} : S.select,
						flex: "1 1 auto",
						minWidth: 0
					},
					value: currentBrief,
					disabled: briefPending,
					onChange: onBriefChange,
					"aria-label": "评审时自动补提示词"
				}, h("option", { value: "" }, "不覆盖（用配置 " + (cfg && typeof cfg.reviewBriefMode === "string" ? cfg.reviewBriefMode : "默认") + "）"), briefModes.map((m) => h("option", {
					key: m,
					value: m
				}, m))))), briefError ? h("span", { style: S.valWarn }, briefError) : null, h("div", { style: S.provCell }, h("div", { style: S.provFieldRow }, h("span", {
					style: S.provLabel,
					title: "这里填的文件夹优先于插件配置里的默认目录；清空并保存 = 不覆盖，改回用配置值或本次会话目录。AtomCode 会在你填的这个文件夹里读文件、跑 git"
				}, "AtomCode 干活的文件夹"), h("span", { style: tagStyle }, tagFor("workingDir", cfg && cfg.defaultWorkingDir, null)), h("div", { style: {
					display: "flex",
					gap: 4,
					flex: "1 1 auto",
					minWidth: 0
				} }, h("input", {
					style: {
						...S.select,
						flex: "1 1 auto",
						minWidth: 0,
						padding: "2px 6px",
						fontSize: 12
					},
					value: dirValue,
					placeholder: currentDir || "不覆盖（用配置/会话目录）",
					disabled: dirPending,
					onChange: (e) => setDirValue(e.target ? e.target.value : ""),
					onKeyDown: (e) => {
						if (e.key === "Enter") saveDir();
					},
					"aria-label": "AtomCode 干活的文件夹（面板覆盖）"
				}), h("button", {
					style: {
						...S.select,
						width: "auto",
						flex: "0 0 auto",
						fontSize: 11,
						cursor: dirPending ? "wait" : "pointer",
						whiteSpace: "nowrap"
					},
					disabled: dirPending || dirValue.trim() === currentDir,
					onClick: saveDir
				}, dirPending ? "…" : "保存")))), dirError ? h("span", { style: S.valWarn }, dirError) : null, (() => {
					const approvalModes = [
						"build",
						"accept_edits",
						"bypass",
						"plan"
					];
					const currentApproval = cfg && typeof cfg.panelApprovalMode === "string" ? cfg.panelApprovalMode : "";
					const onApprovalChange = async (event) => {
						const value = event && event.target ? event.target.value : "";
						if (value === currentApproval) return;
						setBriefPending(true);
						const result = await postPanelSettings({ approvalMode: value === "" ? null : value });
						setBriefPending(false);
						if (!result.ok) {
							setBriefError("保存失败：" + result.error);
							return;
						}
						if (typeof reload === "function") reload();
					};
					return h("div", { style: S.provCell }, h("div", { style: S.provFieldRow }, h("span", {
						style: S.provLabel,
						title: "这里的选择优先于插件配置里的 approval_mode；选「不覆盖」就回到配置值。含义：AtomCode 自动执行工具时受多大限制。注意：当前 daemon 对后台调用一律自动放行，切换这里实际不改变行为"
					}, "AtomCode 自动执行权限"), h("span", { style: tagStyle }, tagFor("approvalMode", cfg && cfg.approvalMode, cfg && cfg.defaults && cfg.defaults.approvalMode)), h("select", {
						style: {
							...S.select,
							flex: "1 1 auto",
							minWidth: 0
						},
						value: currentApproval,
						disabled: briefPending,
						onChange: onApprovalChange,
						"aria-label": "AtomCode 自动执行权限"
					}, h("option", { value: "" }, "不覆盖（用配置 " + (cfg && typeof cfg.approvalMode === "string" ? cfg.approvalMode : "bypass") + "）"), approvalModes.map((m) => h("option", {
						key: m,
						value: m
					}, m)))));
				})(), (() => {
					const currentRounds = cfg && typeof cfg.panelAskMaxRounds === "number" ? cfg.panelAskMaxRounds : "";
					const [roundsValue, setRoundsValue] = useState(currentRounds === "" ? "" : String(currentRounds));
					const saveRounds = async () => {
						const num = roundsValue === "" ? null : parseInt(roundsValue, 10);
						if (num === currentRounds) return;
						setBriefPending(true);
						setBriefError("");
						const result = await postPanelSettings({ askMaxRounds: num === null || Number.isNaN(num) ? null : num });
						setBriefPending(false);
						if (!result.ok) {
							setBriefError("保存失败：" + result.error);
							return;
						}
						if (typeof reload === "function") reload();
					};
					return h("div", { style: S.provCell }, h("div", { style: S.provFieldRow }, h("span", {
						style: S.provLabel,
						title: "这里填的数字优先于插件配置里的 ask_max_rounds；0 = 不设上限（交给 daemon 治理）；留空 = 不覆盖。含义：一次「问 AtomCode」最多让它自己循环多少轮"
					}, "单次咨询最多轮数"), h("span", { style: tagStyle }, tagFor("askMaxRounds", cfg && cfg.askMaxRounds, cfg && cfg.defaults && cfg.defaults.askMaxRounds)), h("div", { style: {
						display: "flex",
						gap: 4,
						flex: "1 1 auto",
						minWidth: 0
					} }, h("input", {
						style: {
							...S.select,
							flex: "1 1 auto",
							minWidth: 0,
							padding: "2px 6px",
							fontSize: 12
						},
						value: roundsValue,
						placeholder: "不覆盖（" + (cfg && typeof cfg.askMaxRounds === "number" ? cfg.askMaxRounds : "25") + "）",
						disabled: briefPending,
						type: "number",
						min: 0,
						max: 1e3,
						onChange: (e) => setRoundsValue(e.target ? e.target.value : ""),
						onKeyDown: (e) => {
							if (e.key === "Enter") saveRounds();
						},
						"aria-label": "单次咨询最多轮数"
					}), h("button", {
						style: {
							...S.select,
							width: "auto",
							flex: "0 0 auto",
							fontSize: 11,
							cursor: briefPending ? "wait" : "pointer"
						},
						disabled: briefPending || roundsValue === (currentRounds === "" ? "" : String(currentRounds)),
						onClick: saveRounds
					}, "保存"))));
				})());
			}
			function useStats() {
				const [data, setData] = useState(null);
				const [error, setError] = useState(null);
				const [updatedAt, setUpdatedAt] = useState(0);
				const alive = useRef(true);
				/** Publish the shared cache to this instance — unless it has unmounted. */
				const commit = useCallback(() => {
					if (!alive.current) return;
					setData(statsCache.data);
					setError(statsCache.error);
					setUpdatedAt(statsCache.fetchedAt);
				}, []);
				const load = useCallback(async () => {
					if (statsCache.fetchedAt > 0 && Date.now() - statsCache.fetchedAt < POLL_MS) {
						commit();
						return;
					}
					if (!statsCache.promise) {
						const controller = typeof AbortController === "function" ? new AbortController() : null;
						const deadlineMs = Math.max(1e3, 4e3);
						let timedOut = false;
						const timer = setTimeout(() => {
							timedOut = true;
							if (controller && controller.abort) controller.abort();
						}, deadlineMs);
						statsCache.promiseStartedAt = Date.now();
						statsCache.promise = (async () => {
							try {
								const response = await fetch(STATS_PATH, {
									headers: { accept: "application/json" },
									cache: "no-store",
									...controller ? { signal: controller.signal } : {}
								});
								if (!response.ok) {
									statsCache.error = "HTTP " + response.status;
									statsCache.data = null;
									return;
								}
								const body = await response.json();
								statsCache.data = body && body.ok ? body : null;
								statsCache.error = null;
								statsCache.fetchedAt = Date.now();
							} catch (reason) {
								statsCache.error = timedOut ? `面板数据 ${deadlineMs / 1e3}s 未返回（daemon 可能卡住）` : reason && reason.message ? reason.message : String(reason);
								statsCache.data = null;
							} finally {
								clearTimeout(timer);
								statsCache.promise = null;
							}
						})();
					}
					const startedAt = statsCache.promiseStartedAt;
					await statsCache.promise;
					reapplyAdoptedProvider(startedAt);
					commit();
				}, [commit]);
				useEffect(() => {
					alive.current = true;
					load();
					const id = setInterval(load, POLL_MS);
					return () => {
						alive.current = false;
						clearInterval(id);
					};
				}, [load]);
				return {
					data,
					error,
					updatedAt,
					reload: load
				};
			}
			function StatusPill({ up }) {
				const color = up ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)";
				return h("span", { style: {
					...S.pill,
					color,
					background: "transparent",
					border: "1px solid " + color
				} }, up ? "运行中" : "未运行");
			}
			function Row({ label, children }) {
				return h("div", { style: S.row }, h("span", { style: S.key }, label), h("span", { style: S.val }, children));
			}
			function CallStat({ num, label, color }) {
				return h("span", { style: {
					...S.callStat,
					color: color || "var(--dsw-alias-label-primary)"
				} }, String(num), h("span", { style: S.callStatLabel }, label));
			}
			/**
			* Compact quota readout: `atom · 2% · 29m13s 后重置` — a click-opens panel.
			* The countdown leads the facts because the rolling window refilling is
			* the thing that changes what the user can do next; the plan period
			* (`3d / 共 7d`) is deliberately absent from the strip (see `chipLabel`).
			*
			* Rendered into `conversation.composer.dock` ("Ambient entries below the
			* composer card") — the strip that already carries the host's own
			* readouts (`7 轮 141 步`, `21.4M tok · 缓存命中`, the context ring). A
			* quota number is a READOUT, so it belongs with the readouts; it used to
			* sit in `conversation.input.right`, which is the submit-adjacent
			* OPERATIONS row (see the registration site for the full reason).
			*
			* The panel replaces a native `title` tooltip. The old one-liner packed
			* four facts into a single line, which read as noise and could not show a
			* LIVE countdown (the browser paints the `title` once, at hover, and it
			* is stale by the time it is read). The panel renders the same facts as
			* rows and re-derives the countdown from `fetchedAt` on every tick.
			*
			* Mirrors the host's own ContextMeter (dsh-client-ui-conversation): a
			* `Tooltip`-wrapped trigger button plus a `createPortal` dialog, dismissed
			* by Escape or an outside pointer. Both primitives are seed modules, so
			* neither `inject` nor a build step is involved; when either is missing
			* the chip degrades to the native `title` rather than failing to mount.
			*
			* Renders nothing when the quota is unknown. The dock itself also
			* collapses when empty (`.dock:empty{display:none}`), so an absent quota
			* costs no layout — a stopped daemon leaves no permanent error badge in
			* the composer, and the detail page still explains why.
			*/
			const { QuotaChip, QuotaChipDegraded } = createQuotaChip({
				h,
				useStats,
				useState,
				useEffect,
				useRef,
				primitives,
				reactDom
			});
			/**
			* Which readout the composer dock gets — decided ONCE, at factory time,
			* from whether the two seed modules resolved. Stable for the life of the
			* registration, so whichever component is chosen always runs the same
			* hook sequence in every render.
			*/
			const QUOTA_READOUT = primitives && reactDom ? QuotaChip : QuotaChipDegraded;
			const StatusSection = createStatusSection({
				h,
				useStats,
				useState,
				StatusPill,
				Row,
				CallStat,
				ProviderSelectRow,
				PanelSettingsControls,
				panelId: REGISTRATION.id
			});
			const { ReviewRail, requestReview } = createReviewHandoff();
			const MessageAsk = createMessageAsk({
				h,
				useState,
				requestReview
			});
			function apply(ctx) {
				let mounted = false;
				const mount = (seat, options) => {
					if (mounted) return;
					try {
						ctx.slots.inject(seat, function() {
							if (mounted) return function() {};
							try {
								const dispose = ctx.slots.register(options, StatusSection);
								mounted = true;
								return dispose;
							} catch (e) {
								return function() {};
							}
						});
					} catch (e) {}
				};
				mount("plugins.bundle.config", {
					name: "plugins.bundle.config",
					key: REGISTRATION.id
				});
				mount("plugins.detail.section", {
					name: "plugins.detail.section",
					id: "atomcode-bridge-status",
					order: 30
				});
				try {
					ctx.slots.inject("conversation.composer.dock", function() {
						try {
							return ctx.slots.register({
								name: "conversation.composer.dock",
								id: "atomcode-bridge-quota",
								order: 1
							}, QUOTA_READOUT);
						} catch (e) {
							return function() {};
						}
					});
				} catch (e) {}
				try {
					ctx.slots.inject("conversation.input.left", function() {
						try {
							return ctx.slots.register({
								name: "conversation.input.left",
								id: "atomcode-bridge-rail",
								order: 100
							}, ReviewRail);
						} catch (e) {
							return function() {};
						}
					});
				} catch (e) {}
				try {
					ctx.slots.inject("conversation.chat.assistant-actions", function() {
						try {
							return ctx.slots.register({
								name: "conversation.chat.assistant-actions",
								id: "atomcode-bridge-review",
								order: 10
							}, MessageAsk);
						} catch (e) {
							return function() {};
						}
					});
				} catch (e) {}
			}
			return {
				inject: ["slots", "locale"],
				apply,
				__test: TESTABLE
			};
		}
	};
	if (typeof window !== "undefined" && window.__ModuleLoader__) window.__ModuleLoader__.load(REGISTRATION);

//#endregion
})();