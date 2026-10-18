/**
 * usage-store.ts — the durable side of the panel's 「工具调用统计」 card.
 *
 * The `stats.ask` counters (calls / ok / err / msTotal / tokens) used to live
 * only in the host process's memory: a plugin reload or a Host restart reset
 * them to zero, so the panel's "ask 累计 tokens" read as a per-session
 * curiosity rather than "how much has this plugin actually spent on me". This
 * store persists the five counters to `usage.json` (next to `provider.json`
 * and `panel-settings.json`) and seeds them back into the bag at mount, so the
 * accumulated numbers survive a restart.
 *
 * ## Deliberately NARROW
 *
 * Only the five counters. `inFlight` and `askLive` are host-only runtime facts
 * and never belong on disk — writing them would freeze a turn in time and
 * replay a dead "running" row after a restart. The counters are an aggregation
 * of what the user already spent, so a bad or missing file costs nothing but
 * the count: the store is total (never throws) and every degradation is NAMED
 * through the `onError` observer (红线 3) instead of swallowed.
 *
 * A version gate keeps a newer build's shape from being clobbered by an older
 * one, the same way `provider.json` refuses to overwrite a document a newer
 * build wrote. Unlike `provider.json` there is nothing to "lose" — a refused
 * write just leaves the newer counts on disk — so this is best-effort, never a
 * refusal the caller has to route around.
 *
 * @module dsh-connect-atomcode/usage-store
 */
import { readFileSync } from 'node:fs';
import { quarantineFile, sweepStaleArtifacts, writeJsonFile } from './state-file.ts';

/** The five persisted ask counters. `inFlight` is deliberately absent. */
export interface AskUsageCounters {
  calls: number;
  ok: number;
  err: number;
  msTotal: number;
  tokens: number;
}

/** Shape this build writes. Bump only when the on-disk shape changes. */
export const USAGE_FILE_VERSION = 1;

/** The zeroed reading, also what a missing file means. */
export function emptyAskUsage(): AskUsageCounters {
  return { calls: 0, ok: 0, err: 0, msTotal: 0, tokens: 0 };
}

export interface UsageStore {
  read: () => AskUsageCounters;
  write: (counters: AskUsageCounters) => void;
  path: () => string;
}

export function createUsageStore(path: string, onError?: (error: string) => void): UsageStore {
  sweepStaleArtifacts(path);

  /** Degrade to zeroes AND name the reason (红线 3: silence reads as "no usage"). */
  const degraded = (message: string): AskUsageCounters => {
    if (typeof onError === 'function') onError(message);
    return emptyAskUsage();
  };

  /**
   * The counters as they sit on disk, or a neutral reading. Never throws.
   * An unparseable file is preserved aside (so a half-write is inspectable)
   * and read as zeroes WITH the reason.
   */
  function read(): AskUsageCounters {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error: any) {
      if (error && error.code === 'ENOENT') return emptyAskUsage();
      if (error && error.code === 'EISDIR') return degraded('usage state path is a directory, not a file');
      return degraded(
        quarantineFile(path)
          ? 'usage state file was unreadable and preserved aside'
          : 'usage state file is unreadable and could not be preserved aside',
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return degraded(
        quarantineFile(path)
          ? 'usage state file was corrupt and preserved aside'
          : 'usage state file is not valid JSON',
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return degraded('usage state file is not an object');
    }
    const version = Number.isInteger(parsed.version) ? parsed.version : 0;
    if (version > USAGE_FILE_VERSION) {
      // A newer build wrote it: start from zero rather than guess at a shape
      // we do not know, and never overwrite what is on disk.
      return degraded(
        `usage state was written by a newer build of this plugin (version ${version}, this build knows ${USAGE_FILE_VERSION})`,
      );
    }
    const doc = parsed.ask;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return emptyAskUsage();
    // A counter is either a non-negative finite number or 0 — never a string
    // the renderer would have to coerce, never a negative the user did not spend.
    const num = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    return {
      calls: num(doc.calls),
      ok: num(doc.ok),
      err: num(doc.err),
      msTotal: num(doc.msTotal),
      tokens: num(doc.tokens),
    };
  }

  /** The on-disk `version` field, or 0 when there is no readable document. */
  function diskVersion(): number {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return Number.isInteger(parsed && parsed.version) ? parsed.version : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Replace the counters on disk. Re-reads the version first (the same
   * "a concurrent write must not be clobbered" contract the provider store
   * keeps): a document a NEWER build wrote is never overwritten — the newer
   * counts are more complete than ours, and this run's increments are lost
   * rather than theirs.
   */
  function write(counters: AskUsageCounters): void {
    const version = diskVersion();
    if (version > USAGE_FILE_VERSION) {
      degraded(
        `usage state was written by a newer build of this plugin (version ${version}, this build knows ${USAGE_FILE_VERSION}); refusing to overwrite it`,
      );
      return;
    }
    writeJsonFile(path, {
      version: USAGE_FILE_VERSION,
      ask: {
        calls: counters.calls,
        ok: counters.ok,
        err: counters.err,
        msTotal: counters.msTotal,
        tokens: counters.tokens,
      },
      updatedAt: Date.now(),
    });
  }

  return { read, write, path: () => path };
}