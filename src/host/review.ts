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
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultBinary } from './daemon.ts';

/** Spawn seam shape: the `child_process.spawn` surface this module calls. */
type Spawner = (
  bin: string,
  args: string[],
  opts: object,
) => import('node:child_process').ChildProcessWithoutNullStreams;

/** Options accepted by `buildReviewArgs` (mirrors its JSDoc contract above). */
export interface ReviewOptions {
  workingDir?: string;
  task?: string;
  base?: string;
  staged?: boolean;
  pr?: number;
  diffText?: string;
  provider?: string;
  maxRounds?: number;
  maxDurationSecs?: number;
  noWeb?: boolean;
}

/** `buildReviewArgs` result: the CLI argv plus the temp dirs to clean up. */
export interface ReviewArgs {
  argv: string[];
  tempFiles: string[];
}

/** One `[providers.<name>]` direct entry as parsed out of config.toml. */
export interface TomlProvider {
  name: string;
  [key: string]: string;
}

/** `checkReviewProvision` verdict, read at mount to degrade the tool description. */
export interface ReviewProvision {
  available: boolean;
  reason: string;
  providers: string[];
}

/** A direct provider entry the review CLI can actually be expected to run with. */
export interface UsableProvider {
  name: string;
  baseUrl: string;
}

/** `selectReviewProvider`'s decision for one review call. */
export interface ReviewSelection {
  provider: string | null;
  baseUrl: string;
  auto: boolean;
  error: string;
  reason?: string;
}

/** Options accepted by `probeLocalEndpoint`. */
export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** `probeLocalEndpoint` result. */
export interface ProbeResult {
  alive: boolean;
  detail: string;
  tried: string[];
}

/** Options accepted by `runReview`. */
export interface RunReviewOptions extends ReviewOptions {
  binary?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  log?: (msg: string) => void;
  spawn?: Spawner;
}

/** `runReview` outcome. */
export interface ReviewOutcome {
  ok: boolean;
  report: string;
  error: string;
  exitCode: number | null;
  durationMs: number;
}

/** @type {(bin:string, args:string[], opts:object) => import('node:child_process').ChildProcess} */
let spawnOverride: Spawner | null = null;

/**
 * Test seam: replace the spawner (unit tests). Pass `null` to restore.
 * @param {(bin:string, args:string[], opts:object) => import('node:child_process').ChildProcess} [spawner]
 */
export function setSpawnOverride(spawner?: Spawner | null) {
  spawnOverride = spawner || null;
}

/**
 * Resolve the AtomCode binary: explicit value > $ATOMCODE_BIN > platform
 * default (atomcode.exe on Windows, atomcode elsewhere). The platform default
 * is reused from `daemon.ts` so the two host modules cannot drift apart.
 * @param {string} [configBinary]
 * @returns {string}
 */
