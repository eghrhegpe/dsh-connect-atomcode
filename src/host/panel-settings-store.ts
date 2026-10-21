/**
 * panel-settings-store.ts — the plugin's OWN persisted panel-side overrides.
 *
 * Why this exists: `cordis.patch.yml` is a mount-time config artifact — it is
 * read once at `apply()`, baked into the tool registration closures, and only
 * re-read on a profile reload. That means a panel click cannot take effect
 * without a reload. A small state file next to `provider.json` gives the detail
 * page the ability to override the patch-only knobs — `review_brief_mode`,
 * `working_dir`, `approval_mode`, `ask_max_rounds` — that are read PER CALL, so
 * a pick lands on the very next turn.
 *
 * ## Ladders this store feeds
 *
 * - working_dir: args.working_dir > hostSessionCwd(exec) > panel pick >
 *   config.defaultWorkingDir > refuse (红线 8)
 * - review_brief_mode: panel pick > config.reviewBriefMode (mount-time)
 * - approval_mode / ask_max_rounds: panel pick > config value (mount-time)
 *
 * The panel pick is a single file with these four fields; a `null` field means
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
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  sweepStaleArtifacts,
  readVersionedDoc,
  writeVersionedDoc,
  foreignVersionRefusal,
} from './state-file.ts';
import { APPROVAL_MODES, REVIEW_BRIEF_MODES, ASK_MAX_ROUNDS_MIN, ASK_MAX_ROUNDS_MAX } from '../shared/closed-sets.ts';

/** Shape version this build writes. */
export const PANEL_SETTINGS_VERSION = 1;
/** Versions this build may read and write. */
export const KNOWN_PANEL_SETTINGS_VERSIONS = [PANEL_SETTINGS_VERSION];

/** The closed set `review_brief_mode` accepts (single source: shared/closed-sets.ts). */
export const PANEL_BRIEF_MODES = REVIEW_BRIEF_MODES;
export type PanelBriefMode = (typeof PANEL_BRIEF_MODES)[number];

/** The closed set `approval_mode` accepts (single source: shared/closed-sets.ts). */
export const PANEL_APPROVAL_MODES = APPROVAL_MODES;
export type PanelApprovalMode = (typeof PANEL_APPROVAL_MODES)[number];

/** A state-file reading. */
export interface PanelSettingsDoc {
  /** The panel's brief-mode override; `null` = no override, use the patch value. */
  briefMode: PanelBriefMode | null;
  /** The panel's working-dir override; `null`/'' = no override. */
  workingDir: string | null;
  /** The panel's approval-mode override; `null` = no override, use the patch value. */
  approvalMode: PanelApprovalMode | null;
  /** The panel's ask max-rounds override; `null` = no override, use the patch value. */
  askMaxRounds: number | null;
  foreignVersion: boolean;
  error: string;
  /** Present only when the file carried a version this build refuses. */
  version?: number;
}

/**
 * The closed set of field names the panel-settings write surface accepts.
 *
 * The route derives its POST whitelist from THIS list — it is the only place the
 * wire names are spelled out. It drifted once already: `approvalMode` and
 * `askMaxRounds` were normalized and stored by this store and POSTed one at a
 * time by the panel's two controls, but the route only forwarded `briefMode` and
 * `workingDir` — so those two controls answered 400 on every change from the day
 * they shipped, and no test caught it, because nothing exercised the write path.
 */
export const PANEL_SETTINGS_WRITABLE_FIELDS = [
  'briefMode',
  'workingDir',
  'approvalMode',
  'askMaxRounds',
] as const;

/** One writable field name. */
export type PanelSettingsField = (typeof PANEL_SETTINGS_WRITABLE_FIELDS)[number];

/** A partial write: present keys are updated, absent ones keep their value. */
export type PanelSettingsPatch = Partial<Record<PanelSettingsField, unknown>>;

/** Max length for a working directory path. */
const MAX_PATH_LEN = 1024;

