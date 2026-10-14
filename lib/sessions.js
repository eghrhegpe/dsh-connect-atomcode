/**
 * sessions.js — side-conversation session map for the AtomCode bridge.
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
 * To avoid cross-profile key collisions (web + desktop sharing the same
 * JSON file), a `keyPrefix` may be configured. If the caller passes
 * the profile name, keys are stored as `"<profile>::<working_dir>"` so
 * each profile's sessions are isolated from others writing to the same file.
 *
 * @module dsh-atomcode-bridge/sessions
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** @returns {string} the default state file path under the DSH home. */
export function defaultStatePath() {
  return join(homedir(), '.dsh', 'state', 'dsh-atomcode-bridge', 'sessions.json');
}

/**
 * One atomic-mutate access to the session map.
 *
 * @param {string} [path] - Session JSON file path.
 * @param {string} [keyPrefix] - Optional prefix for every key (e.g. "web" or "desktop").
 *   `get()` accepts the logical key (no prefix needed); `set()`/`drop()` store/delete with
 *   the prefix. Pass an empty string to disable prefixing (default).
 */
export function createSessionStore(path = defaultStatePath(), keyPrefix = '') {
  const prefix = typeof keyPrefix === 'string' && keyPrefix.trim() !== '' ? keyPrefix.trim() + '::' : '';
  /** @type {Record<string, { sessionId: string, updatedAt: number }>} */
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      cache = {};
    }
    return cache;
  }

  function save(map) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    try {
      renameSync(tmp, path);
    } catch {
      writeFileSync(path, JSON.stringify(map, null, 2), 'utf8');
    }
  }

  function internalKey(outerKey) {
    return prefix + outerKey;
  }

  return {
    /** @returns {string|undefined} the recorded AtomCode session for one working_dir key. */
    get(key) {
      const entry = load()[internalKey(key)];
      return entry && typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
    },
    /** Record a session for one working_dir key. */
    set(key, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      const map = load();
      map[internalKey(key)] = { sessionId, updatedAt: Date.now() };
      save(map);
    },
    /** Drop one working_dir key. */
    drop(key) {
      const map = load();
      delete map[internalKey(key)];
      save(map);
    },
    /** @returns {number} the number of tracked side-conversation keys (across all prefixes). */
    count() {
      return Object.keys(load()).length;
    },
  };
}
