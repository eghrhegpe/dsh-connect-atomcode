(function() {

//#region src/client/styles.ts
	const S = {
		wrap: {
			width: "100%",
			maxWidth: "1180px",
			minWidth: 0,
			display: "flex",
			flexDirection: "column",
			gap: "12px",
			color: "var(--dsw-alias-label-primary)"
		},
		titleRow: {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			margin: "0 0 2px"
		},
		title: {
			margin: 0,
			fontSize: "13px",
			fontWeight: 600,
			lineHeight: "20px"
		},
		live: {
			fontSize: "11px",
			padding: "1px 7px",
			borderRadius: "999px",
			color: "var(--dsw-alias-state-success-primary)",
			border: "1px solid var(--dsw-alias-state-success-primary)"
		},
		updated: {
			marginLeft: "auto",
			fontSize: "11px",
			color: "var(--dsw-alias-label-tertiary)"
		},
		liveStale: {
			color: "var(--dsw-alias-state-error-primary)",
			borderColor: "var(--dsw-alias-state-error-primary)"
		},
		staleReason: {
			color: "var(--dsw-alias-state-error-primary)",
			maxWidth: "40ch"
		},
		grid: {
			display: "grid",
			gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
			gap: "10px",
			alignItems: "start"
		},
		card: {
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-bg-layer-1)",
			borderRadius: "8px",
			padding: "12px 14px",
			display: "flex",
			flexDirection: "column",
			gap: "6px",
			minWidth: 0
		},
		cardTitle: {
			margin: 0,
			fontSize: "12px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-secondary)"
		},
		row: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "10px",
			fontSize: "12.5px",
			lineHeight: "18px",
			minHeight: "18px"
		},
		key: { color: "var(--dsw-alias-label-tertiary)" },
		val: {
			color: "var(--dsw-alias-label-primary)",
			wordBreak: "break-word",
			textAlign: "right"
		},
		valIdle: {
			color: "var(--dsw-alias-label-secondary)",
			wordBreak: "break-word",
			textAlign: "right"
		},
		valWarn: {
			color: "var(--dsw-alias-state-warning-primary)",
			wordBreak: "break-word",
			textAlign: "right"
		},
		provGrid: {
			display: "flex",
			gap: "10px",
			fontSize: "12.5px"
		},
		provCell: {
			display: "flex",
			flexDirection: "column",
			gap: "4px",
			flex: "1 1 0",
			minWidth: 0
		},
		provLabel: { color: "var(--dsw-alias-label-tertiary)" },
		select: {
			font: "inherit",
			fontSize: "12.5px",
			color: "var(--dsw-alias-label-primary)",
			background: "transparent",
			border: "1px solid rgba(128, 128, 128, 0.35)",
			borderRadius: "5px",
			padding: "2px 6px",
			maxWidth: "100%",
			width: "100%"
		},
		selectOff: { opacity: .55 },
		pill: {
			fontSize: "11px",
			fontWeight: 600,
			padding: "1px 8px",
			borderRadius: "5px",
			lineHeight: "16px"
		},
		metrics: {
			display: "flex",
			gap: "14px",
			flexWrap: "wrap"
		},
		metric: {
			display: "flex",
			flexDirection: "column",
			gap: "2px"
		},
		metricNum: {
			fontSize: "18px",
			fontWeight: 700,
			lineHeight: "22px"
		},
		metricLabel: {
			fontSize: "11px",
			color: "var(--dsw-alias-label-tertiary)"
		},
		callGroups: {
			display: "flex",
			gap: "16px",
			flexWrap: "wrap",
			alignItems: "baseline"
		},
		callGroup: {
			display: "flex",
			gap: "12px",
			alignItems: "baseline",
			paddingRight: "16px",
			borderRight: "1px solid var(--dsw-alias-border-l1)"
		},
		callGroupLabel: {
			fontSize: "11px",
			color: "var(--dsw-alias-label-tertiary)",
			whiteSpace: "nowrap"
		},
		callStat: {
			fontSize: "13px",
			fontWeight: 600,
			whiteSpace: "nowrap"
		},
		callStatLabel: {
			marginLeft: "3px",
			fontSize: "11px",
			fontWeight: 400,
			color: "var(--dsw-alias-label-tertiary)"
		},
		notice: {
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-bg-layer-1)",
			borderRadius: "8px",
			padding: "14px 16px",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: "12.5px"
		},
		error: {
			color: "var(--dsw-alias-state-error-primary)",
			fontSize: "12.5px"
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
			fontSize: "11.5px",
			lineHeight: "17px",
			color: "var(--dsw-alias-label-tertiary)"
		},
		panelFactLead: {
			margin: "0 0 2px",
			fontSize: "11.5px",
			lineHeight: "17px",
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
			color: "var(--dsw-alias-label-secondary)",
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
	* Deliberately weaker than a control: no pill background, no border, and
	* the tertiary label color. Its neighbours (`7 轮`, `21.4M tok`) are
	* session-scoped products; this one is an account-scoped environment
	* fact that happens to be visible here. The visual weight says "different
	* kind of number" without needing a legend.
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
			alignItems: "center",
			opacity: color === "var(--dsw-alias-label-tertiary)" ? .85 : 1
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

//#endregion
//#region src/client/quota.ts
	function fmtDuration(ms) {
		if (!Number.isFinite(ms) || ms <= 0) return "—";
		const n = ms;
		if (n < 1e3) return Math.round(n) + " ms";
		return (n / 1e3).toFixed(1) + " s";
	}
	/** Compact countdown for the CodingPlan rolling-window reset. */
	function fmtCountdown(secs) {
		if (!Number.isFinite(secs) || secs < 0) return "—";
		const s = secs;
		if (s >= 3600) return Math.floor(s / 3600) + "h" + Math.floor(s % 3600 / 60) + "m";
		if (s >= 60) return Math.floor(s / 60) + "m" + Math.round(s % 60) + "s";
		return Math.round(s) + "s";
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
	* The chip's tooltip text, as a LIST of facts.
	*
	* Split rather than pre-joined so the panel can lay each row out on its
	* own line; `null` entries are dropped, which is what lets a partially-known
	* quota show the rows it has instead of a ragged sentence with holes.
	*/
	function quotaFacts(quota, pct, liveSecs) {
		return [
			quota.plan ? "CodingPlan " + quota.plan : "CodingPlan",
			[quota.expires, quota.planWindow].filter(Boolean).join(" · "),
			"窗口已用 " + pct + "%",
			liveSecs === null ? null : "约 " + fmtCountdown(liveSecs) + " 后重置"
		].filter(Boolean);
	}
	/**
	* The window descriptor for quota readouts. Prefer the window the daemon
	* actually reported (`planWindow`, parsed from the status text) over the
	* historical "5小时" default — a 7-day plan must not be labelled "5小时窗口".
	* Falls back to "5小时" only when the daemon did not expose a window at all.
	*/
	function windowLabel(planWindow) {
		return typeof planWindow === "string" && planWindow.trim() !== "" ? planWindow.trim() : "5小时";
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
			label: "atom · " + windowLabel(quota.planWindow) + " " + pct + "%",
			color: limited || quota.usagePercent >= 100 ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)",
			facts: quotaFacts(quota, pct, liveSecs),
			barWidth: barWidth(pct)
		};
	}