/** @returns {string} default state file, next to provider.json. */
export function defaultPanelSettingsPath(): string {
  return join(homedir(), '.dsh', 'state', 'dsh-connect-atomcode', 'panel-settings.json');
}

/**
 * Normalize a brief-mode value. `null`/`''` clears the override.
 * @returns {{ok: boolean, value: PanelBriefMode | null, error: string}}
 */
export function normalizeBriefMode(raw: unknown) {
  if (raw === null || raw === undefined) return { ok: true, value: null, error: '' };
  if (typeof raw !== 'string') {
    return { ok: false, value: null, error: `briefMode must be a string or null, got ${typeof raw}` };
  }
  if (raw.trim() === '') return { ok: true, value: null, error: '' };
  const trimmed = raw.trim();
  if (!(PANEL_BRIEF_MODES as readonly string[]).includes(trimmed)) {
    return {
      ok: false,
      value: null,
      error: `briefMode must be one of ${PANEL_BRIEF_MODES.join(' / ')}, got "${trimmed}"`,
    };
  }
  return { ok: true, value: trimmed as PanelBriefMode, error: '' };
}

/**
 * Normalize a working-dir value. `null`/`''` clears the override.
 * @returns {{ok: boolean, value: string | null, error: string}}
 */
export function normalizeWorkingDir(raw: unknown) {
  if (raw === null || raw === undefined) return { ok: true, value: null, error: '' };
  if (typeof raw !== 'string') {
    return { ok: false, value: null, error: `workingDir must be a string or null, got ${typeof raw}` };
  }
  if (raw.trim() === '') return { ok: true, value: null, error: '' };
  const trimmed = raw.trim();
  if (trimmed.length > MAX_PATH_LEN) {
    return { ok: false, value: null, error: `workingDir is longer than ${MAX_PATH_LEN} characters` };
  }
  if (Array.from(trimmed).some((ch) => (ch.codePointAt(0) ?? NaN) < 0x20 || (ch.codePointAt(0) ?? NaN) === 0x7f)) {
    return { ok: false, value: null, error: 'workingDir contains control characters' };
  }
  return { ok: true, value: trimmed, error: '' };
}

/**
 * Normalize an approval-mode value. `null`/`''` clears the override.
 * @returns {{ok: boolean, value: PanelApprovalMode | null, error: string}}
 */
export function normalizeApprovalMode(raw: unknown) {
  if (raw === null || raw === undefined) return { ok: true, value: null, error: '' };
  if (typeof raw !== 'string') {
    return { ok: false, value: null, error: `approvalMode must be a string or null, got ${typeof raw}` };
  }
  if (raw.trim() === '') return { ok: true, value: null, error: '' };
  const trimmed = raw.trim();
  if (!(PANEL_APPROVAL_MODES as readonly string[]).includes(trimmed)) {
    return {
      ok: false,
      value: null,
      error: `approvalMode must be one of ${PANEL_APPROVAL_MODES.join(' / ')}, got "${trimmed}"`,
    };
  }
  return { ok: true, value: trimmed as PanelApprovalMode, error: '' };
}

/**
 * Normalize an ask max-rounds value. `null` clears the override.
 * Must be 0 (no fuse) or a positive integer up to 1000.
 * @returns {{ok: boolean, value: number | null, error: string}}
 */
export function normalizeAskMaxRounds(raw: unknown) {
  if (raw === null || raw === undefined) return { ok: true, value: null, error: '' };
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, value: null, error: `askMaxRounds must be an integer (0 = unlimited), got ${typeof raw}` };
  }
  if (raw < ASK_MAX_ROUNDS_MIN || raw > ASK_MAX_ROUNDS_MAX) {
    return {
      ok: false,
      value: null,
      error: `askMaxRounds must be ${ASK_MAX_ROUNDS_MIN}-${ASK_MAX_ROUNDS_MAX}, got ${raw}`,
    };
  }
  return { ok: true, value: raw, error: '' };
}

