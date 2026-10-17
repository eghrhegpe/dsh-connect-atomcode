import { TOOLS_CAP, askChat } from "./daemon.js";
import { HOST_TOOL_TIMEOUT_MS, HOST_TOOL_TIMEOUT_SECS, MAX_REVIEW_DURATION_SECS, OUTPUT_CAP, REVIEW_REPORT_FLOOR, resolveDurationSecs, resolveMaxRounds } from "./config.js";
import { FINDINGS_CAP, PROVIDER_FIX, checkReviewProvision, probeLocalEndpoint, runReview, selectReviewProvider } from "./review.js";
import { describeDaemonDown } from "./stats.js";
import { isLoopbackBaseUrl } from "./loopback.js";
import { resolve } from "node:path";

//#region src/host/tools.ts
/**
* The two tools this plugin registers — `atomcode_ask` (a full autonomous
* daemon turn with side-conversation continuity) and `atomcode_review` (a
* one-shot code review through the CLI subcommand).
*
* Extracted from `src/host/index.ts` (v0.4.3 split). They live together because
* they share the one `tools.register` surface and the one `runtime`; each tool
* still owns its description string end to end, which is why the two
* `providerHint` strings are built HERE next to the `register()` calls that
* consume them — a description separated by hundreds of lines from the code it
* describes goes quietly stale with nothing failing.
*
* @module dsh-connect-atomcode/host/tools
*/
/**
* The active DSH session's working directory as exposed by the host on the
* tool-call context — a READY-TO-USE auto-fill hook.
*
* The DSH host does not pass the session's cwd to plugin tools yet, so this
* returns `undefined` today and the fallback ladders below behave exactly as
* before (tests pass `exec = {}`, so it stays a no-op there). The moment the
* host exposes that cwd on the tool-call context (this reads `exec.cwd`; the
* field name is the one to align with the host), `working_dir` auto-fills with
* the repo the user actually has open. Safe for BOTH tools: it is the user's
* repo, not the host process's launch directory — 红线 8 only excludes the
* host cwd, never the session cwd.
*/
function hostSessionCwd(exec) {
	return exec && typeof exec.cwd === "string" && exec.cwd.trim() !== "" ? exec.cwd : void 0;
}
/**
* Cut prose down to `cap` characters, with the cut MARKED in the text itself.
*
* One helper for both tools because there used to be two hand-written markers
* (`ask AtomCode to write the full text to a file` on one path, a bare
* `N more characters` on the other) and two caps that happened to be equal —
* i.e. one convention per copy. A truncation convention that varies by call site
* is a truncation the reader learns to miss; the `remedy` is the only part that
* legitimately differs, because what to do about a clipped reply is not what to
* do about a clipped report.
*
* The marker goes INSIDE the returned text on purpose. A silent clip reads to the
* model as a complete answer, which is how a half-copied document becomes a
* confidently wrong summary — the same reason `tools_truncated` and
* `findings_parsed` exist as their own fields rather than as omissions.
*
* @param {string} text - the prose to bound.
* @param {number} cap - the character budget for it.
* @param {{remedy?: string}} [options] - what the reader should do about it.
* @returns {{text: string, cut: boolean}} the text to show, and whether it was cut.
*/
function capProse(text, cap, options = {}) {
	const body = typeof text === "string" ? text : "";
	if (body.length <= cap) return {
		text: body,
		cut: false
	};
	const omitted = body.length - cap;
	const remedy = options.remedy ? `; ${options.remedy}` : "";
	return {
		text: `${body.slice(0, cap)}\n\n[truncated by dsh-connect-atomcode: ${omitted} more characters${remedy}]`,
		cut: true
	};
}
/**
* The DSH host accepts a CLOSED JSON-Schema subset at `tools.register` —
* `type` must be a single type string. Array-typed unions
* (`type: ['boolean', 'null']`) are rejected there with a `JsonSchemaError`,
* which makes `apply()` throw and the plugin NEVER ACTIVATES: no tools, no
* web routes, and the detail-page card shows HTTP 404 on its stats fetch
* (the 2026-10 incident, reproduced on host 0.2.0-rc.1 against the dev tree
* that had gained null-carrying union types).
*
* Those unions are not decorative: `null` is a LEGITIMATE value on these
* fields (an unattributable parallel tool batch, an unattended turn, an
* unreported daemon stat), and the host validates the RETURNED value against
* `output.schema` at call time — so collapsing a union to one member type
* makes every legitimate null throw a `ToolOutputError`. The sanctioned
* escape is an annotation-only node: the validator explicitly accepts a
* schema without a `type` key ("the standard unconstrained-JSON form"), and
* each affected field's `description` already carries its "null = ..."
* semantics. So this sanitizer drops exactly the array-typed `type` keys and
* nothing else: `required`/`items`/`additionalProperties` survive, which
* keeps null values expressible and the fields' nullability documented.
*
* @param {any} node - a registered output schema (or one of its subnodes).
* @returns {any} a host-acceptable copy with no array-typed `type` keys.
*/
function hostSubsetSchema(node) {
	if (node === null || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map((item) => hostSubsetSchema(item));
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "type" && Array.isArray(value)) continue;
		out[key] = hostSubsetSchema(value);
	}
	return out;
}
/**
* `atomcode_ask` — one full autonomous daemon turn, with side-conversation
* continuity.
*
* The description is assembled HERE rather than at the mount site: `providerHint`
* names the live state of `default_provider`, so it and the `register()` call that
* consumes it belong in the same scope. They used to be separated by hundreds of
* lines, which is how a description goes quietly stale against the code it
* describes with nothing failing.
*
* @returns {() => void} the tool’s disposer.
*/
function mountAskTool({ tools, config, runtime }) {
	const { port, autoStart, approvalMode, defaultWorkingDir, defaultProvider, askMaxRounds } = config;
	const { stats, sessions, resolveProvider, ensureDaemon } = runtime;
	const providerHint = "换模型：provider 参数收的是 AtomCode 的模型档位名（daemon GET /models 里的 provider 字段，如 \"AtomGit-glm5.3-flash\"；不是裸模型 id \"glm5.3-flash\"）。优先级：本参数 > 详情页面板上选的档位 > 插件配置 default_provider" + (defaultProvider ? `（当前 default_provider="${defaultProvider}"）` : "（当前未配 default_provider）") + " > AtomCode 自己的默认档位；返回里的 provider= 是 daemon 报的真实生效值。";
	return tools.register({
		name: "atomcode_ask",
		description: "把一条消息转发给本机 AtomCode（终端 AI 编程助手，官方二进制）的 daemon 执行一个完整自主回合（它自带工具循环，approval_mode 默认 bypass 无人值守放行），取回整轮回复。用于\"帮我问 AtomCode / 让 AtomCode 处理 / 侧边咨询\"场景；拿到结果后把 reply 转达给用户。调用时请给出 working_dir（要处理的仓库/目录）——它同时是它的读写边界和侧边对话的会话键；缺省优先级：参数 > 宿主会话 cwd > 插件配置 working_dir，三者都取不到时本工具直接拒绝该回合（不放行无人值守的工具调用跑在用户 home 里），除非显式传 allow_unattended=true。continue=true 接续本工作目录上一次侧边对话（自动恢复 session，无需记 id）；默认开新线。续线接到死会话时用 reset_session=true 重新开线。整回合可能数分钟。" + providerHint,
		timeoutMs: HOST_TOOL_TIMEOUT_MS,
		parameters: {
			type: "object",
			properties: {
				message: {
					type: "string",
					description: "转发给 AtomCode 的消息（通常是用户最新一句话的原文）"
				},
				continue: {
					type: "boolean",
					description: "可选：接续本工作目录上一次侧边对话（默认 false，开新会话）。注意：会话按 working_dir 记忆，同一仓库的两次不相干对话会共用同一条侧边线"
				},
				session_id: {
					type: "string",
					description: "可选：显式接续某个 AtomCode 会话（优先于 continue）"
				},
				reset_session: {
					type: "boolean",
					description: "可选：清掉本工作目录记录的侧边会话（续线接到一条已过期的 daemon 会话、或想彻底开新线时用；不影响本回合）"
				},
				provider: {
					type: "string",
					description: "可选：点名 AtomCode 模型档位，传它就换本次回合用的模型。名字以 daemon GET /models 的 provider 字段为准（如 \"AtomGit-glm5.3-flash\"），不要传裸模型 id（\"glm5.3-flash\"）。留空时按顺序取：面板上选的档位 → 插件配置 default_provider → AtomCode 自己的默认"
				},
				working_dir: {
					type: "string",
					description: "回合的工作目录，同时是侧边对话的会话键。缺省优先级：调用参数 > 宿主会话 cwd（宿主尚未暴露该字段，暴露后自动填入）> 插件配置 working_dir。三者都没有时本工具**拒绝**该回合（见 allow_unattended）——让 AtomCode 的工具在 daemon 自己的 cwd（通常是用户 home）里无人值守跑，是 atomcode_review 一直直接拒绝的那个情况"
				},
				allow_unattended: {
					type: "boolean",
					description: "可选，默认 false。上面三条都取不到目录时才需要它：那种情况下本工具默认拒绝（红线 8——无人值守的工具调用跑在一个没人指定的目录里；当前 daemon 对任何 approval_mode 都是无人值守自动放行，所以这道门与 mode 无关）。确实只做通用问答、不需要任何目录时，显式传 true 表示知情同意；能给出目录就优先给 working_dir，别用它绕开"
				},
				timeout_secs: {
					type: "number",
					description: "可选：整回合超时秒数，默认 1800；上限 1800（本工具向宿主声明的超时上限就是 30 分钟），超过按 1800 计——代码里钳制，不是\"传了更大的值但悄悄不生效\""
				},
				max_rounds: {
					type: "number",
					description: "可选：工具调用次数上限（按 daemon SSE 的 tool_start 事件计数；一个 agent 回合可能并行发起多次工具调用，故事件数 ≥ agent 轮数——把它当轮数理解，会在更少的 agent 轮数上就熔断）。默认取插件配置，当前 " + askMaxRounds + "；上限 1000，超过按 1000 计（钳制在代码里，inflate 关不掉熔断）。传 0 关掉本端熔断，交回 daemon 自带治理——与 atomcode_review 的 max_rounds: 0 同义）。超限时本端中止等待并返回错误，同时向 daemon 发 POST /chat/stop 请求停掉该回合（以 daemon 应答为准；回合刚开始还没拿到 session_id 时无法请求，错误文本会说明这一种情况）"
				}
			},
			required: ["message"]
		},
		output: {
			schema: hostSubsetSchema({
				type: "object",
				properties: {
					ok: { type: "boolean" },
					reply: { type: "string" },
					session_id: { type: "string" },
					continued: { type: "boolean" },
					truncated: {
						type: "boolean",
						description: "reply 超过上限被截断（截断处有标记；让 AtomCode 把长内容落盘再读，别只靠这一份摘要）"
					},
					tokens: { type: "number" },
					tool_calls: { type: "number" },
					round_count: {
						type: "number",
						description: "本回合 tool_start 事件数（≥ agent 轮数：同一轮并行发起的工具调用会各计一次）"
					},
					tools: {
						type: "array",
						description: `本回合的工具记录，最多 ${30} 条（超出部分被省略，见 tools_truncated；tool_calls 仍是真实总数）。success 为 null 表示本端无法判断该次调用成败：daemon 并行发起的工具调用只回 {type:"tool_result",success:..}，不带名字或 id，本端无从知道它属于同一批里的哪一个——此时不猜，一律置 null`,
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								success: {
									type: ["boolean", "null"],
									description: "该次工具调用是否成功；null = 并行批次内结果无法归因，成败未知（不是失败）"
								}
							},
							required: ["name", "success"],
							additionalProperties: false
						}
					},
					tools_truncated: {
						type: "boolean",
						description: "tools 数组被截断（只回了前若干条；tool_calls 是真实总数，不代表 tools 就是全部）"
					},
					stop_reason: { type: "string" },
					working_dir: {
						type: ["string", "null"],
						description: "本回合实际使用的工作目录（同时是侧边对话的会话键）。null = 本回合没有指定任何目录，跑在 daemon 自己的 cwd 下（通常是用户 home）——而当前 daemon 对任何 approval_mode 都是无人值守自动放行（bypass 只是出厂默认），所以这个组合现在只可能由调用方显式传 allow_unattended=true 产生（否则本工具在开跑前就拒绝了）。要指定仓库就显式传 working_dir"
					},
					provider: { type: "string" },
					providerReported: {
						type: "boolean",
						description: "provider 是否来自 daemon SSE 的 runtime_info（true = 远端实测值；false = daemon 未报，回显本插件请求值、未经远端证实——daemon 升级后若不再发 runtime_info，每回合都会带 false 并标注）"
					},
					protocol_unknown_types: {
						type: "array",
						description: "本回合 daemon 发来、本插件不认识的事件类型（空数组 = 词汇表未变，是常态；恒有本字段，故「没观察到漂移」与「没检查漂移」不会混淆）。非空说明 AtomCode 可能已升级或改了事件名。注意：轮数熔断靠计数 tool_start 生效，若被改名的正是这类被计数的事件，熔断会少计甚至完全不触发——此时 round_count 不可信。要和 daemon 自报的次数对照就看 daemon_tool_calls",
						items: { type: "string" }
					},
					daemon_tool_calls: {
						type: ["number", "null"],
						description: "daemon 在 done 里自报的本回合工具调用次数（done.tool_calls，或 done.stats.tool_calls）。null = 它没报（旧 daemon 或极端的协议漂移）——「它说 0 次」和「它什么都没说」不是同一件事。与 round_count 对照即知本端熔断这一轮有没有真在工作：两者对不上而 round_count 更小，说明被计数的事件已改名，熔断本轮等于没生效"
					},
					daemon_rounds: {
						type: ["number", "null"],
						description: "daemon 自报的 agent 轮数（done.stats.rounds），null = 没报。与 daemon_tool_calls 不是同一个数字：一个 agent 轮可以并行发起多次工具调用，所以轮数 ≤ 工具调用数。用于判断漂移的是哪一边"
					},
					error: { type: "string" }
				},
				required: [
					"ok",
					"reply",
					"session_id",
					"continued",
					"truncated",
					"tokens",
					"tool_calls",
					"tools",
					"tools_truncated",
					"stop_reason",
					"working_dir",
					"provider",
					"providerReported",
					"protocol_unknown_types",
					"daemon_tool_calls",
					"daemon_rounds",
					"error"
				],
				additionalProperties: false
			}),
			render(_args, value) {
				const lines = [];
				if (value.ok) {
					lines.push(value.continued ? "AtomCode 接续回复（侧边对话）:" : "AtomCode 回复:", value.reply || "(空回复)", "");
					if (value.error) lines.push(`[注意：本回合收到 done 但流中带有 error 事件，回复可能残缺: ${value.error}]`, "");
					if (value.truncated) lines.push("[注意：reply 已截断，让 AtomCode 把完整内容写到文件里再读]", "");
					if (value.tools_truncated) lines.push(`[注意：tools 只回了前 ${30} 条，本回合工具调用不止这些（见 tool_calls）]`, "");
					const unattributed = Array.isArray(value.tools) ? value.tools.filter((t) => t && t.success === null).length : 0;
					if (unattributed > 0) lines.push(`[注意：tools 里有 ${unattributed} 条 success=null——daemon 并行发起的工具调用结果不带归属标识，本端无法判定这些调用的成败（未知，不是失败），不要据此重做]`, "");
					if (value.providerReported === false) lines.push("[注意：daemon 未报 runtime_info，provider= 是本插件回传请求值、未经远端证实（daemon 可能已升级）]", "");
					if (value.working_dir === null || value.working_dir === void 0) lines.push("[注意：本回合未指定 working_dir——调用方已显式 allow_unattended=true 放行。工具在 daemon 自己的 cwd 下执行（通常是用户 home），且无人值守自动放行（当前 daemon 对任何 approval_mode 都成立，本回合 approval_mode=" + approvalMode + "）。要限定目录请显式传 working_dir 或配置插件的 working_dir]", "");
					if (Array.isArray(value.protocol_unknown_types) && value.protocol_unknown_types.length > 0) {
						const ourCount = value.round_count || 0;
						const theirCount = value.daemon_tool_calls;
						const knows = typeof theirCount === "number";
						const disagrees = knows && theirCount !== ourCount;
						lines.push(`[注意：本回合 daemon 发来本插件不认识的事件类型（${value.protocol_unknown_types.join(", ")}），AtomCode 可能已升级或改了事件名。本端轮数熔断靠计数 tool_start 生效——` + (disagrees ? `而 daemon 自报 ${theirCount} 次工具调用、本端只数到 ${ourCount} 次：两次计数对不上，` + (theirCount > ourCount ? "**本回合的熔断确实没有生效**（不是\"可能失效\"）。" : "本端多算了——熔断比应有的更早触发，同样需要核对。") : knows ? `daemon 自报 ${theirCount} 次工具调用、与本端计数一致：被改名的不在这类被计数的事件里，本回合的熔断是准的。但下一次改名未必还避开它。` : ourCount === 0 ? "而本回合轮数为 0，且 daemon 没有自报次数：若被改名的是这类事件，熔断此刻已是失效状态。" : "若被改名的是这类事件，熔断会少计，下面的 round_count 偏小。daemon 没有自报次数，无法当场判定。") + "墙钟超时仍是有效的兜底（且触发时会向 daemon 发 /chat/stop）；也可调小 max_rounds 或人工盯防本轮]", "");
					}
					const meta = [];
					meta.push(`session_id=${value.session_id}`);
					meta.push(`tokens=${value.tokens}`);
					if (value.round_count != null && value.round_count > 0) meta.push(`rounds=${value.round_count}`);
					meta.push(`tool_calls=${value.tool_calls}`);
					if (typeof value.daemon_tool_calls === "number") meta.push(`daemon_tool_calls=${value.daemon_tool_calls}`);
					meta.push(`stop_reason=${value.stop_reason}`);
					meta.push(`working_dir=${value.working_dir === null || value.working_dir === void 0 ? "未指定（daemon 自己的 cwd）" : value.working_dir}`);
					meta.push(`provider=${value.provider}`);
					lines.push(`[${meta.join(" ")}]`);
				} else lines.push(`AtomCode 调用失败: ${value.error}`);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args, exec) {
			const t0 = Date.now();
			const askProvider = resolveProvider("ask", args.provider).name;
			const empty = (error) => ({
				ok: false,
				reply: "",
				session_id: "",
				continued: false,
				truncated: false,
				tokens: 0,
				tool_calls: 0,
				round_count: 0,
				tools: [],
				tools_truncated: false,
				stop_reason: "",
				working_dir: workDir || null,
				provider: askProvider || "default",
				providerReported: false,
				protocol_unknown_types: [],
				daemon_tool_calls: null,
				daemon_rounds: null,
				error
			});
			const workDir = typeof args.working_dir === "string" && args.working_dir.trim() !== "" ? args.working_dir : hostSessionCwd(exec) ?? defaultWorkingDir;
			if (!workDir && args.allow_unattended !== true) {
				stats.ask.calls += 1;
				stats.ask.err += 1;
				stats.ask.msTotal += Date.now() - t0;
				return empty("atomcode_ask 拒绝了本回合：取不到 working_dir，而 daemon 无人值守自动放行（[headless] auto-approved——对任何 approval_mode 都成立），AtomCode 的工具会跑在它自己的 cwd（通常是用户 home）里——这正是 atomcode_review 一直直接拒绝的那个情况（红线 8）。三种走法：① 传 working_dir 指定本回合的目录；② 在插件配置 working_dir 里设一个默认目录；③ 本回合确实只做通用问答、不涉及任何目录时，显式传 allow_unattended=true 表示知情同意。");
			}
			const sessionKey = workDir ? resolve(workDir) : "default";
			let sessionId = typeof args.session_id === "string" && args.session_id.trim() !== "" ? args.session_id.trim() : args.continue === true ? sessions.get(sessionKey) : void 0;
			if (args.reset_session === true) {
				const pinned = typeof args.session_id === "string" && args.session_id.trim() !== "" ? args.session_id.trim() : void 0;
				sessions.drop(sessionKey);
				if (pinned) sessions.set(sessionKey, pinned);
				else if (args.continue === true) sessionId = void 0;
			}
			const continued = sessionId !== void 0;
			stats.ask.calls += 1;
			if (!await ensureDaemon(exec?.signal)) {
				stats.ask.err += 1;
				stats.ask.msTotal += Date.now() - t0;
				return empty(exec?.signal?.aborted ? "已取消：调用方在等待 AtomCode daemon 就绪期间中止了本次调用" : `AtomCode daemon 不可用（http://127.0.0.1:${port}：${describeDaemonDown(stats.daemonDownReason)}${autoStart ? "，自动拉起也失败" : ""}）`);
			}
			const timeoutMs = Number.isFinite(args.timeout_secs) && args.timeout_secs > 0 ? Math.min(HOST_TOOL_TIMEOUT_SECS, Math.floor(args.timeout_secs)) * 1e3 : HOST_TOOL_TIMEOUT_MS;
			const maxRounds = resolveMaxRounds(args.max_rounds, askMaxRounds);
			const live = {
				startedAt: Date.now(),
				workingDir: workDir || null,
				provider: askProvider || "default",
				rounds: 0,
				completed: 0,
				chars: 0,
				sessionId: "",
				lastTool: "",
				tokens: 0
			};
			stats.ask.inFlight = live;
			let result;
			try {
				result = await askChat({
					message: String(args.message || ""),
					port,
					approvalMode,
					timeoutMs,
					maxRounds,
					...sessionId ? { sessionId } : {},
					...askProvider ? { provider: askProvider } : {},
					...workDir ? { workingDir: workDir } : {},
					...exec?.signal ? { signal: exec.signal } : {},
					onProgress: (progress) => Object.assign(live, progress)
				});
			} finally {
				if (stats.ask.inFlight === live) stats.ask.inFlight = null;
			}
			stats.ask.msTotal += Date.now() - t0;
			if (result.ok) {
				stats.ask.ok += 1;
				if (Number.isFinite(result.tokens)) stats.ask.tokens += result.tokens;
			} else stats.ask.err += 1;
			for (const unknownType of result.unknownTypes) if (!stats.protocolUnknownTypes.includes(unknownType)) stats.protocolUnknownTypes.push(unknownType);
			if (result.ok && result.sessionId) sessions.set(sessionKey, result.sessionId);
			const capped = capProse(result.reply, OUTPUT_CAP, { remedy: "ask AtomCode to write the full text to a file and read that instead" });
			const reply = capped.text;
			const truncated = capped.cut;
			const resumeHint = "本次接续的是本工作目录记录的侧边会话；若该会话已失效（daemon 重启或空闲退出后常见），可用 reset_session=true 清掉它再开一条新线";
			const reportedError = !result.ok && continued ? result.error ? `${result.error}（${resumeHint}）` : resumeHint : result.error;
			return {
				ok: result.ok,
				reply,
				session_id: result.sessionId,
				continued,
				truncated,
				tokens: result.tokens,
				tool_calls: result.toolCalls,
				round_count: result.roundCount ?? 0,
				tools: result.tools,
				tools_truncated: result.toolsTruncated === true,
				stop_reason: result.stopReason,
				working_dir: workDir || null,
				provider: result.provider,
				providerReported: result.providerReported,
				protocol_unknown_types: result.unknownTypes,
				daemon_tool_calls: result.daemonToolCalls,
				daemon_rounds: result.daemonRounds,
				error: reportedError
			};
		}
	});
}
/**
* `atomcode_review` — one-shot code review through the CLI subcommand.
*
* Same reason as mountAskTool() for building the description here: the note
* about which provider will be used has to sit next to the `register()` that
* ships it, so the two cannot describe different ladders.
*
* @returns {() => void} the tool’s disposer.
*/
function mountReviewTool({ tools, config, runtime, log }) {
	const { binary, reviewDefaultProvider, reviewWorkingDir, reviewNoWeb, reviewMaxRounds, reviewMaxDurationSecs } = config;
	const { stats, resolveProvider, reviewProvision } = runtime;
	const reviewBaseDesc = "让本机 AtomCode（官方二进制）对一次代码变更做 one-shot 代码评审：默认评未提交改动；也可给 base 分支 / GitHub PR / diff 文本 / 自定义任务。有界的一次性 agent 运行（轮数 + 墙钟双保险丝，默认关 web 搜索），完成时 report 里是 CLI 的 --json 原始文本（findings JSON，可能夹带日志行），需自己读出结论并转达用户。通路定位：这是\"经标准 OpenAI 兼容端点的有界一次性评审\"——CLI 不做 AtomCode 专有签名，AtomGit 原生网关对推理端点验签，CLI 够不着；若本机没有可用的标准直连条目（含本地 sidecar），Atom 原生登录用户的评审改走 atomcode_ask 的原生 code_review（签名 daemon 通路、滚动窗口额度）。注意 working_dir 缺省优先级：调用参数 > 宿主会话 cwd（宿主尚未暴露该字段，暴露后自动填入）> 插件配置 review_working_dir；都没有则直接拒绝（绝不回落宿主进程 cwd）——评某个仓库请显式传 working_dir。可能数分钟。";
	const reviewUsableProviders = reviewProvision.providers || [];
	const reviewProviderNote = reviewUsableProviders.length === 0 ? "" : `（本机可用的直连 provider：${reviewUsableProviders.join(" / ")}；provider 留空时按顺序取：详情页面板选的条目 → 插件配置 review_default_provider（当前${reviewDefaultProvider ? `="${reviewDefaultProvider}"` : "未配"}） → config.toml 的 default_provider → 唯一的可用直连条目自动顶上；只有前面几档都没配上、而本机又存在多个可用直连条目时才会要求你点名，不会替你猜计费通道）`;
	const reviewDesc = reviewProvision.available ? reviewBaseDesc + reviewProviderNote : `注意：本机 AtomCode 配置下 review CLI 不可用（${reviewProvision.reason}），只能走 daemon 侧的 atomcode_ask 做侧边咨询或让 AtomCode 评审。让本机 AtomCode（官方二进制）对一次代码变更做 one-shot 代码评审：默认评未提交改动；也可给 base 分支 / GitHub PR / diff 文本 / 自定义任务。有界的一次性 agent 运行（轮数 + 墙钟双保险丝，默认关 web 搜索），完成时 report 里是 CLI 的 --json 原始文本（findings JSON，可能夹带日志行），需自己读出结论并转达用户。通路定位：这是"经标准 OpenAI 兼容端点的有界一次性评审"——CLI 不做 AtomCode 专有签名，AtomGit 原生网关对推理端点验签，CLI 够不着；若本机没有可用的标准直连条目（含本地 sidecar），Atom 原生登录用户的评审改走 atomcode_ask 的原生 code_review（签名 daemon 通路、滚动窗口额度）。注意 working_dir 缺省优先级：调用参数 > 宿主会话 cwd（宿主尚未暴露该字段，暴露后自动填入）> 插件配置 review_working_dir；都没有则直接拒绝（绝不回落宿主进程 cwd）——评某个仓库请显式传 working_dir。可能数分钟。`;
	return tools.register({
		name: "atomcode_review",
		timeoutMs: HOST_TOOL_TIMEOUT_MS,
		description: reviewDesc,
		parameters: {
			type: "object",
			properties: {
				working_dir: {
					type: "string",
					description: "仓库根目录（--repo）。缺省优先级：调用参数 > 宿主会话 cwd（宿主尚未暴露该字段，暴露后自动填入）> 插件配置 review_working_dir；都没有则报错（绝不回落宿主进程 cwd）而不是悄悄评错仓库"
				},
				task: {
					type: "string",
					description: "可选：自定义任务文本，替代 diff 评审（问题/目标代码/上下文都写进来）"
				},
				base: {
					type: "string",
					description: "可选：base git ref，评审 <base>...HEAD；缺省评未提交改动"
				},
				staged: {
					type: "boolean",
					description: "可选：只评已暂存改动（git diff --staged）"
				},
				pr: {
					type: "number",
					description: "可选：GitHub PR 号（需本机 gh CLI）"
				},
				diff_text: {
					type: "string",
					description: "可选：原始 diff 文本（写临时文件走 --diff-file；适合非 git 场景/CI 产物）"
				},
				provider: {
					type: "string",
					description: "可选：点名 AtomCode provider，原样透传给 review CLI 的 --provider。名字以 ~/.atomcode/config.toml 的 [providers.<name>] 条目为准（这条路径不看 daemon /models，也不是裸模型 id——别传 \"glm5.3-flash\"）；要换该 provider 用的模型，改它条目里的 model。留空时按顺序取：面板上选的条目 → 插件配置 review_default_provider → config.toml 的 default_provider → 自动选择（见工具描述）"
				},
				max_rounds: {
					type: "number",
					description: "可选：评审 agent 轮数熔断（默认取插件配置，通常 " + reviewMaxRounds + "；上限 1000，超过按 1000 计。传 0 关掉轮数熔断，交回 CLI 自己治理——与 atomcode_ask 的 max_rounds: 0 同义；墙钟熔断 max_duration_secs 仍然生效）"
				},
				max_duration_secs: {
					type: "number",
					description: "可选：墙钟保险丝秒数（默认取插件配置，通常 900）。上限 1740s，超过按 1740s 计——进程级兜底取 maxDuration+60s，再大就越过宿主 30min 工具超时，保险丝会失效而不是变长"
				},
				enable_web: {
					type: "boolean",
					description: "可选：允许评审用 web_search（默认 false，适配受限网络）"
				}
			},
			required: []
		},
		output: {
			schema: hostSubsetSchema({
				type: "object",
				properties: {
					ok: { type: "boolean" },
					report: {
						type: "string",
						description: "CLI --json 的原始 stdout（可能夹带日志行）。findings 是它的结构化读数；两者同在，原始文本不因解析成功而被丢掉"
					},
					truncated: {
						type: "boolean",
						description: "report 超过上限被截断（findings 原文不完整，必要时改用 task 缩小范围）"
					},
					findings_parsed: {
						type: "boolean",
						description: "report 是否被解析成了结构化 findings。false = 没能解析（原始文本仍在 report 里，需自己读结论），此时 findings_count=0 表示\"没有解析出结论\"，**不是\"没有问题\"**"
					},
					findings_count: {
						type: "number",
						description: "文档里的 finding 条数（findings 数组被截断时它仍是真实总数）"
					},
					findings: {
						type: "array",
						description: `结构化 findings，最多 ${200} 条（真实总数见 findings_count）。severity/file/line 为 null = 该条目没带这个字段（未知），不是"无"；转达时不要把它写成"无严重程度"`,
						items: {
							type: "object",
							properties: {
								severity: { type: ["string", "null"] },
								file: { type: ["string", "null"] },
								line: { type: ["string", "null"] },
								message: { type: "string" }
							},
							required: [
								"severity",
								"file",
								"line",
								"message"
							],
							additionalProperties: false
						}
					},
					error: { type: "string" },
					exit_code: {
						type: "number",
						description: "进程退出码；-1 = 未能启动，或被信号终止（超时/取消）。两种含义共用 -1（被信号杀时真实 code 为 null），具体原因看 error"
					},
					duration_ms: { type: "number" }
				},
				required: [
					"ok",
					"report",
					"truncated",
					"findings_parsed",
					"findings_count",
					"findings",
					"error",
					"exit_code",
					"duration_ms"
				],
				additionalProperties: false
			}),
			render(_args, value) {
				const lines = [];
				if (value.ok) {
					const findings = Array.isArray(value.findings) ? value.findings : [];
					lines.push(`AtomCode 评审完成（${Math.round(value.duration_ms / 1e3)}s${value.findings_parsed ? `，${value.findings_count} 条 findings` : "，findings 未能解析"}）:`);
					if (value.findings_parsed && findings.length > 0) {
						for (const finding of findings) {
							const where = [finding.file, finding.line].filter((part) => part !== null && part !== "").join(":");
							lines.push(`- ${finding.severity ? `[${finding.severity}] ` : ""}${where ? `${where} — ` : ""}${finding.message}`);
						}
						if (findings.length < value.findings_count) lines.push(`[注意：只列出了前 ${findings.length} 条，共 ${value.findings_count} 条——完整清单见下面的 report 原文]`);
					} else if (value.findings_parsed) lines.push("（findings 文档里没有条目）");
					else lines.push("[注意：--json 原文没能解析成 findings 文档，下面的 report 是原始文本，需自己从中读结论——findings_count=0 是\"没解析出\"，不等于\"没有问题\"]");
					const digestChars = lines.join("\n").length;
					const rawBudget = Math.max(REVIEW_REPORT_FLOOR, OUTPUT_CAP - digestChars);
					const raw = capProse(value.report || "(空 findings)", rawBudget, { remedy: "re-run with a task that writes the full report to a file, or read the digest above" });
					lines.push("--- report 原文 ---", raw.text);
					const shortfalls = [];
					if (value.truncated) shortfalls.push("findings 原文早已被字段上限截断，末尾不完整");
					if (raw.cut) shortfalls.push(`report 原文又按本回合预算收到 ${rawBudget} 字（上面的 findings 清单已占用 ${digestChars} 字）`);
					if (shortfalls.length) lines.push(`[注意：${shortfalls.join("；")}]`);
				} else {
					lines.push(`AtomCode 评审失败: ${value.error}`);
					if (value.report) lines.push("--- 部分输出 ---", value.report.slice(0, 5e3));
				}
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args, exec) {
			const t0 = Date.now();
			const refuse = (error) => {
				stats.review.calls += 1;
				stats.review.err += 1;
				stats.review.msTotal += Date.now() - t0;
				return {
					ok: false,
					report: "",
					truncated: false,
					findings_parsed: false,
					findings_count: 0,
					findings: [],
					error,
					exit_code: -1,
					duration_ms: Date.now() - t0
				};
			};
			const workDir = typeof args.working_dir === "string" && args.working_dir.trim() !== "" ? args.working_dir : hostSessionCwd(exec) ?? reviewWorkingDir;
			if (!workDir) return refuse("atomcode_review needs a repository: pass working_dir (<repo root>), or set the plugin config `review_working_dir`. Falling back to the host process cwd would review the wrong tree (or nothing) while reporting success.");
			const currentProvision = checkReviewProvision();
			if (!currentProvision.available) return refuse(`atomcode_review is unavailable on this host: ${currentProvision.reason} Use atomcode_ask instead (the daemon carries the AtomGit gateway signing). If this looks wrong, fix ~/.atomcode/config.toml and retry — this check re-reads it on every call.`);
			const selection = selectReviewProvider(resolveProvider("review", args.provider).name);
			if (selection.error) return refuse(`atomcode_review: ${selection.error}`);
			if (selection.auto) log(`review provider auto-selected: ${selection.provider} — ${selection.reason}`);
			if (selection.baseUrl && isLoopbackBaseUrl(selection.baseUrl)) {
				const probe = await probeLocalEndpoint(selection.baseUrl);
				if (!probe.alive) return refuse(`atomcode_review: local provider endpoint ${selection.baseUrl} (provider "${selection.provider}") is not responding (${probe.detail}; tried ${probe.tried.join(", ") || "no URL"}). ${PROVIDER_FIX} Daemon-side atomcode_ask is unaffected (it does not go through this endpoint).`);
			}
			const maxRounds = resolveMaxRounds(args.max_rounds, reviewMaxRounds);
			const maxDurationSecs = resolveDurationSecs(args.max_duration_secs, reviewMaxDurationSecs, MAX_REVIEW_DURATION_SECS);
			stats.review.calls += 1;
			const result = await runReview({
				workingDir: workDir,
				...typeof args.task === "string" && args.task.trim() !== "" ? { task: args.task } : {},
				...typeof args.base === "string" && args.base.trim() !== "" ? { base: args.base } : {},
				...args.staged === true ? { staged: true } : {},
				...Number.isFinite(args.pr) && args.pr > 0 ? { pr: args.pr } : {},
				...typeof args.diff_text === "string" && args.diff_text.trim() !== "" ? { diffText: args.diff_text } : {},
				...selection.provider ? { provider: selection.provider } : {},
				maxRounds,
				maxDurationSecs,
				timeoutMs: (maxDurationSecs + 60) * 1e3,
				noWeb: args.enable_web === true ? false : reviewNoWeb,
				...binary ? { binary } : {},
				...exec?.signal ? { signal: exec.signal } : {},
				log
			});
			stats.review.msTotal += Date.now() - t0;
			if (result.ok) stats.review.ok += 1;
			else stats.review.err += 1;
			const capped = capProse(result.report, OUTPUT_CAP, { remedy: "re-run with a task that writes the full report to a file, or read the digest above" });
			const parsed = result.findings || {
				parsed: false,
				count: 0,
				findings: []
			};
			return {
				ok: result.ok,
				report: capped.text,
				truncated: capped.cut,
				findings_parsed: parsed.parsed === true,
				findings_count: typeof parsed.count === "number" ? parsed.count : 0,
				findings: Array.isArray(parsed.findings) ? parsed.findings : [],
				error: result.error,
				exit_code: result.exitCode ?? -1,
				duration_ms: result.durationMs
			};
		}
	});
}

//#endregion
export { mountAskTool, mountReviewTool };