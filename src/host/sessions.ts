/**
 * sessions.ts — side-conversation session map for the AtomCode bridge.
 *
 * Keys one AtomCode daemon `session_id` per DSH-side conversation axis
 * (working_dir, or "default"). After every successful `atomcode_ask` turn
 * the returned session is recorded here; the next call with
 * `continue: true` resumes it, so the model never has to carry ids itself.
 *
 * State lives at `~/.dsh/state/dsh-atomcode-bridge/sessions.json` (the
 * per-plugin DSH home convention, matching sibling plugins). The path is
 * injectable for tests.
 *
 * ## Concurrency (read this before "fixing" it)
 *
 * Two DSH profiles (web + desktop) may share one state file, so every mutation
 * is a READ-MODIFY-WRITE against the file rather than an update of an
 * in-memory copy: a process-lifetime cache would let the second writer persist
 * a map that predates the first writer's change and silently erase it (lost
 * update). Temp files are pid+time suffixed so two writers never share one
 * temp path.
 *
 * This does NOT make the file transactional, and it is not supposed to. The
 * residual window is the read→rename interval — microseconds, because the whole
 * read-modify-write runs in one synchronous block with no `await`. Closing it
 * properly would need a lock (Node core has no portable flock; it would mean an
 * O_EXCL lockfile with a spin), which is over-engineering for a session-id map.
 * What keeps the residual risk acceptable:
 *   (a) the window is microseconds, not the life of the process;
 *   (b) two profiles finishing a turn in the same microsecond is unlikely; and
 *   (c) a lost key degrades to "the next `continue` opens a fresh side
 *       conversation" — bounded, never corruption.
 *
 * A `keyPrefix` per profile keeps the two writers on disjoint keys so the file
 * is easier to reason about, but it does NOT by itself prevent the lost update
 * above: the loss is a whole-map overwrite, not a key collision.
 *
 * Quarantine + temp churn: a corrupt file is renamed to `<path>.corrupt-<ts>`
 * (never silently erased) and orphan temp files survive a SIGKILL between write
 * and rename, so `sweepStale()` trims both — newest few quarantines kept, temp
 * files older than a minute removed.
 *
 * @module dsh-atomcode-bridge/sessions
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleArtifacts, quarantineFile, writeJsonFile } from './state-file.ts';

/** One entry of the on-disk map: the daemon session plus its write time. */
export interface SessionEntry {
  sessionId?: string;
  updatedAt?: number;
}
/** The on-disk shape: DSH-side key → entry. Unvalidated JSON, so `null` is possible. */
export type SessionMap = Record<string, SessionEntry | null>;

/** @returns {string} the default state file path under the DSH home. */
export function defaultStatePath(): string {
  return join(homedir(), '.dsh', 'state', 'dsh-atomcode-bridge', 'sessions.json');
}

/**
 * One read-modify-write accessor for the session map.
 *
 * @param {string} [path] - Session JSON file path.
 * @param {string} [keyPrefix] - Optional prefix for every key (e.g. "web" or "desktop").
 *   `get()`/`set()`/`drop()` all take the logical key; the prefix is applied on disk.
 *   Pass an empty string to disable prefixing (default).
 */
export function createSessionStore(path = defaultStatePath(), keyPrefix = '') {
  const prefix = typeof keyPrefix === 'string' && keyPrefix.trim() !== '' ? keyPrefix.trim() + '::' : '';

  // Quarantine/temp reaping now lives in state-file.ts, shared with
  // provider.json — it used to be a verbatim copy of the same loop.
  sweepStaleArtifacts(path);

  /**
   * Read the whole map from disk on every call (never cached — see module note).
   * NOTE: this may quarantine a corrupt file as a side effect, so even the
   * nominally read-only `get()`/`count()` can write to the directory.
   */
  function readMap(): SessionMap {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error: any) {
      // Distinguish "no file yet" from "file is corrupt": the latter is worth
      // preserving, because the next write would otherwise erase session ids
      // that a running conversation still references.
      //
      // KNOWN ASYMMETRY, left alone on purpose: this branch also fires for
      // EISDIR (the path is a directory), where quarantining means renaming a
      // directory. provider.json special-cases EISDIR into a named error
      // instead. Aligning them needs a decision about the WRITE path too
      // (`writeJsonFile` throws when the destination is a directory, and "fail
      // the turn" vs "degrade to no session" is a behaviour change, not a
      // refactor) — so it is not smuggled into this one.
      if (error && error.code !== 'ENOENT') quarantineFile(path);
      return {};
    }
  }

  function writeMap(map: SessionMap) {
    writeJsonFile(path, map);
  }

  function internalKey(outerKey: string): string {
    return prefix + outerKey;
  }

  return {
    /** @returns {string|undefined} the recorded AtomCode session for one working_dir key. */
    get(key: string): string | undefined {
      const entry = readMap()[internalKey(key)];
      return entry && typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
    },
    /** Record a session for one working_dir key. */
    set(key: string, sessionId: string): void {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      const map = readMap();
      map[internalKey(key)] = { sessionId, updatedAt: Date.now() };
      writeMap(map);
    },
    /** Drop one working_dir key. */
    drop(key: string): void {
      const map = readMap();
      const internal = internalKey(key);
      if (!(internal in map)) return;
      delete map[internal];
      writeMap(map);
    },
    /**
     * @returns {number} the number of tracked side-conversation keys. With a
     *   keyPrefix configured, only this store's prefixed keys are counted —
     *   otherwise the panel's `sessions.tracked` would silently include the
     *   other profile's lines from a shared state file. With no prefix (''),
     *   all keys are this store's keys, so the count is the whole map.
     */
    count(): number {
      const map = readMap();
      if (prefix === '') return Object.keys(map).length;
      return Object.keys(map).filter((key) => key.startsWith(prefix)).length;
    },
  };
}
