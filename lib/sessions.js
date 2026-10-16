import { n as sweepStaleArtifacts, r as writeJsonFile, t as quarantineFile } from "./state-file.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

//#region src/host/sessions.ts
/**
* sessions.ts — side-conversation session map for the AtomCode bridge.
*
* Keys one AtomCode daemon `session_id` per DSH-side conversation axis
* (working_dir, or "default"). After every successful `atomcode_ask` turn
* the returned session is recorded here; the next call with
* `continue: true` resumes it, so the model never has to carry ids itself.
*
* State lives at `~/.dsh/state/dsh-connect-atomcode/sessions.json` (the
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
* ## Entries expire (`ttlMs`, default 24h)
*
* `updatedAt` was written by every `set()` and read NOWHERE, so the map only ever
* grew: a daemon restart or an idle exit left ids behind that no live session
* answers to, and every later `continue: true` replayed one of them and failed
* the same way — the recovery (`reset_session`) was only ever mentioned in the
* failure text, i.e. after the model had already burned a turn. An entry older
* than `ttlMs` is now treated as absent and dropped on the way past, so the file
* stops accumulating dead keys and a stale id stops being offered.
*
* An entry with NO `updatedAt` (data written before the field existed) is KEPT:
* its age is unknown, and guessing "expired" would silently end a side
* conversation that may still be alive. Expiry removes a convenience, never
* correctness — the next `continue` simply opens a fresh line.
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
* @module dsh-connect-atomcode/sessions
*/
/**
* How long a recorded side-conversation key stays resumable: 24h.
*
* Long enough that "I left it overnight" still continues the same line; short
* enough that an id whose daemon exited is not offered days later. It is a
* convenience window, not a correctness claim — see the module note on expiry.
*/
const DEFAULT_SESSION_TTL_MS = 864e5;
/** @returns {string} the default state file path under the DSH home. */
function defaultStatePath() {
	return join(homedir(), ".dsh", "state", "dsh-connect-atomcode", "sessions.json");
}
/**
* One read-modify-write accessor for the session map.
*
* @param {string} [path] - Session JSON file path.
* @param {string} [keyPrefix] - Optional prefix for every key (e.g. "web" or "desktop").
*   `get()`/`set()`/`drop()` all take the logical key; the prefix is applied on disk.
*   Pass an empty string to disable prefixing (default).
* @param {{onError?: (error: string) => void, ttlMs?: number}} [options] -
*   `onError` observes every degradation (see the module note on failure
*   semantics). It receives the new state — a message when degraded, `''` when
*   recovered — and is called only when that message actually changes. A
*   throwing observer is swallowed: the reporter must not be able to break the
*   store it reports on. `ttlMs` overrides the entry lifetime
*   (`DEFAULT_SESSION_TTL_MS`); `0` or a non-number means the default, because
*   "no expiry" is the bug this option exists to close.
*/
function createSessionStore(path = defaultStatePath(), keyPrefix = "", options = {}) {
	const prefix = typeof keyPrefix === "string" && keyPrefix.trim() !== "" ? keyPrefix.trim() + "::" : "";
	const ttlMs = typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? Math.floor(options.ttlMs) : DEFAULT_SESSION_TTL_MS;
	/**
	* Whether an entry is too old to be resumed.
	*
	* An entry with no (or a non-numeric) `updatedAt` is NOT expired: it predates
	* the field, so its age is unknown, and treating "unknown" as "expired" would
	* end a conversation that may still be alive — the one failure mode expiry
	* must not have.
	*/
	function isExpired(entry, now) {
		if (!entry || typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) return false;
		return now - entry.updatedAt > ttlMs;
	}
	/** @returns {number} how old an entry is in ms, or null when its age is unknown. */
	function ageMs(entry, now) {
		if (!entry || typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) return null;
		return Math.max(0, now - entry.updatedAt);
	}
	/** Last reported degradation, '' when healthy. Doubles as the dedupe key. */
	let lastError = "";
	function reportState(error) {
		if (error === lastError) return;
		lastError = error;
		try {
			options.onError?.(error);
		} catch {}
	}
	sweepStaleArtifacts(path);
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
			if (error && error.code === "ENOENT") return {};
			if (error && error.code === "EISDIR") {
				reportState("state path is a directory, not a file");
				return {};
			}
			reportState(quarantineFile(path) ? "unreadable sessions file was preserved aside" : "sessions file is unreadable and could not be preserved aside");
			return {};
		}
	}
	/**
	* @returns {boolean} whether the map reached the disk. A failed write is
	*   reported and swallowed: the caller keeps whatever it was doing.
	*/
	function writeMap(map) {
		try {
			writeJsonFile(path, map);
			reportState("");
			return true;
		} catch (error) {
			const code = error && error.code;
			reportState(code === "EISDIR" || code === "ENOTDIR" ? "state path is a directory, not a file" : `could not write the sessions file: ${String(error && error.message ? error.message : error)}`);
			return false;
		}
	}
	function internalKey(outerKey) {
		return prefix + outerKey;
	}
	const store = {
		/** @returns {string|undefined} the recorded AtomCode session for one working_dir key. */
		get(key) {
			const map = readMap();
			const internal = internalKey(key);
			const entry = map[internal];
			if (!entry || typeof entry.sessionId !== "string") return void 0;
			if (isExpired(entry, Date.now())) {
				delete map[internal];
				writeMap(map);
				return;
			}
			return entry.sessionId;
		},
		/**
		* Record a session for one working_dir key.
		* @returns {boolean} false when nothing was recorded (an empty id) or the
		*   write degraded. Callers do not branch on it; it exists so a test — and
		*   anyone debugging a state file — can tell "wrote it" from "could not".
		*/
		set(key, sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return false;
			const map = readMap();
			map[internalKey(key)] = {
				sessionId,
				updatedAt: Date.now()
			};
			return writeMap(map);
		},
		/**
		* Drop one working_dir key.
		* @returns {boolean} true when the key is gone afterwards — including the
		*   case where it was never there, since that is already the goal state.
		*/
		drop(key) {
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
		*
		*   RESUMABLE keys only: counting an expired id reports a side conversation
		*   the next `continue` will refuse to resume.
		*/
		count() {
			const map = readMap();
			const now = Date.now();
			return (prefix === "" ? Object.keys(map) : Object.keys(map).filter((key) => key.startsWith(prefix))).filter((key) => !isExpired(map[key], now)).length;
		},
		/**
		* Drop every expired key of this store in one pass.
		*
		* Called once at store creation, so a long-lived install reaps the ids a
		* previous daemon left behind even if nobody ever calls `continue` on them
		* again — `get()` alone only reaps the keys someone actually asks for.
		*
		* @returns {number} how many keys were removed.
		*/
		prune() {
			const map = readMap();
			const now = Date.now();
			const expired = Object.keys(map).filter((key) => (prefix === "" || key.startsWith(prefix)) && isExpired(map[key], now));
			if (expired.length === 0) return 0;
			for (const key of expired) delete map[key];
			writeMap(map);
			return expired.length;
		},
		/**
		* @returns {number|null} the age in ms of the OLDEST live key, or null when
		*   there is no key whose age is known. Surfaced so a human can see how
		*   stale the map is without opening sessions.json — an unbounded map was
		*   invisible before `updatedAt` was read at all.
		*/
		oldestAgeMs() {
			const map = readMap();
			const now = Date.now();
			let oldest = null;
			for (const key of Object.keys(map)) {
				if (prefix !== "" && !key.startsWith(prefix)) continue;
				if (isExpired(map[key], now)) continue;
				const age = ageMs(map[key], now);
				if (age == null) continue;
				if (oldest == null || age > oldest) oldest = age;
			}
			return oldest;
		}
	};
	store.prune();
	return store;
}

//#endregion
export { DEFAULT_SESSION_TTL_MS, createSessionStore, defaultStatePath };