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
 * and rename; `state-file.ts` sweeps both — newest few quarantines kept, temp
 * files older than a minute removed.
 *
 * ## Failure semantics: this store NEVER throws
 *
 * Session glue is an OPTIMISATION — losing a key costs one fresh side
 * conversation on the next `continue`. So a state file that cannot be read or
 * written degrades to "no session recorded"; it must never take a turn down.
 *
 * The write side used to break that promise: `set()` called the raw write, so a
 * throw (EISDIR when `state_path` points at a directory, EACCES, a full disk)
 * propagated out of `execute()` AFTER the turn had already succeeded — a
 * complete answer handed back to the model as a tool error, caused by the
 * bookkeeping rather than the work. The read side degraded; both do now.
 *
 * Degrading is not hiding (红线 3). Every degradation is NAMED through the
 * `onError` observer, deduplicated so that re-reading a broken path once per
 * call (the panel polls `count()`) reports once, not once per poll. An empty
 * string means "recovered", so one channel carries both directions and the
 * caller needs one assignment rather than two branches.
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
 * @param {{onError?: (error: string) => void}} [options] - `onError` observes every
 *   degradation (see the module note on failure semantics). It receives the new
 *   state — a message when degraded, `''` when recovered — and is called only
 *   when that message actually changes. A throwing observer is swallowed: the
 *   reporter must not be able to break the store it reports on.
 */
export function createSessionStore(
  path = defaultStatePath(),
  keyPrefix = '',
  options: { onError?: (error: string) => void } = {},
) {
  const prefix = typeof keyPrefix === 'string' && keyPrefix.trim() !== '' ? keyPrefix.trim() + '::' : '';

  /** Last reported degradation, '' when healthy. Doubles as the dedupe key. */
  let lastError = '';
  function reportState(error: string) {
    if (error === lastError) return;
    lastError = error;
    try {
      options.onError?.(error);
    } catch {
      /* an observer must never break the store it observes */
    }
  }

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
      if (error && error.code === 'ENOENT') return {};
      // EISDIR is a CONFIGURATION mistake (`state_path` points at a directory),
      // not a corrupt file, and quarantining here would rename the directory.
      // Name it and touch nothing — the branch provider.json already had.
      if (error && error.code === 'EISDIR') {
        reportState('state path is a directory, not a file');
        return {};
      }
      reportState(
        quarantineFile(path)
          ? 'unreadable sessions file was preserved aside'
          : 'sessions file is unreadable and could not be preserved aside',
      );
      return {};
    }
  }

  /**
   * @returns {boolean} whether the map reached the disk. A failed write is
   *   reported and swallowed: the caller keeps whatever it was doing.
   */
  function writeMap(map: SessionMap): boolean {
    try {
      writeJsonFile(path, map);
      reportState('');
      return true;
    } catch (error: any) {
      // Dedupe is by ROOT CAUSE, not by what happened to fail. A directory at
      // `state_path` fails the READ as EISDIR and the WRITE as EISDIR too; if
      // each side reported its own wording, the two messages would alternate
      // and every poll would look like a fresh degradation — a warning log that
      // never stops is how a real one gets ignored. Same cause, same sentence.
      const code = error && error.code;
      reportState(
        code === 'EISDIR' || code === 'ENOTDIR'
          ? 'state path is a directory, not a file'
          : `could not write the sessions file: ${String(error && error.message ? error.message : error)}`,
      );
      return false;
    }
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
    /**
     * Record a session for one working_dir key.
     * @returns {boolean} false when nothing was recorded (an empty id) or the
     *   write degraded. Callers do not branch on it; it exists so a test — and
     *   anyone debugging a state file — can tell "wrote it" from "could not".
     */
    set(key: string, sessionId: string): boolean {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      const map = readMap();
      map[internalKey(key)] = { sessionId, updatedAt: Date.now() };
      return writeMap(map);
    },
    /**
     * Drop one working_dir key.
     * @returns {boolean} true when the key is gone afterwards — including the
     *   case where it was never there, since that is already the goal state.
     */
    drop(key: string): boolean {
      const map = readMap();
      const internal = internalKey(key);
      if (!(internal in map)) return true;
      delete map[internal];
      return writeMap(map);
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
