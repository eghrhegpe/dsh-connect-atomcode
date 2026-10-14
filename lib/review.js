/**
 * review.js — one-shot `atomcode review` CLI wrapper.
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

/** @type {(bin:string, args:string[], opts:object) => import('node:child_process').ChildProcess} */
let spawnOverride = null;

/**
 * Test seam: replace the spawner (unit tests). Pass `null` to restore.
 * @param {(bin:string, args:string[], opts:object) => import('node:child_process').ChildProcess} [spawner]
 */
export function setSpawnOverride(spawner) {
  spawnOverride = spawner || null;
}

/**
 * Resolve the AtomCode binary: explicit value > $ATOMCODE_BIN > platform
 * default (atomcode.exe on Windows, atomcode elsewhere).
 * @param {string} [configBinary]
 * @returns {string}
 */
export function resolveBinary(configBinary) {
  if (typeof configBinary === 'string' && configBinary.trim() !== '') return configBinary.trim();
  if (process.env.ATOMCODE_BIN && process.env.ATOMCODE_BIN.trim() !== '') return process.env.ATOMCODE_BIN.trim();
  return process.platform === 'win32' ? 'atomcode.exe' : 'atomcode';
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
export function buildReviewArgs(opts = {}) {
  const argv = ['review'];
  const tempFiles = [];

  // Task mode replaces the diff-review task entirely and skips diff computation.
  if (typeof opts.task === 'string' && opts.task.trim() !== '') {
    argv.push('--task', opts.task);
  } else {
    // Diff selection: explicit diff text > PR > staged > base > uncommitted default.
    if (typeof opts.diffText === 'string' && opts.diffText.trim() !== '') {
      const dir = mkdtempSync(join(tmpdir(), 'atomcode-diff-'));
      const file = join(dir, 'review.diff');
      writeFileSync(file, opts.diffText, 'utf8');
      tempFiles.push(dir);
      argv.push('--diff-file', file);
    } else if (Number.isFinite(opts.pr) && opts.pr > 0) {
      argv.push('--pr', String(Math.floor(opts.pr)));
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

  argv.push('--json', '--no-telemetry');
  argv.push('--max-rounds', String(opts.maxRounds ?? 35));
  argv.push('--max-duration', String(opts.maxDurationSecs ?? 900));
  if (opts.noWeb !== false) argv.push('--no-web');

  return { argv, tempFiles };
}

/** Remove temp diff dirs created by `buildReviewArgs`. */
export function cleanupTempFiles(tempFiles = []) {
  for (const dir of tempFiles) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Check whether the local AtomCode config has a direct `[providers.<name>]`
 * entry with `base_url` that the review CLI can actually resolve (not a
 * AtomGit gate-signed gateway). Daemon-side ask is unaffected.
 *
 * @param {string} [configDir] - override ~/.atomcode for tests.
 * @returns {{ available: boolean, reason: string }}
 */
export function checkReviewProvision(configDir) {
  const atomcodeHome = configDir || join(homedir(), '.atomcode');
  const configFile = join(atomcodeHome, 'config.toml');
  if (!existsSync(configFile)) {
    return { available: false, reason: 'config.toml not found' };
  }
  let raw;
  try {
    raw = readFileSync(configFile, 'utf8');
  } catch {
    return { available: false, reason: 'unreadable config.toml' };
  }
  // Minimal TOML section parser: collect [providers.<name>] entries and their keys.
  const lines = raw.split(/\r?\n/);
  const providers = [];
  let currentSection = null;
  const currentEntries = {};
  const pushSection = () => {
    if (currentSection && currentSection.startsWith('providers.') && Object.keys(currentEntries).length > 0) {
      providers.push({ name: currentSection.replace(/^providers\./, ''), ...currentEntries });
    }
  };
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (line.startsWith('#') || line === '') continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      pushSection();
      currentSection = sectionMatch[1];
      Object.keys(currentEntries).forEach((k) => delete currentEntries[k]);
      continue;
    }
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      currentEntries[kvMatch[1]] = kvMatch[2].replace(/^["']|["']$/g, '');
    }
  }
  pushSection();

  // Filter to providers with a base_url (direct or account-resolved that the CLI sees).
  for (const p of providers) {
    if (!p.base_url) continue;
    // The AtomGit gateway URL: the review CLI binary refuses to sign against it.
    if (/llm-api\.atomgit\.com/i.test(p.base_url)) continue;
    // Must have either an api_key or a model so it can actually run.
    if (p.api_key || p.model || p.account) {
      return { available: true, reason: '' };
    }
  }

  // Attempt to detect an account-resolved default that won't work.
  const defaultProviderMatch = raw.match(/^default_provider\s*=\s*"([^"]+)"/m);
  const defaultProvider = defaultProviderMatch ? defaultProviderMatch[1] : '';
  if (defaultProvider) {
    const prov = providers.find((p) => p.name === defaultProvider);
    if (prov && !prov.base_url) {
      return { available: false, reason: `default_provider "${defaultProvider}" has no base_url — add [providers.${defaultProvider}] with base_url (or pass --provider with a direct entry) for the review CLI; daemon ask is unaffected` };
    }
  }
  return { available: false, reason: 'no direct [providers.<name>] entry with base_url and api_key found; the review CLI resolves providers from direct entries only (daemon ask is unaffected)' };
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
export async function runReview(opts = {}) {
  const { argv, tempFiles } = buildReviewArgs(opts);
  const bin = resolveBinary(opts.binary);
  const startedAt = Date.now();

  const spawner = opts.spawn || spawnOverride || (await import('node:child_process')).spawn;
  const child = spawner(bin, argv, {
    cwd: opts.workingDir || process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        opts.log?.(`review wall-clock cap (${opts.timeoutMs}ms) exceeded — killing`);
        killer();
      }, opts.timeoutMs)
    : undefined;

  let spawnError = '';
  const exitCodeRaw = await new Promise((resolve) => {
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