export function resolveBinary(configBinary?: string): string {
  if (typeof configBinary === 'string' && configBinary.trim() !== '') return configBinary.trim();
  if (process.env.ATOMCODE_BIN && process.env.ATOMCODE_BIN.trim() !== '') return process.env.ATOMCODE_BIN.trim();
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
export function buildReviewArgs(opts: ReviewOptions = {}): ReviewArgs {
  const argv = ['review'];
  const tempFiles: string[] = [];

  // Task mode replaces the diff-review task entirely and skips diff computation.
  if (typeof opts.task === 'string' && opts.task.trim() !== '') {
    argv.push('--task', opts.task);
  } else {
    // Diff selection: explicit diff text > PR > staged > base > uncommitted default.
    if (typeof opts.diffText === 'string' && opts.diffText.trim() !== '') {
      const dir = mkdtempSync(join(tmpdir(), 'atomcode-diff-'));
      try {
        const file = join(dir, 'review.diff');
        writeFileSync(file, opts.diffText, 'utf8');
        tempFiles.push(dir);
        argv.push('--diff-file', file);
      } catch (error) {
        // The caller never receives tempFiles when this throws, so the dir must
        // be reclaimed here or it leaks silently.
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        throw error;
      }
    } else if (Number.isFinite(opts.pr) && opts.pr! > 0) {
      argv.push('--pr', String(Math.floor(opts.pr!)));
    } else if (opts.staged === true) {
      argv.push('--staged');
    } else if (typeof opts.base === 'string' && opts.base.trim() !== '') {
      argv.push('--base', opts.base.trim());
    }
  }

  if (typeof opts.workingDir === 'string' && opts.workingDir.trim() !== '') {
    argv.push('--repo', opts.workingDir.trim());
  }
  if (typeof opts.provider === 'string' && opts.provider.trim() !== '') {
    argv.push('--provider', opts.provider.trim());
  }

  // Sanitize the fuses at the argv boundary: a non-positive or non-finite value
  // would otherwise be handed to the CLI verbatim (`--max-rounds -5`,
  // `--max-duration 0`) and its meaning becomes the CLI's guess — a zero round
  // cap in particular could abort the review immediately. Fall back to the
  // documented defaults instead of forwarding nonsense.
  const maxRounds =
    Number.isFinite(opts.maxRounds) && opts.maxRounds! > 0 ? Math.floor(opts.maxRounds!) : 35;
  const maxDurationSecs =
    Number.isFinite(opts.maxDurationSecs) && opts.maxDurationSecs! > 0 ? Math.floor(opts.maxDurationSecs!) : 900;

  argv.push('--json', '--no-telemetry');
  argv.push('--max-rounds', String(maxRounds));
  argv.push('--max-duration', String(maxDurationSecs));
  if (opts.noWeb !== false) argv.push('--no-web');

  return { argv, tempFiles };
}

/** Remove temp diff dirs created by `buildReviewArgs`. */
export function cleanupTempFiles(tempFiles: string[] = []) {
  for (const dir of tempFiles) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
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
function unquoteTomlValue(raw: string): string {
  const v = (raw ?? '').trim();
  if (v.startsWith('"')) {
    const end = v.indexOf('"', 1);
    return end === -1 ? v : v.slice(1, end);
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return end === -1 ? v : v.slice(1, end);
  }
  const hash = v.indexOf('#');
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
export function parseTomlProviders(raw: unknown): TomlProvider[] {
  const lines = String(raw || '').split(/\r?\n/);
  const providers: TomlProvider[] = [];
  let currentSection: string | null = null;
  const currentEntries: Record<string, string> = {};
  const pushSection = () => {
    if (currentSection && currentSection.startsWith('providers.') && Object.keys(currentEntries).length > 0) {
      providers.push({
        name: currentSection.replace(/^providers\./, '').replace(/^["']|["']$/g, ''),
        ...currentEntries,
      });
    }
  };
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (line.startsWith('#') || line === '') continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      pushSection();
      currentSection = sectionMatch[1] ?? null;
      Object.keys(currentEntries).forEach((k) => delete currentEntries[k]);
      continue;
    }
    const kvMatch = line.match(/^("?[a-zA-Z_][a-zA-Z0-9_-]*"?)\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      currentEntries[(kvMatch[1] ?? '').replace(/^["']|["']$/g, '')] = unquoteTomlValue(kvMatch[2] ?? '');
    }
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
export function checkReviewProvision(configDir?: string): ReviewProvision {
  const atomcodeHome = configDir || join(homedir(), '.atomcode');
  const configFile = join(atomcodeHome, 'config.toml');
  if (!existsSync(configFile)) {
    return { available: false, reason: 'config.toml not found', providers: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(configFile, 'utf8');
  } catch {
    return { available: false, reason: 'unreadable config.toml', providers: [] };
  }
  const providers = parseTomlProviders(raw);

  // A provider is usable when it carries a non-gateway base_url plus something
  // to run with (an api_key or an explicit model) — the SAME definition the
  // execute-time selection uses (listUsableProviders).
  const usable = listUsableProviders(raw).map((p) => p.name);
  if (usable.length > 0) {
    return { available: true, reason: '', providers: usable };
  }

  // No usable direct provider: explain the most specific cause we can prove.
  const gatewayOnly = providers.filter((p) => p.base_url && /llm-api\.atomgit\.com/i.test(p.base_url));
  if (gatewayOnly.length > 0) {
    return {
      available: false,
      reason:
        `only the AtomGit gateway is configured (${gatewayOnly.map((p) => p.name).join(', ')}): ` +
        'llm-api.atomgit.com enforces AtomCode\'s proprietary request signature on the inference endpoint, ' +
        `and the review CLI (atomcodex) does not implement it — AtomCode's own error: "signing-enforced gateway … cannot authenticate" ` +
        '(an unsigned call gets ATOMCODE_SIG_MISSING). Fix: add a direct [providers.<name>] with a STANDARD base_url + api_key. ' +
        'atomcode_ask is unaffected (the daemon carries the signing).',
      providers: [],
    };
  }
  const defaultProviderMatch = raw.match(/^default_provider\s*=\s*"([^"]+)"/m);
  const defaultProvider = defaultProviderMatch ? defaultProviderMatch[1] : '';
  const acctOnly = providers.filter((p) => !p.base_url && (p.account || p.model));
  if (acctOnly.length > 0 || defaultProvider) {
    return {
      available: false,
      reason:
        'no direct [providers.<name>] entry with a non-gateway base_url' +
        (defaultProvider ? ` (default_provider is "${defaultProvider}")` : '') +
        ': that is an AtomGit login/account channel with no api_key, and llm-api.atomgit.com requires ' +
        'AtomCode\'s proprietary request signature (unsigned calls get ATOMCODE_SIG_MISSING) which the review CLI does not implement. ' +
        'Fix: add a direct [providers.<name>] with a STANDARD base_url + api_key (OpenRouter / OpenAI / a local server). ' +
        'atomcode_ask is unaffected — the daemon carries the signing.',
      providers: [],
    };
  }
  return {
    available: false,
    reason:
      'no direct [providers.<name>] entry with base_url and api_key found; the review CLI resolves providers from direct entries only ' +
      '(the daemon and the TUI also accept account-resolved ones). atomcode_ask is unaffected.',
    providers: [],
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
export function listUsableProviders(raw: string): UsableProvider[] {
  const usable: UsableProvider[] = [];
  for (const p of parseTomlProviders(raw)) {
    if (!p.base_url) continue;
    // The AtomGit gateway URL: the review CLI refuses to sign against it.
    if (/llm-api\.atomgit\.com/i.test(p.base_url)) continue;
    if (p.api_key || p.model) usable.push({ name: p.name, baseUrl: p.base_url });
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
export function selectReviewProvider(requested?: string, configDir?: string): ReviewSelection {
  const atomcodeHome = configDir || join(homedir(), '.atomcode');
  let raw = '';
  try {
    raw = readFileSync(join(atomcodeHome, 'config.toml'), 'utf8');
  } catch {
    // checkReviewProvision refuses before selection on an unreadable config;
    // returning the request untouched keeps this function total.
    return { provider: requested || null, baseUrl: '', auto: false, error: '' };
  }
  const usable = listUsableProviders(raw);

  if (typeof requested === 'string' && requested.trim() !== '') {
    const name = requested.trim();
    const hit = usable.find((p) => p.name === name);
    // A requested name not in the usable list may still be a built-in (e.g.
    // openrouter) the CLI understands — pass it through and let the CLI judge;
    // we only lose loopback-probe info (baseUrl ''), we never block here.
    return { provider: name, baseUrl: hit ? hit.baseUrl : '', auto: false, error: '' };
  }

  const defaultMatch = raw.match(/^default_provider\s*=\s*"([^"]+)"/m);
  const defaultProvider = defaultMatch ? (defaultMatch[1] ?? '') : '';
  const defaultHit = usable.find((p) => p.name === defaultProvider);
  if (defaultHit) return { provider: defaultProvider, baseUrl: defaultHit.baseUrl, auto: false, error: '' };
  if (usable.length === 1) {
    return {
      provider: usable[0]!.name,
      baseUrl: usable[0]!.baseUrl,
      auto: true,
      error: '',
      reason: `default_provider "${defaultProvider || '(unset)'}" is not a usable direct entry; selected the only usable direct provider`,
    };
  }
  if (usable.length > 1) {
    return {
      provider: null,
      baseUrl: '',
      auto: false,
      error:
        `no provider argument and default_provider "${defaultProvider || '(unset)'}" is not a usable direct entry, ` +
        `while several direct providers exist (${usable.map((p) => p.name).join(', ')}): ` +
        'pass the `provider` tool argument to say which one — guessing could bill the review against the wrong channel.',
    };
  }
  // Usable list empty: checkReviewProvision refuses before this runs, but keep
  // the function total rather than throwing.
  return { provider: null, baseUrl: '', auto: false, error: 'no usable direct provider in config.toml' };
}

/**
 * Is this base_url a loopback/localhost endpoint (i.e. a local sidecar like
 * the atomcode-open-api proxy, which is a live process dependency)?
 * @param {string} baseUrl
 * @returns {boolean} false for anything unparseable — never probe blindly.
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname);
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
export async function probeLocalEndpoint(baseUrl: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0 ? opts.timeoutMs! : 2000;
  const doFetch = opts.fetchImpl || globalThis.fetch;
  let origin: string;
  let candidates: string[];
  try {
    const u = new URL(baseUrl);
    origin = u.origin;
    const basePath = u.pathname.replace(/\/$/, '');
    candidates = [`${origin}/health`, `${origin}${basePath}/models`];
  } catch {
    return { alive: false, detail: `unparseable base_url: ${baseUrl}`, tried: [] };
  }
  const tried: string[] = [];
  let lastError = '';
  for (const url of candidates) {
    tried.push(url);
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      // Anything answered: the port is served. 4xx/5xx still proves liveness.
      return { alive: true, detail: `HTTP ${res.status} from ${url}`, tried };
    } catch (error: any) {
      lastError = String(error && error.message ? error.message : error);
    }
  }
  return { alive: false, detail: lastError || 'no response', tried };
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
export async function runReview(opts: RunReviewOptions = {}): Promise<ReviewOutcome> {
  const startedAt = Date.now();
  let argv: string[];
  let tempFiles: string[] = [];
  try {
    ({ argv, tempFiles } = buildReviewArgs(opts));
  } catch (error: any) {
    // mkdtemp/writeFileSync can fail (ENOSPC, EPERM). Without this the failure
    // escapes as a rejection into the tool layer instead of a structured result.
    cleanupTempFiles(tempFiles);
    const message = String(error && error.message ? error.message : error);
    if (opts.log) opts.log(`review argument construction failed: ${message}`);
    return {
      ok: false,
      report: '',
      error: `could not prepare review: ${message}`,
      exitCode: -1,
      durationMs: Date.now() - startedAt,
    };
  }
  const bin = resolveBinary(opts.binary);

  const spawner: Spawner = opts.spawn || spawnOverride || (await import('node:child_process')).spawn;
  let child;
  try {
    child = spawner(bin, argv, {
      cwd: opts.workingDir || process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    // A synchronous spawn throw (missing/unusable cwd, invalid args) must not
    // leak the temp diff dir that buildReviewArgs already created, and must
    // stay a structured result instead of rejecting into the tool layer.
    cleanupTempFiles(tempFiles);
    const message = String(error && error.message ? error.message : error);
    if (opts.log) opts.log(`review spawn threw: ${message}`);
    return {
      ok: false,
      report: '',
      error: `spawn failed: ${message}`,
      exitCode: -1,
      durationMs: Date.now() - startedAt,
    };
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const killer = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      child.kill();
    }
  };
  const onAbort = () => killer();
  if (opts.signal) {
    if (opts.signal.aborted) killer();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  // Hard wall-clock backstop, independent of the CLI's own --max-duration: if
  // the process ignores its fuse (or stalls before honouring it), the bridge
  // still stops waiting. `timedOut` is tracked so the outcome reads as a
  // timeout rather than a generic non-zero exit.
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        opts.log?.(`review wall-clock cap (${opts.timeoutMs}ms) exceeded — killing`);
        killer();
      }, opts.timeoutMs)
    : undefined;

  let spawnError = '';
  const exitCodeRaw = await new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', (error) => {
      spawnError = String(error && error.message ? error.message : error);
      if (opts.log) opts.log(`review spawn error: ${spawnError}`);
      resolve(null);
    });
  });

  if (timer) clearTimeout(timer);
  if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  cleanupTempFiles(tempFiles);

  const durationMs = Date.now() - startedAt;
  const aborted = opts.signal?.aborted === true;
  const report = stdout.trim();
  const exitCode = exitCodeRaw === null ? -1 : exitCodeRaw;

  const stderrTrimmed = stderr.trim().slice(0, 2000);
  if (aborted) {
    return { ok: false, report, error: 'canceled by caller', exitCode, durationMs };
  }
  if (timedOut) {
    // Report the fuse as what it is: a killed run reads as a signal exit code
    // otherwise, and "exited 137" tells the caller nothing useful.
    return {
      ok: false,
      report,
      error: `atomcode review timed out after ${opts.timeoutMs}ms (process killed)`,
      exitCode,
      durationMs,
    };
  }
  if (exitCode !== 0) {
    // report stays as raw stdout (partial output or empty); error carries stderr
    // diagnostics only – never substitute report for stderr.
    let detail =
      exitCode === -1
        ? `spawn failed: ${spawnError}`
        : (stderrTrimmed || 'no stderr output');
    // Gateway-signing diagnosis: the AtomGit gateway base_url is rejected by the
    // review CLI even with a direct [providers.<name>] entry — the CLI runtime
    // cannot authenticate against the AtomGit signing mechanism.
    if (/llm-api\.atomgit\.com/i.test(detail) || /signing.enforced|atomcodex cannot authenticate/i.test(detail)) {
      detail += ' — the review CLI cannot sign requests against the AtomGit gateway; use a non-gateway provider (e.g. OpenAI / Ollama) with a direct [providers.<name>] entry and api_key, or use daemon-side atomcode_ask which embeds the signing';
    } else if (/missing base URL/i.test(detail)) {
      detail += ' — the configured default_provider has no base_url; add a direct [providers.<name>] entry with base_url (non-AtomGit) for the review CLI; daemon ask is unaffected';
    }
    return { ok: false, report, error: `atomcode review exited ${exitCode}: ${detail}`, exitCode, durationMs };
  }
  if (report === '') {
    return { ok: false, report, error: 'atomcode review produced no output', exitCode, durationMs };
  }
  return { ok: true, report, error: '', exitCode, durationMs };
}
