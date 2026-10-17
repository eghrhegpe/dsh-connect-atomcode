import { n as sweepStaleArtifacts, r as writeJsonFile, t as quarantineFile } from "./state-file.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

//#region src/host/panel-settings-store.ts
/**
* panel-settings-store.ts — the plugin's OWN persisted panel-side overrides.
*
* Why this exists: `cordis.patch.yml` is a mount-time config artifact — it is
* read once at `apply()`, baked into the tool registration closures, and only
* re-read on a profile reload. That means a panel click cannot take effect
* without a reload. A small state file next to `provider.json` gives the detail
* page the ability to override two patch-only knobs (review_brief_mode,
* working_dir) that are read PER CALL, so a pick lands on the very next turn.
*
* ## Ladders this store feeds
*
* - working_dir: args.working_dir > hostSessionCwd(exec) > panel pick >
*   config.defaultWorkingDir > refuse (红线 8)
* - review_brief_mode: panel pick > config.reviewBriefMode (mount-time)
*
* The panel pick is ALWAYS a single file with two fields; a `null` field means
* "no override, fall through to the patch value".
*
* ## Shared, not per-profile
*
* Same reasoning as `provider.json`: "which brief mode does the user prefer" is
* not a conversation fact — it is a machine-level preference. Splitting per
* profile would let two hosts disagree and the disagreement would only surface
* as a different prompt shape.
*
* ## Version guard
*
* Mirrors `provider.json`: a file written by a NEWER build is refused (never
* overwritten); an unknown older number is read as empty.
*
* @module dsh-connect-atomcode/host/panel-settings-store
*/
/** Shape version this build writes. */
const PANEL_SETTINGS_VERSION = 1;
/** Versions this build may read and write. */
const KNOWN_PANEL_SETTINGS_VERSIONS = [1];
/** The closed set `review_brief_mode` accepts (mirrors config.ts). */
const PANEL_BRIEF_MODES = [
	"always",
	"when-empty",
	"never"
];
/** The closed set `approval_mode` accepts (mirrors config.ts APPROVAL_MODES). */
const PANEL_APPROVAL_MODES = [
	"build",
	"accept_edits",
	"bypass",
	"plan"
];
/** Max length for a working directory path. */
const MAX_PATH_LEN = 1024;
/** @returns {string} default state file, next to provider.json. */
function defaultPanelSettingsPath() {
	return join(homedir(), ".dsh", "state", "dsh-connect-atomcode", "panel-settings.json");
}
/**
* Normalize a brief-mode value. `null`/`''` clears the override.
* @returns {{ok: boolean, value: PanelBriefMode | null, error: string}}
*/
function normalizeBriefMode(raw) {
	if (raw === null || raw === void 0) return {
		ok: true,
		value: null,
		error: ""
	};
	if (typeof raw !== "string") return {
		ok: false,
		value: null,
		error: `briefMode must be a string or null, got ${typeof raw}`
	};
	if (raw.trim() === "") return {
		ok: true,
		value: null,
		error: ""
	};
	const trimmed = raw.trim();
	if (!PANEL_BRIEF_MODES.includes(trimmed)) return {
		ok: false,
		value: null,
		error: `briefMode must be one of ${PANEL_BRIEF_MODES.join(" / ")}, got "${trimmed}"`
	};
	return {
		ok: true,
		value: trimmed,
		error: ""
	};
}
/**
* Normalize a working-dir value. `null`/`''` clears the override.
* @returns {{ok: boolean, value: string | null, error: string}}
*/
function normalizeWorkingDir(raw) {
	if (raw === null || raw === void 0) return {
		ok: true,
		value: null,
		error: ""
	};
	if (typeof raw !== "string") return {
		ok: false,
		value: null,
		error: `workingDir must be a string or null, got ${typeof raw}`
	};
	if (raw.trim() === "") return {
		ok: true,
		value: null,
		error: ""
	};
	const trimmed = raw.trim();
	if (trimmed.length > MAX_PATH_LEN) return {
		ok: false,
		value: null,
		error: `workingDir is longer than ${MAX_PATH_LEN} characters`
	};
	if (Array.from(trimmed).some((ch) => (ch.codePointAt(0) ?? NaN) < 32 || (ch.codePointAt(0) ?? NaN) === 127)) return {
		ok: false,
		value: null,
		error: "workingDir contains control characters"
	};
	return {
		ok: true,
		value: trimmed,
		error: ""
	};
}
/**
* Normalize an approval-mode value. `null`/`''` clears the override.
* @returns {{ok: boolean, value: PanelApprovalMode | null, error: string}}
*/
function normalizeApprovalMode(raw) {
	if (raw === null || raw === void 0) return {
		ok: true,
		value: null,
		error: ""
	};
	if (typeof raw !== "string") return {
		ok: false,
		value: null,
		error: `approvalMode must be a string or null, got ${typeof raw}`
	};
	if (raw.trim() === "") return {
		ok: true,
		value: null,
		error: ""
	};
	const trimmed = raw.trim();
	if (!PANEL_APPROVAL_MODES.includes(trimmed)) return {
		ok: false,
		value: null,
		error: `approvalMode must be one of ${PANEL_APPROVAL_MODES.join(" / ")}, got "${trimmed}"`
	};
	return {
		ok: true,
		value: trimmed,
		error: ""
	};
}
/**
* Normalize an ask max-rounds value. `null` clears the override.
* Must be 0 (no fuse) or a positive integer up to 1000.
* @returns {{ok: boolean, value: number | null, error: string}}
*/
function normalizeAskMaxRounds(raw) {
	if (raw === null || raw === void 0) return {
		ok: true,
		value: null,
		error: ""
	};
	if (typeof raw !== "number" || !Number.isInteger(raw)) return {
		ok: false,
		value: null,
		error: `askMaxRounds must be an integer (0 = unlimited), got ${typeof raw}`
	};
	if (raw < 0 || raw > 1e3) return {
		ok: false,
		value: null,
		error: `askMaxRounds must be 0-1000, got ${raw}`
	};
	return {
		ok: true,
		value: raw,
		error: ""
	};
}
/**
* @param {string} [path] state file path (injectable for tests)
*/
function createPanelSettingsStore(path = defaultPanelSettingsPath()) {
	sweepStaleArtifacts(path);
	const blank = (error = "") => ({
		briefMode: null,
		workingDir: null,
		approvalMode: null,
		askMaxRounds: null,
		foreignVersion: false,
		error
	});
	/** Read the document from disk. Never throws. */
	function readDoc() {
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
		const version = Number.isInteger(parsed.version) ? parsed.version : 0;
		if (!KNOWN_PANEL_SETTINGS_VERSIONS.includes(version)) return {
			...blank(version > 1 ? `state file was written by a newer build (version ${version}, this build knows ${1})` : `state file version ${version} is not one this build can read`),
			version,
			foreignVersion: version > 1
		};
		const brief = normalizeBriefMode(parsed.briefMode);
		const dir = normalizeWorkingDir(parsed.workingDir);
		const approval = normalizeApprovalMode(parsed.approvalMode);
		const rounds = normalizeAskMaxRounds(parsed.askMaxRounds);
		return {
			briefMode: brief.ok ? brief.value : null,
			workingDir: dir.ok ? dir.value : null,
			approvalMode: approval.ok ? approval.value : null,
			askMaxRounds: rounds.ok ? rounds.value : null,
			foreignVersion: false,
			error: ""
		};
	}
	function writeDoc(doc) {
		writeJsonFile(path, doc);
	}
	return {
		/** @returns {PanelSettingsDoc} the current document on disk. */
		read() {
			return readDoc();
		},
		/**
		* Set or clear one or both fields. Re-reads first so a concurrent write is
		* not clobbered.
		*
		* @param {object} fields - `{ briefMode?, workingDir?, approvalMode?, askMaxRounds? }`.
		*   Only the fields present in the object are updated; others keep their current value.
		* @returns {{ok: boolean, code: string, error: string}}
		*/
		set(fields) {
			const current = readDoc();
			if (current.foreignVersion) return {
				ok: false,
				code: "foreign-version",
				error: current.error || `state file was written by a newer build (version ${current.version}); refusing to overwrite it`
			};
			let newBrief = current.briefMode;
			let newDir = current.workingDir;
			let newApproval = current.approvalMode;
			let newRounds = current.askMaxRounds;
			if (Object.prototype.hasOwnProperty.call(fields, "briefMode")) {
				const norm = normalizeBriefMode(fields.briefMode);
				if (!norm.ok) return {
					ok: false,
					code: "invalid-brief-mode",
					error: norm.error
				};
				newBrief = norm.value;
			}
			if (Object.prototype.hasOwnProperty.call(fields, "workingDir")) {
				const norm = normalizeWorkingDir(fields.workingDir);
				if (!norm.ok) return {
					ok: false,
					code: "invalid-working-dir",
					error: norm.error
				};
				newDir = norm.value;
			}
			if (Object.prototype.hasOwnProperty.call(fields, "approvalMode")) {
				const norm = normalizeApprovalMode(fields.approvalMode);
				if (!norm.ok) return {
					ok: false,
					code: "invalid-approval-mode",
					error: norm.error
				};
				newApproval = norm.value;
			}
			if (Object.prototype.hasOwnProperty.call(fields, "askMaxRounds")) {
				const norm = normalizeAskMaxRounds(fields.askMaxRounds);
				if (!norm.ok) return {
					ok: false,
					code: "invalid-ask-max-rounds",
					error: norm.error
				};
				newRounds = norm.value;
			}
			const doc = {
				version: 1,
				briefMode: newBrief,
				workingDir: newDir,
				approvalMode: newApproval,
				askMaxRounds: newRounds,
				updatedAt: Date.now()
			};
			try {
				writeDoc(doc);
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
		},
		/** @returns {string} where the state lives. */
		path() {
			return path;
		}
	};
}

//#endregion
export { KNOWN_PANEL_SETTINGS_VERSIONS, PANEL_APPROVAL_MODES, PANEL_BRIEF_MODES, PANEL_SETTINGS_VERSION, createPanelSettingsStore, defaultPanelSettingsPath, normalizeApprovalMode, normalizeAskMaxRounds, normalizeBriefMode, normalizeWorkingDir };