/**
 * @param {string} [path] state file path (injectable for tests)
 */
export function createPanelSettingsStore(path: string = defaultPanelSettingsPath()) {
  sweepStaleArtifacts(path);

  /**
   * Read the document from disk. Never throws. The failure ladder (ENOENT /
   * EISDIR / quarantine / version guard) is shared with `provider.json` in
   * `state-file.ts`; what stays here is this file's own four-field projection.
   */
  function readDoc(): PanelSettingsDoc {
    return readVersionedDoc<PanelSettingsDoc>(path, {
      knownVersions: KNOWN_PANEL_SETTINGS_VERSIONS,
      currentVersion: PANEL_SETTINGS_VERSION,
      blank: (error = ''): PanelSettingsDoc => ({
        briefMode: null,
        workingDir: null,
        approvalMode: null,
        askMaxRounds: null,
        foreignVersion: false,
        error,
      }),
      project: (doc) => {
        const brief = normalizeBriefMode(doc.briefMode);
        const dir = normalizeWorkingDir(doc.workingDir);
        const approval = normalizeApprovalMode(doc.approvalMode);
        const rounds = normalizeAskMaxRounds(doc.askMaxRounds);
        return {
          briefMode: brief.ok ? brief.value : null,
          workingDir: dir.ok ? dir.value : null,
          approvalMode: approval.ok ? approval.value : null,
          askMaxRounds: rounds.ok ? rounds.value : null,
          foreignVersion: false,
          error: '',
        };
      },
    });
  }

  return {
    /** @returns {PanelSettingsDoc} the current document on disk. */
    read(): PanelSettingsDoc {
      return readDoc();
    },

    /**
     * Set or clear one or more fields. Re-reads first so a concurrent write is
     * not clobbered.
     *
     * The accepted names ARE `PANEL_SETTINGS_WRITABLE_FIELDS` — the route
     * forwards from that same list, so a name this store cannot write is a
     * 400 on the wire and never reaches here.
     *
     * @param {PanelSettingsPatch} fields - present keys are updated; absent ones
     *   keep their current value.
     * @returns {{ok: boolean, code: string, error: string}}
     */
    set(fields: PanelSettingsPatch) {
      const current = readDoc();
      const refusal = foreignVersionRefusal(current);
      if (refusal) return refusal;
      let newBrief = current.briefMode;
      let newDir = current.workingDir;
      let newApproval = current.approvalMode;
      let newRounds = current.askMaxRounds;
      if (Object.prototype.hasOwnProperty.call(fields, 'briefMode')) {
        const norm = normalizeBriefMode(fields.briefMode);
        if (!norm.ok) return { ok: false, code: 'invalid-brief-mode', error: norm.error };
        newBrief = norm.value;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'workingDir')) {
        const norm = normalizeWorkingDir(fields.workingDir);
        if (!norm.ok) return { ok: false, code: 'invalid-working-dir', error: norm.error };
        newDir = norm.value;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'approvalMode')) {
        const norm = normalizeApprovalMode(fields.approvalMode);
        if (!norm.ok) return { ok: false, code: 'invalid-approval-mode', error: norm.error };
        newApproval = norm.value;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'askMaxRounds')) {
        const norm = normalizeAskMaxRounds(fields.askMaxRounds);
        if (!norm.ok) return { ok: false, code: 'invalid-ask-max-rounds', error: norm.error };
        newRounds = norm.value;
      }
      const written = writeVersionedDoc(path, {
        version: PANEL_SETTINGS_VERSION,
        briefMode: newBrief,
        workingDir: newDir,
        approvalMode: newApproval,
        askMaxRounds: newRounds,
        updatedAt: Date.now(),
      });
      if (!written.ok) return written;
      return { ok: true, code: '', error: '' };
    },

    /** @returns {string} where the state lives. */
    path(): string {
      return path;
    },
  };
}

/** The store type exported for the runtime. */
export type PanelSettingsStore = ReturnType<typeof createPanelSettingsStore>;