//#endregion
//#region src/shared/loopback.ts
/**
	* loopback.ts — "is this base_url a process on THIS machine?", asked once.
	*
	* Two halves need the same answer about the same string:
	*
	*  - the HOST, before spawning a review, decides whether to probe the endpoint
	*    first (a dead local proxy deserves a named diagnosis, not the CLI's bare
	*    `Cancelled`);
	*  - the RENDERER, when the user picks that entry, words the dependency warning
	*    ("评审经本机进程转发计费，它一停 review 立刻断").
	*
	* Those two used to be two hand-written copies of the same four-line predicate.
	* The copies agreed, which is exactly why nobody noticed — and the day one of
	* them learned about, say, `0.0.0.0` or a bracketed IPv6 form, the panel would
	* warn about an endpoint the host never probes (or stay silent about one it
	* does). This repository's rule is one fact, one place; a predicate shared by
	* two bundles is the case that rule exists for.
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
		const dir = typeof src.defaultWorkingDir === "string" ? src.defaultWorkingDir : "";
		const rounds = Number.isInteger(src.askMaxRounds) ? src.askMaxRounds : null;
		const verdict = (key, value, fallback) => {
			if (authored && key in authored) return authored[key] === true ? "changed" : "default";
			if (fallback === null || fallback === void 0 || fallback === "") return "unknown";
			return value === fallback ? "default" : "changed";
		};
		const tag = (v) => v === "changed" ? "（已改）" : v === "default" ? "（插件默认）" : "";
		return [
			{
				label: "审批模式",
				text: mode === "" ? "—" : mode + tag(verdict("approvalMode", mode, approvalDefault)),
				title: "patch 字段 approval_mode；面板上没有输入框，改它要动 cordis.patch.yml。bypass = AtomCode 自己的工具在回合内无人值守执行（AtomCode 侧自主，与 DSH 的权限预设无关）。"
			},
			{
				label: "工作目录",
				text: dir === "" ? "（会话工作目录）" : dir + tag(verdict("workingDir", dir, null)),
				title: dir === "" ? "patch 字段 working_dir 留空 = 靠调用参数或会话工作目录" : "patch 字段 working_dir"
			},
			{
				label: "ask 轮数上限",
				text: rounds === null ? "—" : rounds > 0 ? String(rounds) + tag(verdict("askMaxRounds", rounds, askDefault)) : "不限",
				title: "patch 字段 ask_max_rounds。超出即停止等待（不是远端 kill：daemon 侧的回合可能仍在后台跑完）。"
			}
		];
	}
	/**
	* The model rows, derived from ONE stats snapshot.
	*
	* Two entries, always both, never collapsed into one: they are TWO DIFFERENT
	* namespaces (ask = daemon model profile, review = CLI direct entry), and one
	* merged row would read as "same knob, two names" — the exact confusion
	* 红线 8 exists to prevent.
	*/
	function providerRows(cfg) {
		const src = cfg && typeof cfg === "object" ? cfg : {};
		const name = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : "";
		const ask = name(src.defaultProvider);
		const review = name(src.reviewDefaultProvider);
		return [{
			slotName: "ask",
			label: "默认档位 · ask",
			fallback: "未插手",
			value: ask || "未插手",
			pinned: ask !== "",
			title: "atomcode_ask 走 daemon：这里选的是模型档位（GET /models 的 provider 字段，形如 AtomGit-glm5.3-flash）。未插手 = 连 provider 字段都不发，由 AtomCode 自己的默认决定。只影响不显式传 provider 的调用。"
		}, {
			slotName: "review",
			label: "默认 provider · review",
			fallback: "未插手",
			value: review || "未插手",
			pinned: review !== "",
			title: "atomcode_review 走 CLI：这里选的是 config.toml 里的直连条目名（[providers.<name>]，形如 atomcode-local —— 那是个名字，不是文件路径）。未插手 = 由 config.toml 的默认或唯一直连条目顶上。与左边是两套命名空间，不能同一个名字两边用。"
		}];
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
	function providerSelectModel(provider, slotName, fallbackLabel) {
		const src = provider && typeof provider === "object" ? provider[slotName] : null;
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
			return {
				value,
				label: !!(v && typeof v === "object" && v.isDefault === true) ? `${value}（默认）` : value
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
			reason = slotName === "ask" ? "daemon 未列出档位" : "config.toml 里没有直连条目";
		}
		let note = "";
		if (!disabled && effective !== "" && effective !== panel) {
			if (source === "panel") note = "这次调用实际用 " + effective + "（不是这里选的）";
			else if (source === "config") note = "当前生效 " + effective + "（来自配置）";
			else if (source === "atomcode") note = "当前生效 " + effective + "（AtomCode 默认）";
			else if (source === "argument") note = "本次调用指定 " + effective;
		}
		let warning = "";
		if (slotName === "review") {
			const baseUrl = name((src.endpoints && typeof src.endpoints === "object" ? src.endpoints : {})[name(panel) || effective]);
			if (baseUrl !== "" && isLoopbackBaseUrl(baseUrl)) warning = "本地端点 " + baseUrl + "：评审经本机进程转发计费，它一停 review 立刻断（探活会给出具名诊断）";
		}
		return {
			value: panel,
			options,
			disabled,
			reason,
			effective,
			source,
			note,
			warning
		};
	}

//#endregion
//#region src/client/index.ts
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
				promise: null
			};
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
				isLoopbackEndpoint: isLoopbackBaseUrl,
				daemonStatusLine,
				protocolDriftNotice
			};
			async function postProvider(slotName, value) {
				try {
					const response = await fetch(PROVIDER_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							slot: slotName,
							provider: value === "" ? null : value
						})
					});
					let parsed = null;
					try {
						parsed = await response.json();
					} catch {
						parsed = null;
					}
					if (parsed && parsed.ok === true) return {
						ok: true,
						provider: parsed
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
			/**
			* One interactive provider control: a dropdown scoped to ONE namespace.
			*
			* Two per snapshot, never merged: ask lists daemon model profiles, review lists
			* config.toml direct entries (红线 8). Laid out as one line with two cells —
			* the label sits above its dropdown, and the provenance that used to sit in
			* the card body now lives in the `title` (see providerRows()).
			*
			* Pending/error state is local, and the control is never swapped back to static
			* text — a failed write must stay visible with its reason, or the user cannot
			* tell "the plugin refused" from "my click did nothing".
			*/
			function ProviderSelectRow({ label, slotName, provider, fallbackLabel, title, reload }) {
				const model = providerSelectModel(provider, slotName, fallbackLabel);
				const [note, setNote] = useState("");
				const [pending, setPending] = useState(false);
				const onChange = async (event) => {
					const value = event && event.target ? event.target.value : "";
					setPending(true);
					setNote("");
					const result = await postProvider(slotName, value);
					setPending(false);
					if (!result.ok) {
						setNote("保存失败：" + result.error);
						return;
					}
					if (typeof reload === "function") reload();
				};
				const override = model.note;
				const trouble = model.disabled ? model.reason : "";
				const warning = model.warning || "";
				return h("div", { style: S.provCell }, h("span", {
					style: S.provLabel,
					title
				}, label), h("select", {
					style: model.disabled || pending ? {
						...S.select,
						...S.selectOff
					} : S.select,
					value: model.value,
					disabled: model.disabled || pending,
					onChange,
					title: trouble || override || warning || title,
					"aria-label": label
				}, model.options.map((option, index) => h("option", {
					key: slotName + "-" + index,
					value: option.value
				}, option.label))), trouble ? h("span", {
					style: S.valWarn,
					title: trouble
				}, trouble) : null, warning ? h("span", {
					style: S.valWarn,
					title: warning
				}, warning) : null, override ? h("span", {
					style: S.valWarn,
					title: override
				}, override) : null, note ? h("span", { style: S.valIdle }, note) : null);
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
					await statsCache.promise;
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
			function Metric({ num, label, color }) {
				return h("div", { style: S.metric }, h("span", { style: {
					...S.metricNum,
					color: color || "var(--dsw-alias-label-primary)"
				} }, String(num)), h("span", { style: S.metricLabel }, label));
			}
			function CallStat({ num, label, color }) {
				return h("span", { style: {
					...S.callStat,
					color: color || "var(--dsw-alias-label-primary)"
				} }, String(num), h("span", { style: S.callStatLabel }, label));
			}
			/**
			* Compact quota readout: `atom · 5小时 19%` — a click-opens panel.
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
				return h("span", {
					ref: rootRef,
					"data-quota-percent": view.pct,
					style: CHIP_STYLE(view.color)
				}, h(primitives.Tooltip, {
					label: view.facts.join(" · "),
					side: "top",
					delayMs: 200,
					disabled: open
				}, h("button", {
					type: "button",
					style: CHIP_TRIGGER_STYLE,
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					onClick: () => setOpen(!open)
				}, view.label)), open && reactDom.createPortal(h("div", {
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
				return h("span", {
					title: view.facts.join(" · "),
					"data-quota-percent": view.pct,
					style: CHIP_STYLE(view.color)
				}, view.label);
			}
			/**
			* Which readout the composer dock gets — decided ONCE, at factory time,
			* from whether the two seed modules resolved. Stable for the life of the
			* registration, so whichever component is chosen always runs the same
			* hook sequence in every render.
			*/
			const QUOTA_READOUT = primitives && reactDom ? QuotaChip : QuotaChipDegraded;
			/**
			* The bundle card's one-liner (`view: 'summary'`).
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
				const cfg = data.config || {};
				const parts = [daemonStatusLine(d, data.protocol && data.protocol.daemonVersion), "端口 " + (d.port == null ? "—" : d.port)];
				if (cfg.reviewAvailable === false) parts.push("评审不可用");
				return h("span", {
					style: S.provLabel,
					title: parts.join(" · ")
				}, parts.join(" · "));
			}
			function StatusSection(props) {
				const view = props && props.view;
				const subject = props && props.subject;
				if (!(view === "summary" || view === "page")) {
					if ((subject && subject.kind === "bundle" ? subject.pkg && subject.pkg.name : void 0) !== "dsh-connect-atomcode") return null;
				}
				if (view === "summary") return h(SummaryLine, null);
				const { data, error, updatedAt, reload } = useStats();
				let body;
				if (error) body = h("div", { style: S.notice }, h("p", { style: S.error }, "统计信息加载失败：" + error));
				else if (!data) body = h("div", { style: S.notice }, "加载中…");
				else {
					const d = data.daemon || {};
					const bin = data.binary || {};
					const cfg = data.config || {};
					const quota = data.quota || {};
					const ask = data.ask || {
						calls: 0,
						ok: 0,
						err: 0,
						msTotal: 0,
						tokens: 0
					};
					const review = data.review || {
						calls: 0,
						ok: 0,
						err: 0,
						msTotal: 0
					};
					const proto = data.protocol || {};
					const protoNotice = protocolDriftNotice(proto);
					const prov = data.provider || null;
					const retryNote = cfg.daemonRetrySecs > 0 ? cfg.daemonRetrySecs + "s" : "每次轮询";
					const liveResetSecs = liveRemaining(quota.resetInSecs, quota.fetchedAt, Date.now());
					const quotaPct = typeof quota.usagePercent === "number" ? quota.usagePercent : null;
					const quotaExpiry = [quota.expires, quota.planWindow].filter(Boolean).join(" · ");
					const askAvg = ask.calls > 0 ? Math.round(ask.msTotal / ask.calls) : 0;
					const reviewAvg = review.calls > 0 ? Math.round(review.msTotal / review.calls) : 0;
					const binPath = bin.configured || bin.env || "自动探测（PATH）";
					const spawnNote = d.up ? d.spawnTried ? "已自动拉起" : "运行中" : d.starting ? "正在拉起…" : d.spawnTried ? "自动拉起失败" : "未触发自动拉起";
					body = h("div", { style: S.wrap }, h("div", { style: S.titleRow }, h("h3", { style: S.title }, "运行统计"), h("span", { style: error ? {
						...S.live,
						...S.liveStale
					} : S.live }, error ? "已断开" : "实时"), updatedAt ? h("span", {
						style: S.updated,
						title: error || ""
					}, (error ? "最后更新 " : "更新于 ") + new Date(updatedAt).toLocaleTimeString("zh-CN")) : null, error ? h("span", {
						style: {
							...S.updated,
							...S.staleReason
						},
						title: error
					}, error) : null), proto.quotaTextDrift ? h("div", { style: S.notice }, "额度解析失配：daemon 的 status 文本已不符合已知形状（AtomCode 可能已升级），下面显示的是原始文本而非解析结果。可手工核对 /api/atomcode-bridge/stats 的 quota.raw。") : null, protoNotice ? h("div", { style: S.notice }, protoNotice) : null, cfg.reviewAvailable ? null : h("div", { style: S.notice }, "代码评审（atomcode_review）当前不可用：" + (cfg.reviewReason || "本机 AtomCode 配置没有可用的直连 provider") + "。侧边咨询（atomcode_ask）不受影响。"), h("div", { style: S.grid }, h("div", { style: S.card }, h("p", { style: {
						...S.cardTitle,
						display: "flex",
						alignItems: "center",
						gap: "8px"
					} }, "启动情况", h(StatusPill, { up: !!d.up })), h(Row, { label: "监听端口" }, String(d.port)), h(Row, { label: "自动启动" }, d.autoStart ? "开启" : "关闭"), h(Row, { label: "拉起状态" }, spawnNote), !d.up && !d.starting ? h(Row, { label: "未就绪原因" }, d.downMessage || "未上报（宿主较旧）") : null, h(Row, { label: "daemon 版本" }, proto.daemonVersion || (d.up ? "未知" : "—")), !d.up && d.spawnFailures > 1 ? h(Row, { label: "拉起重试" }, `失败 ${d.spawnFailures} 次（每 ${retryNote} 重试一次）`) : null), h("div", { style: S.card }, h("p", { style: S.cardTitle }, "运行环境"), h(Row, { label: "AtomCode" }, binPath), h("div", { style: S.provGrid }, providerRows(cfg).map((row) => h(ProviderSelectRow, {
						key: "provider-" + row.slotName,
						label: row.label,
						slotName: row.slotName,
						provider: prov,
						fallbackLabel: row.fallback,
						title: row.title,
						reload
					}))), cfg.reviewAvailable ? null : h(Row, { label: "评审可用性" }, h("span", { style: S.error }, "不可用 — 改用 atomcode_ask"))), h("div", { style: S.card }, h("p", { style: S.cardTitle }, "回合边界"), turnBoundaryRows(cfg).map((row) => h(Row, {
						key: "bound-" + row.label,
						label: row.label
					}, h("span", { title: row.title }, row.text)))), h("div", { style: S.card }, h("p", { style: S.cardTitle }, "侧边会话"), h("div", { style: S.metrics }, h(Metric, {
						num: data.sessions && data.sessions.tracked || 0,
						label: "已跟踪会话"
					})), h(Row, { label: "运行时长" }, fmtDuration(data.uptimeMs)), data.sessions && data.sessions.error ? h("p", { style: S.error }, "会话续接已降级（回复不受影响）：" + data.sessions.error) : null), h("div", { style: S.card }, h("p", { style: S.cardTitle }, "工具调用统计"), h("div", { style: S.callGroups }, h("div", { style: S.callGroup }, h("span", { style: S.callGroupLabel }, "atomcode_ask"), h(CallStat, {
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
					})), h("div", { style: {
						...S.callGroup,
						borderRight: "none",
						paddingRight: 0
					} }, h("span", { style: S.callGroupLabel }, "atomcode_review"), h(CallStat, {
						num: review.calls,
						label: "调用"
					}))), h(Row, { label: "ask 累计 tokens" }, String(ask.tokens)), h(Row, { label: "ask 平均耗时" }, fmtDuration(askAvg)), h(Row, { label: "review 平均耗时" }, fmtDuration(reviewAvg))), h("div", { style: S.card }, h("p", { style: S.cardTitle }, "CodingPlan 额度"), !quota.available ? h("p", { style: S.error }, quota.reason || "额度不可用（daemon 未运行或命令不可用）") : quotaPct == null && !quota.plan ? h("div", null, h("p", { style: S.key }, quota.reason || "未能从 status 文本中识别出额度"), quota.raw && quota.raw.usageLine ? h("p", { style: S.key }, quota.raw.usageLine) : null, quota.raw && quota.raw.planLine ? h("p", { style: S.key }, quota.raw.planLine) : null) : h("div", null, quotaPct == null ? h("div", { style: S.metric }, h("span", { style: S.metricLabel }, quota.reason || "额度读数不可用")) : h("div", { style: S.metric }, h("span", { style: {
						...S.metricNum,
						color: quotaColor(quotaPct, quota.limited)
					} }, pctLabel(quotaPct)), h("span", { style: S.metricLabel }, "当前时间窗口用量" + (liveResetSecs == null ? "" : " · " + fmtCountdown(liveResetSecs) + " 后重置"))), quotaPct == null ? null : h("div", { style: {
						height: "6px",
						borderRadius: "3px",
						border: "1px solid var(--dsw-alias-border-l1)",
						overflow: "hidden"
					} }, h("div", { style: {
						height: "100%",
						width: barWidth(quotaPct) + "%",
						background: quotaColor(quotaPct, quota.limited)
					} })), h(Row, { label: "套餐" }, quota.plan || "—"), h(Row, { label: "到期" }, quotaExpiry || "—"), h(Row, { label: "重置于" }, quota.resetAt || "—"), quota.limited ? h("p", { style: S.error }, "当前 " + windowLabel(quota.planWindow) + " 窗口已用尽，回合会被限流") : null))));
				}
				return body;
			}
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