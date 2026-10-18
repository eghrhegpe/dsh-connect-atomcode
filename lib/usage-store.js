import { a as writeJsonFile, i as sweepStaleArtifacts, n as quarantineFile } from "./state-file.js";
import { readFileSync } from "node:fs";

//#region src/host/usage-store.ts
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
/** Shape this build writes. Bump only when the on-disk shape changes. */
const USAGE_FILE_VERSION = 1;
/** The zeroed reading, also what a missing file means. */
function emptyAskUsage() {
	return {
		calls: 0,
		ok: 0,
		err: 0,
		msTotal: 0,
		tokens: 0
	};
}
function createUsageStore(path, onError) {
	sweepStaleArtifacts(path);
	/** Degrade to zeroes AND name the reason (红线 3: silence reads as "no usage"). */
	const degraded = (message) => {
		if (typeof onError === "function") onError(message);
		return emptyAskUsage();
	};
	/**
	* The counters as they sit on disk, or a neutral reading. Never throws.
	* An unparseable file is preserved aside (so a half-write is inspectable)
	* and read as zeroes WITH the reason.
	*/
	function read() {
		let raw;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			if (error && error.code === "ENOENT") return emptyAskUsage();
			if (error && error.code === "EISDIR") return degraded("usage state path is a directory, not a file");
			return degraded(quarantineFile(path) ? "usage state file was unreadable and preserved aside" : "usage state file is unreadable and could not be preserved aside");
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return degraded(quarantineFile(path) ? "usage state file was corrupt and preserved aside" : "usage state file is not valid JSON");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return degraded("usage state file is not an object");
		const version = Number.isInteger(parsed.version) ? parsed.version : 0;
		if (version > 1) return degraded(`usage state was written by a newer build of this plugin (version ${version}, this build knows ${1})`);
		const doc = parsed.ask;
		if (!doc || typeof doc !== "object" || Array.isArray(doc)) return emptyAskUsage();
		const num = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
		return {
			calls: num(doc.calls),
			ok: num(doc.ok),
			err: num(doc.err),
			msTotal: num(doc.msTotal),
			tokens: num(doc.tokens)
		};
	}
	/** The on-disk `version` field, or 0 when there is no readable document. */
	function diskVersion() {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
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
	function write(counters) {
		const version = diskVersion();
		if (version > 1) {
			degraded(`usage state was written by a newer build of this plugin (version ${version}, this build knows ${1}); refusing to overwrite it`);
			return;
		}
		writeJsonFile(path, {
			version: 1,
			ask: {
				calls: counters.calls,
				ok: counters.ok,
				err: counters.err,
				msTotal: counters.msTotal,
				tokens: counters.tokens
			},
			updatedAt: Date.now()
		});
	}
	return {
		read,
		write,
		path: () => path
	};
}

//#endregion
export { USAGE_FILE_VERSION, createUsageStore, emptyAskUsage };