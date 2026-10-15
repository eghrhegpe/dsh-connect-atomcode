import { defaultBinary } from "./daemon.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

//#region src/host/review.ts
/**
* review.ts — one-shot `atomcode review` CLI wrapper.
*
* The review subcommand is a no-session, no-screen one-shot: it takes a git
* range / PR / diff (or a custom `--task` text), runs the reviewer agent
* with bounded rounds/duration, and emits structured findings (`--json`).
* It reads the same `~/.atomcode/config.toml` auth as the daemon (official
* binary carries the gateway signature).
*
* IMPORTANT (v0.3 known limitation): the review CLI resolves providers from
* **direct** `[providers.<name>]` entries with a plain `base_url` + optional
* `api_key`. An account-resolved default_provider (AtomGit gateway style) is
* NOT accepted by the CLI unless a `[providers.<name>]` wrapper with its own
* `base_url` also exists. Even with a valid gateway `base_url`, the CLI
* runtime (`atomcodex`) may refuse the AtomGit gateway signing mechanism.
* Daemon-side (`atomcode_ask`) is unaffected — it uses the same binary's
* embedded signing.
*
* `checkReviewProvision()` inspects the local config at import time and
* reports whether the review CLI can be expected to work. The caller (index.js)
* reads this at mount and degrades the tool description when unavailable.
*
* `runReview` is deliberately built with a spawn seam so the argument
* construction, temp-diff handling, JSON parsing and failure mapping can be
* unit-tested without a binary (test/review.test.mjs); the live path is
* covered by test/review-live.test.mjs.
*
* @module dsh-atomcode-bridge/review
*/
/** @type {(bin:string, args:string[], opts:object) => import('node:child_process').ChildProcess} */
let spawnOverride = null;
/**
* Test seam: replace the spawner (unit tests). Pass `null` to restore.
* @param {(bin:string, args:string[], opts:object) => import('node:child_process').ChildProcess} [spawner]
*/
function setSpawnOverride(spawner) {
	spawnOverride = spawner || null;
}
/**
* Resolve the AtomCode binary: explicit value > $ATOMCODE_BIN > platform
* default (atomcode.exe on Windows, atomcode elsewhere). The platform default
* is reused from `daemon.ts` so the two host modules cannot drift apart.
* @param {string} [configBinary]
* @returns {string}
*/
function resolveBinary(configBinary) {
	if (typeof configBinary === "string" && configBinary.trim() !== "") return configBinary.trim();
	if (process.env.ATOMCODE_BIN && process.env.ATOMCODE_BIN.trim() !== "") return process.env.ATOMCODE_BIN.trim();
	return defaultBinary();
}
/**
* Build the argv for one review invocation (the testable core).
*
* @param {object} opts
* @param {string} [opts.workingDir] - repository root (`--repo` / cwd)
* @param {string} [opts.task] - custom task text (skips diff computation)
* @param {string} [opts.base] - base git ref (reviews `<base>...HEAD`)
* @param {boolean} [opts.staged] - staged-changes only
* @param {number} [opts.pr] - GitHub PR number (needs the `gh` CLI)
* @param {string} [opts.diffText] - raw diff, written to a temp file
* @param {string} [opts.provider] - AtomCode provider/model override
* @param {number} [opts.maxRounds] - round fuse (default 35)
* @param {number} [opts.maxDurationSecs] - wall-clock fuse (default 900)
* @param {boolean} [opts.noWeb] - disable web_search (default true: this host's network is proxy-gated)
* @returns {{argv:string[], tempFiles:string[]}} the CLI argv plus any temp files to clean up.
*/
function buildReviewArgs(opts = {}) {
	const argv = ["review"];
	const tempFiles = [];
	if (typeof opts.task === "string" && opts.task.trim() !== "") argv.push("--task", opts.task);
	else if (typeof opts.diffText === "string" && opts.diffText.trim() !== "") {
		const dir = mkdtempSync(join(tmpdir(), "atomcode-diff-"));
		try {
			const file = join(dir, "review.diff");
			writeFileSync(file, opts.diffText, "utf8");
			tempFiles.push(dir);
			argv.push("--diff-file", file);
		} catch (error) {
			try {
				rmSync(dir, {
					recursive: true,
					force: true
				});
			} catch {}
			throw error;
		}
	} else if (Number.isFinite(opts.pr) && opts.pr > 0) argv.push("--pr", String(Math.floor(opts.pr)));
	else if (opts.staged === true) argv.push("--staged");
	else if (typeof opts.base === "string" && opts.base.trim() !== "") argv.push("--base", opts.base.trim());
	if (typeof opts.workingDir === "string" && opts.workingDir.trim() !== "") argv.push("--repo", opts.workingDir.trim());
	if (typeof opts.provider === "string" && opts.provider.trim() !== "") argv.push("--provider", opts.provider.trim());
	const maxRounds = Number.isFinite(opts.maxRounds) && opts.maxRounds > 0 ? Math.floor(opts.maxRounds) : 35;
	const maxDurationSecs = Number.isFinite(opts.maxDurationSecs) && opts.maxDurationSecs > 0 ? Math.floor(opts.maxDurationSecs) : 900;
	argv.push("--json", "--no-telemetry");
	argv.push("--max-rounds", String(maxRounds));
	argv.push("--max-duration", String(maxDurationSecs));
	if (opts.noWeb !== false) argv.push("--no-web");
	return {
		argv,
		tempFiles
	};
}
/** Remove temp diff dirs created by `buildReviewArgs`. */
function cleanupTempFiles(tempFiles = []) {
	for (const dir of tempFiles) try {
		rmSync(dir, {
			recursive: true,
			force: true
		});
	} catch {}
}
/**
* Unquote one raw TOML value and strip an inline comment.
*
* The kv regex grabs everything to end-of-line, so a real-world line like
* `base_url = "http://127.0.0.1:8899/v1"  # 本地代理` used to parse as
* `http://127.0.0.1:8899/v1"  # 本地代理` — quote and comment included. That
* corrupted value feeds THIS plugin's own decisions (loopback detection,
* gateway filtering); the review CLI parses config.toml itself, so the two
* parsers can diverge silently. TOML comments start at '#' OUTSIDE a quoted
* string, so: quoted values end at their closing quote; bare values end at
* the first '#'.
*
* @param {string} raw
* @returns {string}
*/
function unquoteTomlValue(raw) {
	const v = (raw ?? "").trim();
	if (v.startsWith("\"")) {
		const end = v.indexOf("\"", 1);
		return end === -1 ? v : v.slice(1, end);
	}
	if (v.startsWith("'")) {
		const end = v.indexOf("'", 1);
		return end === -1 ? v : v.slice(1, end);
	}
	const hash = v.indexOf("#");
	return (hash === -1 ? v : v.slice(0, hash)).trim();
}
/**
* Minimal TOML section parser: collect `[providers.<name>]` entries and their
* keys from a config.toml string. Pure and exported so the quoted-name edge
* cases can be unit-tested directly.
*
* Handles bare sections (`[providers.direct]`) and quoted provider names
* (`[providers."my provider"]` — a legal TOML key); the fully-quoted form
* `["providers.x"]` is a single literal key, NOT a providers section, and is
* deliberately ignored (its raw text starts with `"`, not `providers.`).
* Values are unquoted on read (see `unquoteTomlValue`); keys may be bare,
* dashed, or quoted (`"base_url" = "x"`).
*
* @param {string} raw
* @returns {Array<{name:string, [key:string]:string}>}
*/
function parseTomlProviders(raw) {
	const lines = String(raw || "").split(/\r?\n/);
	const providers = [];
	let currentSection = null;
	const currentEntries = {};
	const pushSection = () => {
		if (currentSection && currentSection.startsWith("providers.") && Object.keys(currentEntries).length > 0) providers.push({
			name: currentSection.replace(/^providers\./, "").replace(/^["']|["']$/g, ""),
			...currentEntries
		});
	};
	for (const lineRaw of lines) {
		const line = lineRaw.trim();
		if (line.startsWith("#") || line === "") continue;
		const sectionMatch = line.match(/^\[([^\]]+)\]$/);
		if (sectionMatch) {
			pushSection();
			currentSection = sectionMatch[1] ?? null;
			Object.keys(currentEntries).forEach((k) => delete currentEntries[k]);
			continue;
		}
		const kvMatch = line.match(/^("?[a-zA-Z_][a-zA-Z0-9_-]*"?)\s*=\s*(.+)$/);
		if (kvMatch && currentSection) currentEntries[(kvMatch[1] ?? "").replace(/^["']|["']$/g, "")] = unquoteTomlValue(kvMatch[2] ?? "");
	}
	pushSection();
	return providers;
}
/**
* Check whether the local AtomCode config has a direct `[providers.<name>]`
* entry with `base_url` that the review CLI can actually resolve (not an
* AtomGit signing-enforced gateway). Daemon-side ask is unaffected.
*
* This is a static (no-subprocess) advisory probe: it reads config.toml and
* reports what the CLI is likely able to use. It can produce a false positive
* (e.g. a dead upstream host) but never a false negative for the two failure
* shapes we have measured: "missing base URL" (no direct provider at all) and
* the AtomGit gateway signing gate.
*
* The probe is cheap (one small file read, no subprocess) and is refreshed per
* tool call and per stats poll, so a config edit after mount is picked up —
* the tool description is not the only place the truth is told.
*
* @param {string} [configDir] - override ~/.atomcode for tests.
* @returns {{ available: boolean, reason: string, providers: string[] }}
*   `providers` lists the direct provider names the CLI should be able to use.
*/
function checkReviewProvision(configDir) {
	const atomcodeHome = configDir || join(homedir(), ".atomcode");
	const configFile = join(atomcodeHome, "config.toml");
	if (!existsSync(configFile)) return {
		available: false,
		reason: "config.toml not found",
		providers: []
	};
	let raw;
	try {
		raw = readFileSync(configFile, "utf8");
	} catch {
		return {
			available: false,
			reason: "unreadable config.toml",
			providers: []
		};
	}
	const providers = parseTomlProviders(raw);
	const usable = listUsableProviders(raw).map((p) => p.name);
	if (usable.length > 0) return {
		available: true,
		reason: "",
		providers: usable
	};
	const gatewayOnly = providers.filter((p) => p.base_url && /llm-api\.atomgit\.com/i.test(p.base_url));
	if (gatewayOnly.length > 0) return {
		available: false,
		reason: `only the AtomGit gateway is configured (${gatewayOnly.map((p) => p.name).join(", ")}): llm-api.atomgit.com enforces AtomCode's proprietary request signature on the inference endpoint, and the review CLI (atomcodex) does not implement it — AtomCode's own error: "signing-enforced gateway … cannot authenticate" (an unsigned call gets ATOMCODE_SIG_MISSING). Fix: add a direct [providers.<name>] with a STANDARD base_url + api_key. atomcode_ask is unaffected (the daemon carries the signing).`,
		providers: []
	};
	const defaultProviderMatch = raw.match(/^default_provider\s*=\s*"([^"]+)"/m);
	const defaultProvider = defaultProviderMatch ? defaultProviderMatch[1] : "";
	if (providers.filter((p) => !p.base_url && (p.account || p.model)).length > 0 || defaultProvider) return {
		available: false,
		reason: "no direct [providers.<name>] entry with a non-gateway base_url" + (defaultProvider ? ` (default_provider is "${defaultProvider}")` : "") + ": that is an AtomGit login/account channel with no api_key, and llm-api.atomgit.com requires AtomCode's proprietary request signature (unsigned calls get ATOMCODE_SIG_MISSING) which the review CLI does not implement. Fix: add a direct [providers.<name>] with a STANDARD base_url + api_key (OpenRouter / OpenAI / a local server). atomcode_ask is unaffected — the daemon carries the signing.",
		providers: []
	};
	return {
		available: false,
		reason: "no direct [providers.<name>] entry with base_url and api_key found; the review CLI resolves providers from direct entries only (the daemon and the TUI also accept account-resolved ones). atomcode_ask is unaffected.",
		providers: []
	};
}
/**
* Collect the **usable** direct providers from a config.toml string: entries
* with a plain non-AtomGit `base_url` plus something to run with (`api_key` or
* `model`). Pure and exported because both the static provision probe and the
* execute-time provider selection must agree on this exact definition — a
* split definition is how "the probe said yes but the call failed" bugs happen.
*
* @param {string} raw - config.toml contents
* @returns {Array<{name:string, baseUrl:string}>}
*/
function listUsableProviders(raw) {
	const usable = [];
	for (const p of parseTomlProviders(raw)) {
		if (!p.base_url) continue;
		if (/llm-api\.atomgit\.com/i.test(p.base_url)) continue;
		if (p.api_key || p.model) usable.push({
			name: p.name,
			baseUrl: p.base_url
		});
	}
	return usable;
}
/**
* Decide which direct provider one review call should run with, and what
* base_url it points at (so the caller can health-check a loopback endpoint).
*
* The review CLI's own default is `default_provider`, which on an AtomGit
* login host is an **account-resolved** entry with no `base_url` — the CLI
* then dies with "missing base URL" even though a perfectly usable direct
* provider exists. When that happens and exactly ONE usable direct entry is
* present, we select it explicitly (auto) instead of letting the CLI stumble.
* Ambiguity (several candidates, no usable default) is an error, not a guess.
*
* @param {string} [requested] - the caller's explicit `provider` argument
* @param {string} [configDir] - override ~/.atomcode for tests
* @returns {{provider:string|null, baseUrl:string, auto:boolean, error:string}}
*   `provider` is what should be passed as `--provider` (null = none needed);
*   `error` non-empty means the call must be refused with that message.
*/
function selectReviewProvider(requested, configDir) {
	const atomcodeHome = configDir || join(homedir(), ".atomcode");
	let raw = "";
	try {
		raw = readFileSync(join(atomcodeHome, "config.toml"), "utf8");
	} catch {
		return {
			provider: requested || null,
			baseUrl: "",
			auto: false,
			error: ""
		};
	}
	const usable = listUsableProviders(raw);
	if (typeof requested === "string" && requested.trim() !== "") {
		const name = requested.trim();
		const hit = usable.find((p) => p.name === name);
		return {
			provider: name,
			baseUrl: hit ? hit.baseUrl : "",
			auto: false,
			error: ""
		};
	}
	const defaultMatch = raw.match(/^default_provider\s*=\s*"([^"]+)"/m);
	const defaultProvider = defaultMatch ? defaultMatch[1] ?? "" : "";
	const defaultHit = usable.find((p) => p.name === defaultProvider);
	if (defaultHit) return {
		provider: defaultProvider,
		baseUrl: defaultHit.baseUrl,
		auto: false,
		error: ""
	};
	if (usable.length === 1) return {
		provider: usable[0].name,
		baseUrl: usable[0].baseUrl,
		auto: true,
		error: "",
		reason: `default_provider "${defaultProvider || "(unset)"}" is not a usable direct entry; selected the only usable direct provider`
	};
	if (usable.length > 1) return {
		provider: null,
		baseUrl: "",
		auto: false,
		error: `no provider argument and default_provider "${defaultProvider || "(unset)"}" is not a usable direct entry, while several direct providers exist (${usable.map((p) => p.name).join(", ")}): pass the \`provider\` tool argument to say which one — guessing could bill the review against the wrong channel.`
	};
	return {
		provider: null,
		baseUrl: "",
		auto: false,
		error: "no usable direct provider in config.toml"
	};
}
/**
* Is this base_url a loopback/localhost endpoint (i.e. a local sidecar like
* the atomcode-open-api proxy, which is a live process dependency)?
* @param {string} baseUrl
* @returns {boolean} false for anything unparseable — never probe blindly.
*/
function isLoopbackBaseUrl(baseUrl) {
	try {
		const { hostname } = new URL(baseUrl);
		return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127\./.test(hostname);
	} catch {
		return false;
	}
}
/**
* Probe a local OpenAI-compatible endpoint: ANY HTTP response (even 401/404)
* proves a server is listening; only transport failure on every candidate URL
* means "dead". Scoped to loopback by the caller — remote egress on this host
* is proxy-gated, and a remote probe could fail where the CLI's own request
* would have succeeded (a false refusal is worse than the CLI's own error).
*
* @param {string} baseUrl - the provider's base_url (e.g. http://127.0.0.1:8899/v1)
* @param {{timeoutMs?:number, fetchImpl?:typeof fetch}} [opts]
* @returns {Promise<{alive:boolean, detail:string, tried:string[]}>}
*/
async function probeLocalEndpoint(baseUrl, opts = {}) {
	const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 2e3;
	const doFetch = opts.fetchImpl || globalThis.fetch;
	let origin;
	let candidates;
	try {
		const u = new URL(baseUrl);
		origin = u.origin;
		const basePath = u.pathname.replace(/\/$/, "");
		candidates = [`${origin}/health`, `${origin}${basePath}/models`];
	} catch {
		return {
			alive: false,
			detail: `unparseable base_url: ${baseUrl}`,
			tried: []
		};
	}
	const tried = [];
	let lastError = "";
	for (const url of candidates) {
		tried.push(url);
		try {
			return {
				alive: true,
				detail: `HTTP ${(await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })).status} from ${url}`,
				tried
			};
		} catch (error) {
			lastError = String(error && error.message ? error.message : error);
		}
	}
	return {
		alive: false,
		detail: lastError || "no response",
		tried
	};
}
/**
* Run one review to completion (or cancellation) and collect its outcome.
*
* @param {Parameters<typeof buildReviewArgs>[0] & {
*   binary?:string, signal?:AbortSignal, timeoutMs?:number,
*   log?:(msg:string)=>void, spawn?:typeof import('node:child_process').spawn }} opts
* @returns {Promise<{ok:boolean, report:string, error:string, exitCode:number|null, durationMs:number}>}
*   `report` is the `--json` findings text (raw stdout when the payload was
*   not parseable JSON, so nothing model-visible is lost).
*/
async function runReview(opts = {}) {
	const startedAt = Date.now();
	let argv;
	let tempFiles = [];
	try {
		({argv, tempFiles} = buildReviewArgs(opts));
	} catch (error) {
		cleanupTempFiles(tempFiles);
		const message = String(error && error.message ? error.message : error);
		if (opts.log) opts.log(`review argument construction failed: ${message}`);
		return {
			ok: false,
			report: "",
			error: `could not prepare review: ${message}`,
			exitCode: -1,
			durationMs: Date.now() - startedAt
		};
	}
	const bin = resolveBinary(opts.binary);
	const spawner = opts.spawn || spawnOverride || (await import("node:child_process")).spawn;
	let child;
	try {
		child = spawner(bin, argv, {
			cwd: opts.workingDir || process.cwd(),
			env: process.env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
	} catch (error) {
		cleanupTempFiles(tempFiles);
		const message = String(error && error.message ? error.message : error);
		if (opts.log) opts.log(`review spawn threw: ${message}`);
		return {
			ok: false,
			report: "",
			error: `spawn failed: ${message}`,
			exitCode: -1,
			durationMs: Date.now() - startedAt
		};
	}
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const killer = () => {
		try {
			child.kill("SIGKILL");
		} catch {
			child.kill();
		}
	};
	const onAbort = () => killer();
	if (opts.signal) {
		if (opts.signal.aborted) killer();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}
	let timedOut = false;
	const timer = opts.timeoutMs ? setTimeout(() => {
		timedOut = true;
		opts.log?.(`review wall-clock cap (${opts.timeoutMs}ms) exceeded — killing`);
		killer();
	}, opts.timeoutMs) : void 0;
	let spawnError = "";
	const exitCodeRaw = await new Promise((resolve) => {
		child.on("exit", (code) => resolve(code));
		child.on("error", (error) => {
			spawnError = String(error && error.message ? error.message : error);
			if (opts.log) opts.log(`review spawn error: ${spawnError}`);
			resolve(null);
		});
	});
	if (timer) clearTimeout(timer);
	if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
	cleanupTempFiles(tempFiles);
	const durationMs = Date.now() - startedAt;
	const aborted = opts.signal?.aborted === true;
	const report = stdout.trim();
	const exitCode = exitCodeRaw === null ? -1 : exitCodeRaw;
	const stderrTrimmed = stderr.trim().slice(0, 2e3);
	if (aborted) return {
		ok: false,
		report,
		error: "canceled by caller",
		exitCode,
		durationMs
	};
	if (timedOut) return {
		ok: false,
		report,
		error: `atomcode review timed out after ${opts.timeoutMs}ms (process killed)`,
		exitCode,
		durationMs
	};
	if (exitCode !== 0) {
		let detail = exitCode === -1 ? `spawn failed: ${spawnError}` : stderrTrimmed || "no stderr output";
		if (/llm-api\.atomgit\.com/i.test(detail) || /signing.enforced|atomcodex cannot authenticate/i.test(detail)) detail += " — the review CLI cannot sign requests against the AtomGit gateway; use a non-gateway provider (e.g. OpenAI / Ollama) with a direct [providers.<name>] entry and api_key, or use daemon-side atomcode_ask which embeds the signing";
		else if (/missing base URL/i.test(detail)) detail += " — the configured default_provider has no base_url; add a direct [providers.<name>] entry with base_url (non-AtomGit) for the review CLI; daemon ask is unaffected";
		return {
			ok: false,
			report,
			error: `atomcode review exited ${exitCode}: ${detail}`,
			exitCode,
			durationMs
		};
	}
	if (report === "") return {
		ok: false,
		report,
		error: "atomcode review produced no output",
		exitCode,
		durationMs
	};
	return {
		ok: true,
		report,
		error: "",
		exitCode,
		durationMs
	};
}

//#endregion
export { buildReviewArgs, checkReviewProvision, cleanupTempFiles, isLoopbackBaseUrl, listUsableProviders, parseTomlProviders, probeLocalEndpoint, resolveBinary, runReview, selectReviewProvider, setSpawnOverride };