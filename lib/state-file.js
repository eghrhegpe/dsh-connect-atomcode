import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

//#region src/host/state-file.ts
/**
* state-file.ts — how this plugin writes a small JSON state file, in one place.
*
* `sessions.json` and `provider.json` used to each carry their own copy of the
* same three mechanisms (quarantine sweep, temp-file write, orphan reaping),
* byte-for-byte apart from the variable names. Two copies of a MECHANISM is how
* the copies drift: one gains a version guard, the other gains an EISDIR branch,
* and neither gains both.
*
* ## What belongs here, and what does not
*
* Here: the MECHANISM — durable-write plumbing that answers the same question
* for every caller ("how does a file get replaced atomically-ish, and how does
* a bad one get preserved instead of erased").
*
* NOT here: the SEMANTICS of any one file. What counts as a corrupt document,
* whether a `version` field gates the write, and whether the caller reports a
* named error or silently falls back to empty are decisions about the DATA, and
* they differ between the two stores on purpose — `provider.json` refuses to
* overwrite a shape written by a newer build, `sessions.json` has no version at
* all. Abstracting the read side would turn those decisions into boolean
* switches and flatten the one thing each file gets right. Mechanisms are
* duplicated code; semantics are not.
*
* So this module deliberately exposes verbs, not a base class: each store keeps
* its own `read`, and calls shared helpers for the parts where it has no opinion.
*
* ## Durability contract (shared, so it is stated once)
*
* Writes go to a pid+time-suffixed temp file and are renamed into place, with a
* direct write as fallback (rename can fail across devices or under an
* over-eager scanner). Two DSH profiles may share one file, so every caller
* re-reads before writing — see the caller's own notes on the residual
* read→rename window, which this module does NOT close (Node has no portable
* flock, and a lockfile spin is over-engineering for a few hundred bytes).
*
* @module dsh-atomcode-bridge/state-file
*/
/** How many `<path>.corrupt-<ts>` generations to keep for inspection. */
const KEEP_QUARANTINES = 2;
/** Orphan temp files younger than this may belong to a live writer — leave them. */
const ORPHAN_TMP_MIN_AGE_MS = 6e4;
/**
* Bound the growth of quarantine copies and orphaned temp files around one
* state file. Best-effort: every failure is swallowed, because a missing
* directory is the normal first-run case and a locked file is not worth
* failing a turn over.
*
* Callers run this once at store creation, which is enough — each host start
* clears whatever previous crashes left behind.
*
* @param {string} path - the state file whose neighbours should be reaped.
*/
function sweepStaleArtifacts(path) {
	try {
		const dir = dirname(path);
		const base = basename(path);
		const names = readdirSync(dir);
		const quarantines = names.filter((name) => name.startsWith(`${base}.corrupt-`)).sort();
		for (const stale of quarantines.slice(0, Math.max(0, quarantines.length - 2))) try {
			rmSync(join(dir, stale), { force: true });
		} catch {}
		for (const name of names) {
			if (!name.startsWith(`${base}.`) || !name.endsWith(".tmp")) continue;
			const full = join(dir, name);
			try {
				if (Date.now() - statSync(full).mtimeMs > 6e4) rmSync(full, { force: true });
			} catch {}
		}
	} catch {}
}
/**
* Preserve an unreadable file aside instead of letting the next write erase it:
* the bytes may still hold session ids a live conversation references.
*
* @param {string} path - file to move to `<path>.corrupt-<ts>`.
* @returns {boolean} true when the file was preserved (false = it could not be
*   moved; the caller decides whether that is reportable).
*/
function quarantineFile(path) {
	try {
		renameSync(path, `${path}.corrupt-${Date.now()}`);
		sweepStaleArtifacts(path);
		return true;
	} catch {
		return false;
	}
}
/**
* Replace `path` with `value` as one JSON document.
*
* @param {string} path - destination file.
* @param {unknown} value - anything JSON-serializable.
* @throws if the write itself fails — callers that treat state as optional
*   (the provider store) catch and convert this into a named error; callers
*   that treat it as required let it surface.
*/
function writeJsonFile(path, value) {
	const body = JSON.stringify(value, null, 2);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, body, "utf8");
	try {
		renameSync(tmp, path);
	} catch {
		writeFileSync(path, body, "utf8");
	}
}

//#endregion
export { sweepStaleArtifacts as n, writeJsonFile as r, quarantineFile as t };