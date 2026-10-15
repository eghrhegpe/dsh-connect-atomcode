import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

//#region src/host/sessions.ts
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
/** How many `<path>.corrupt-<ts>` generations to keep for inspection. */
const KEEP_QUARANTINES = 2;
/** Orphan temp files younger than this may belong to a live writer — leave them. */
const ORPHAN_TMP_MIN_AGE_MS = 6e4;
/** @returns {string} the default state file path under the DSH home. */
function defaultStatePath() {
	return join(homedir(), ".dsh", "state", "dsh-atomcode-bridge", "sessions.json");
}
/**
* One read-modify-write accessor for the session map.
*
* @param {string} [path] - Session JSON file path.
* @param {string} [keyPrefix] - Optional prefix for every key (e.g. "web" or "desktop").
*   `get()`/`set()`/`drop()` all take the logical key; the prefix is applied on disk.
*   Pass an empty string to disable prefixing (default).
*/
function createSessionStore(path = defaultStatePath(), keyPrefix = "") {
	const prefix = typeof keyPrefix === "string" && keyPrefix.trim() !== "" ? keyPrefix.trim() + "::" : "";
	/**
	* Bound the growth of quarantine copies and orphaned temp files. Best-effort
	* and cheap: run once per store creation, i.e. once per plugin mount, which
	* is enough because each host start clears what previous crashes left.
	*/
	function sweepStale() {
		try {
			const dir = dirname(path);
			const base = basename(path);
			const names = readdirSync(dir);
			const quarantines = names.filter((name) => name.startsWith(`${base}.corrupt-`)).sort();
			for (const stale of quarantines.slice(0, Math.max(0, quarantines.length - KEEP_QUARANTINES))) try {
				rmSync(join(dir, stale), { force: true });
			} catch {}
			for (const name of names) {
				if (!name.startsWith(`${base}.`) || !name.endsWith(".tmp")) continue;
				const full = join(dir, name);
				try {
					if (Date.now() - statSync(full).mtimeMs > ORPHAN_TMP_MIN_AGE_MS) rmSync(full, { force: true });
				} catch {}
			}
		} catch {}
	}
	sweepStale();
	/**
	* Read the whole map from disk on every call (never cached — see module note).
	* NOTE: this may quarantine a corrupt file as a side effect, so even the
	* nominally read-only `get()`/`count()` can write to the directory.
	*/
	function readMap() {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch (error) {
			if (error && error.code !== "ENOENT") try {
				renameSync(path, `${path}.corrupt-${Date.now()}`);
				sweepStale();
			} catch {}
			return {};
		}
	}
	function writeMap(map) {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
		try {
			renameSync(tmp, path);
		} catch {
			writeFileSync(path, JSON.stringify(map, null, 2), "utf8");
		}
	}
	function internalKey(outerKey) {
		return prefix + outerKey;
	}
	return {
		/** @returns {string|undefined} the recorded AtomCode session for one working_dir key. */
		get(key) {
			const entry = readMap()[internalKey(key)];
			return entry && typeof entry.sessionId === "string" ? entry.sessionId : void 0;
		},
		/** Record a session for one working_dir key. */
		set(key, sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return;
			const map = readMap();
			map[internalKey(key)] = {
				sessionId,
				updatedAt: Date.now()
			};
			writeMap(map);
		},
		/** Drop one working_dir key. */
		drop(key) {
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
		count() {
			const map = readMap();
			if (prefix === "") return Object.keys(map).length;
			return Object.keys(map).filter((key) => key.startsWith(prefix)).length;
		}
	};
}

//#endregion
export { createSessionStore, defaultStatePath };