import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

//#region src/host/provider-store.ts
/**
* provider-store.ts — the plugin's OWN persisted model choice.
*
* Why this exists instead of "just edit cordis.patch.yml": the patch row is a
* config artifact — it needs a file opened, and it is only read at mount, so the
* panel cannot offer a choice that takes effect NOW. A small state file next to
* `sessions.json` gives the detail-page dropdown the durability the sibling
* `dsh-connect-sensenova-token-plan` panel has for its own switches (its
* provider/draw stores live under `$DSH_HOME/state/<plugin>/`), and it is read
* PER CALL, so a pick lands on the very next turn.
*
* ## What this file is NOT
*
* `~/.atomcode/config.toml` stays READ-ONLY for this plugin (AGENTS.md 红线 8).
* The dropdown pins which provider NAME the bridge ASKS FOR. It does not edit
* another application's configuration, and it does not change the default for
* every AtomCode client on the machine (that is a config.toml +
* `POST /config/reload` edit, which is not ours to make).
*
* ## Shared, not per-profile
*
* Sessions are keyed per profile because two profiles run two conversations.
* This is not a conversation fact: it is "which model do bridged turns on this
* machine ask for" — the same question the shared patch row already answers.
* Splitting it per profile would let the web and desktop hosts silently disagree
* about which model their own tool calls use, and the disagreement would only
* surface as a wrong-model reply. (Same reasoning the sibling plugin applies to
* its throttle: shared by design, do not "make it consistent" with the others.)
*
* Concurrency follows `sessions.js`: every mutation re-reads the file
* (read-modify-write), so one profile setting `ask` cannot clobber the other's
* `review`. It is NOT transactional (Node has no portable flock); the residual
* window is microseconds and the worst loss is one field reverting to "no pick",
* which degrades to the mount-time `default_provider` — bounded, never corrupt.
*
* ## Version guard (write side)
*
* A file whose `version` is NEWER than this build understands is FOREIGN: reads
* report no pick, and writes REFUSE. Without the guard, downgrading the plugin
* would overwrite the newer shape with ours, and the user's pick would vanish on
* the next upgrade with no trace.
*
* @module dsh-atomcode-bridge/provider-store
*/
/** Shape version this build writes. */
const PROVIDER_FILE_VERSION = 1;
/**
* Versions this build may READ and WRITE. Bumping PROVIDER_FILE_VERSION means
* adding the new number here too — otherwise this build refuses its own newest
* files. A number above the max was written by a NEWER build: read as "no pick",
* never overwritten.
*/
const KNOWN_PROVIDER_VERSIONS = [1];
/** The two slots, identical on the wire and on disk (红线 8: two namespaces). */
const PROVIDER_SLOTS = ["ask", "review"];
/** A name longer than this is junk, not a provider. */
const MAX_NAME_LEN = 200;
const KEEP_QUARANTINES = 2;
const ORPHAN_TMP_MIN_AGE_MS = 6e4;
/** @returns {string} default state file, next to sessions.json. */
function defaultProviderStatePath() {
	return join(homedir(), ".dsh", "state", "dsh-atomcode-bridge", "provider.json");
}
/**
* Normalize one incoming name. `null`/''/whitespace is a legitimate CLEAR, not
* an error — that is how "未插手" is expressed on the wire.
* @returns {{ok:boolean, value:string|null, error:string}}
*/
function normalizeProviderName(raw) {
	if (raw === null || raw === void 0) return {
		ok: true,
		value: null,
		error: ""
	};
	if (typeof raw !== "string") return {
		ok: false,
		value: null,
		error: `provider must be a string or null, got ${typeof raw}`
	};
	if (raw.trim() === "") return {
		ok: true,
		value: null,
		error: ""
	};
	const trimmed = raw.trim();
	if (trimmed.length > MAX_NAME_LEN) return {
		ok: false,
		value: null,
		error: `provider name is longer than ${MAX_NAME_LEN} characters`
	};
	if (trimmed.startsWith("-")) return {
		ok: false,
		value: null,
		error: "provider name must not start with \"-\" (the CLI argv would read it as an option, not as this option's value)"
	};
	if (Array.from(trimmed).some((ch) => (ch.codePointAt(0) ?? NaN) < 32 || (ch.codePointAt(0) ?? NaN) === 127)) return {
		ok: false,
		value: null,
		error: "provider name contains control characters"
	};
	return {
		ok: true,
		value: trimmed,
		error: ""
	};
}
/**
* @param {string} [path] state file path (injectable for tests)
*/
function createProviderStore(path = defaultProviderStatePath()) {
	/** Bound quarantine/temp churn. A missing directory is the normal first run. */
	function sweepStale() {
		try {
			const dir = dirname(path);
			const base = basename(path);
			const names = readdirSync(dir);
			const quarantines = names.filter((n) => n.startsWith(`${base}.corrupt-`)).sort();
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
	const blank = (error = "") => ({
		ask: null,
		review: null,
		foreignVersion: false,
		error
	});
	/**
	* The document as it sits on disk, or a neutral reading. Never throws: an
	* unparseable file is preserved aside (so a half-write is inspectable) and read
	* as "no pick" WITH a reason — the panel shows the reason rather than silently
	* claiming the user chose nothing (红线 3).
	*/
	function readDoc() {
		let raw;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			if (error && error.code === "ENOENT") return blank();
			if (error && error.code === "EISDIR") return blank("state path is a directory, not a file");
			try {
				renameSync(path, `${path}.corrupt-${Date.now()}`);
				sweepStale();
				return blank("unreadable state file was preserved aside");
			} catch {
				return blank("state file is unreadable and could not be preserved aside");
			}
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			try {
				renameSync(path, `${path}.corrupt-${Date.now()}`);
				sweepStale();
				return blank("corrupt state file was preserved aside");
			} catch {
				return blank("state file is not valid JSON");
			}
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return blank("state file is not an object");
		const version = Number.isInteger(parsed.version) ? parsed.version : 0;
		if (!KNOWN_PROVIDER_VERSIONS.includes(version)) return {
			...blank(version > 1 ? `state file was written by a newer build of this plugin (version ${version}, this build knows ${1})` : `state file version ${version} is not one this build can read`),
			version,
			foreignVersion: version > 1
		};
		const clean = (v) => {
			const n = normalizeProviderName(v);
			return n.ok ? n.value : null;
		};
		return {
			ask: clean(parsed.ask),
			review: clean(parsed.review),
			foreignVersion: false,
			error: ""
		};
	}
	function writeDoc(doc) {
		mkdirSync(dirname(path), { recursive: true });
		const body = JSON.stringify(doc, null, 2);
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, body, "utf8");
		try {
			renameSync(tmp, path);
		} catch {
			writeFileSync(path, body, "utf8");
		}
	}
	return {
		/** @returns {{ask:string|null, review:string|null, foreignVersion:boolean, error:string}} */
		read() {
			return readDoc();
		},
		/**
		* Set or clear one slot (`null`/'' = clear = 未插手). Re-reads first so the
		* OTHER slot — possibly owned by the other profile — survives this write.
		*
		* Refusals carry a machine-readable `code`, not just prose: the route maps
		* `foreign-version` to 409 and everything else to 500, and doing that by
		* matching the error TEXT is how a correct refusal gets reported as an unknown
		* failure the day someone rewords the sentence (the same "structure, not
		* wording" rule `lib/quota.js` is built on).
		*
		* @returns {{ok:boolean, value:string|null, error:string, code:string}}
		*/
		set(slot, name) {
			if (!PROVIDER_SLOTS.includes(slot)) return {
				ok: false,
				value: null,
				code: "unknown-slot",
				error: `unknown provider slot "${String(slot)}" (expected ${PROVIDER_SLOTS.join(" / ")})`
			};
			const normalized = normalizeProviderName(name);
			if (!normalized.ok) return {
				ok: false,
				value: null,
				code: "invalid-name",
				error: normalized.error
			};
			const current = readDoc();
			if (current.foreignVersion) return {
				ok: false,
				value: null,
				code: "foreign-version",
				error: current.error || `state file was written by a newer build of this plugin (version ${current.version}); refusing to overwrite it`
			};
			const doc = {
				version: 1,
				ask: current.ask,
				review: current.review,
				updatedAt: Date.now()
			};
			doc[slot] = normalized.value;
			try {
				writeDoc(doc);
			} catch (error) {
				return {
					ok: false,
					value: null,
					code: "write-failed",
					error: `could not write the state file: ${String(error && error.message ? error.message : error)}`
				};
			}
			return {
				ok: true,
				value: normalized.value,
				code: "",
				error: ""
			};
		},
		/** @returns {string} where the state lives (the panel names it). */
		path() {
			return path;
		}
	};
}

//#endregion
export { KNOWN_PROVIDER_VERSIONS, PROVIDER_FILE_VERSION, PROVIDER_SLOTS, createProviderStore, defaultProviderStatePath, normalizeProviderName };