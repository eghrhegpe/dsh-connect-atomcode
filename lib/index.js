import { readConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { mountRoutes } from "./routes.js";
import { mountAskTool } from "./tools.js";
import { mountReviewCommand } from "./command.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

//#region src/host/index.ts
/**
* `dsh-connect-atomcode` host entry point.
*
* apply()-split: this file used to be a 1,879-line God module holding every
* host-side concern — config parsing, the stats snapshot, the runtime, both
* routes, both tools — in one scope. It is now the assembly point only, and the
* work has moved to purpose-named modules:
*
*   - `./config.ts`    readConfig() + the shared tuning constants
*   - `./runtime.ts`   createRuntime() — the stats bag + daemon lifecycle + quota
*   - `./stats.ts`     writeJson/sameOrigin/describeDaemonDown/createStatsBag/buildStatsBody
*   - `./routes.ts`    mountRoutes() — the HTTP routes, disposed as one unit
*   - `./tools.ts`     runAsk() + mountAskTool()
*   - `./command.ts`   mountReviewCommand() — the `/atomcode-review` slash command
*   - `./inject.ts`    injectReviewContinuation() — hands a finished review to the
*                      session's model as "continue your task" (the ONE named
*                      steer/inject 红线 3 allows)
*
* The split was done so a reader can find a concern by its file name instead of
* reading 1,900 lines; the discipline (red lines 1–8, the two provider
* namespaces, config never trusts input, observable degradation over silent
* failure) is unchanged and is asserted by the same test suite.
*
* @module dsh-connect-atomcode
*/
/**
* The plugin version — read from package.json at load, so there is exactly ONE
* hand-edited place instead of two. (The old form held a version literal here
* AND in package.json, and `test/wiring.test.mjs` pinned the pair together: a
* pair is not a source of truth, it is one typo away from drifting, and a test
* can only catch the drift after it has happened. The manifest names the
* release tag `git tag v<version>` and the npm publish, so the literal had to
* be checked — now it cannot disagree.)
*
* It is handed to the runtime as `stats.pluginVersion`, and the stats body
* reports it to the client. Resolved from `lib/` so the same read works in the
* checked-out repo and in an installed copy.
*/
const packageDir = dirname(fileURLToPath(import.meta.url));
const PLUGIN = { version: JSON.parse(readFileSync(join(packageDir, "..", "package.json"), "utf8")).version };
const name = "atomcode-bridge";
const inject = ["tools", "webServer"];
function apply(ctx, rawConfig = {}) {
	const config = readConfig(rawConfig);
	const log = (message) => ctx.logger?.warn(`[atomcode-bridge] ${message}`);
	if (config.sessionKeyPrefixSource === "none") log("无法判定 DSH profile（DSH_PROFILE 未设置，argv 里也没有 dsh 的 web/desktop 子命令）：sessions.json 将不带 profile 前缀。若本机同时跑 web 与 desktop，两侧的会话续接会共用同一个键、互相串线——在插件配置里设 session_key_prefix 可消除歧义。");
	const runtime = createRuntime({
		config,
		log,
		pluginVersion: PLUGIN.version
	});
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	const disposeAsk = mountAskTool({
		tools,
		config,
		runtime
	});
	const webServer = ctx.get ? ctx.get("webServer") : ctx.webServer;
	const disposeRoutes = mountRoutes({
		webServer,
		runtime,
		log
	});
	const commands = ctx.get ? ctx.get("commands") : ctx.commands;
	const disposeCommand = mountReviewCommand({
		commands,
		config,
		runtime,
		log
	});
	ctx.effect(() => {
		return () => {
			disposeAsk();
			disposeRoutes();
			disposeCommand();
			runtime.dispose();
		};
	});
}

//#endregion
export { apply, inject, name };