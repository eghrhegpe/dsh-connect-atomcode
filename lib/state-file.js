import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
* NOT here: the SEMANTICS of any one file — which fields exist, what each one
* accepts, and what the store does with a document it cannot read. `sessions.json`
* has no version at all and reads as a map; `provider.json` and
* `panel-settings.json` both carry a version guard but project DIFFERENT fields.
* Those projections stay in their own store.
*
* The line moved once, deliberately (2026-10-18): the two VERSIONED stores had
* grown byte-identical read skeletons — ENOENT / EISDIR / quarantine /
* JSON.parse / not-an-object / version-guard — plus write paths that mapped the
* same failures to the same machine-readable codes. A skeleton copied twice is
* how the copies drift (one gains an EISDIR branch, the other a wording fix),
* so the skeleton itself became verbs: `readVersionedDoc`, `writeVersionedDoc`,
* `foreignVersionRefusal`. Each store hands them its own version list, blank
* shape and field projection — the parts it genuinely owns.
*
* `sessions.json` is untouched by that move: its read side really is different
* (no version field, a map body), and forcing it through the same helper is the
* flattening this module's original note warned about.
*
* So this module still exposes verbs, not a base class: a store passes functions
* for the parts it owns, and shares only the parts where it has no opinion.
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
* @module dsh-connect-atomcode/state-file
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
/**
* Read one versioned JSON state document, with the whole failure ladder in one
* place: ENOENT reads as blank, EISDIR is named, an unreadable or unparseable
* file is preserved aside rather than erased (红线 3: never a silent empty read),
* and a version this build does not know reads as blank + `foreignVersion` so
* the write side can REFUSE to overwrite a newer shape.
*
* Never throws: a bad file is a reading with a reason, not an exception.
*
* @param {string} path - the state file.
* @param {VersionedReadOptions} options - the store's versions, blank shape and
*   field projection; this module supplies the surrounding ladder.
*/
function readVersionedDoc(path, options) {
	const { knownVersions, currentVersion, blank, project } = options;
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error && error.code === "ENOENT") return blank();
		if (error && error.code === "EISDIR") return blank("state path is a directory, not a file");
		return blank(quarantineFile(path) ? "unreadable state file was preserved aside" : "state file is unreadable and could not be preserved aside");
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return blank(quarantineFile(path) ? "corrupt state file was preserved aside" : "state file is not valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return blank("state file is not an object");
	const doc = parsed;
	const version = Number.isInteger(doc.version) ? doc.version : 0;
	if (!knownVersions.includes(version)) {
		const foreignVersion = version > currentVersion;
		return {
			...blank(foreignVersion ? `state file was written by a newer build (version ${version}, this build knows ${currentVersion})` : `state file version ${version} is not one this build can read`),
			version,
			foreignVersion
		};
	}
	return project(doc);
}
/**
* Refuse to overwrite a file written by a NEWER build. Returns `null` when the
* current reading is foreign-safe (the caller proceeds to write).
*
* The route layer maps `foreign-version` to a 409; matching on error TEXT is how
* a correct refusal gets reported as an unknown failure the day someone rewords
* the sentence, so the code travels separately from the sentence.
*/
function foreignVersionRefusal(current) {
	if (!current.foreignVersion) return null;
	return {
		ok: false,
		code: "foreign-version",
		error: current.error || `state file was written by a newer build (version ${current.version}); refusing to overwrite it`
	};
}
/**
* Write one versioned state document, mapping a failed write onto the shared
* `write-failed` code. Success reports `ok: true` with an empty code/error, so
* every caller can branch on the same shape.
*/
function writeVersionedDoc(path, doc) {
	try {
		writeJsonFile(path, doc);
	} catch (error) {
		return {
			ok: false,
			code: "write-failed",
			error: `could not write the state file: ${String(error && error.message ? error.message : error)}`
		};
	}
	return {
		ok: true,
		code: "",
		error: ""
	};
}

//#endregion
export { writeJsonFile as a, sweepStaleArtifacts as i, quarantineFile as n, writeVersionedDoc as o, readVersionedDoc as r, foreignVersionRefusal as t };