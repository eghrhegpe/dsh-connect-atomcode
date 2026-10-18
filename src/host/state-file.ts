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
import { mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** How many `<path>.corrupt-<ts>` generations to keep for inspection. */
export const KEEP_QUARANTINES = 2;
/** Orphan temp files younger than this may belong to a live writer — leave them. */
export const ORPHAN_TMP_MIN_AGE_MS = 60_000;

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
export function sweepStaleArtifacts(path: string): void {
  try {
    const dir = dirname(path);
    const base = basename(path);
    const names = readdirSync(dir);
    const quarantines = names
      .filter((name) => name.startsWith(`${base}.corrupt-`))
      .sort(); // the epoch-ms suffix makes lexicographic order chronological
    for (const stale of quarantines.slice(0, Math.max(0, quarantines.length - KEEP_QUARANTINES))) {
      try {
        rmSync(join(dir, stale), { force: true });
      } catch {
        /* best-effort */
      }
    }
    for (const name of names) {
      if (!name.startsWith(`${base}.`) || !name.endsWith('.tmp')) continue;
      const full = join(dir, name);
      try {
        // Only reclaim clearly-abandoned files: a fresh one may still be a live
        // writer's in-flight temp awaiting its rename.
        if (Date.now() - statSync(full).mtimeMs > ORPHAN_TMP_MIN_AGE_MS) rmSync(full, { force: true });
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* a missing directory is the normal first-run case */
  }
}

/**
 * Preserve an unreadable file aside instead of letting the next write erase it:
 * the bytes may still hold session ids a live conversation references.
 *
 * @param {string} path - file to move to `<path>.corrupt-<ts>`.
 * @returns {boolean} true when the file was preserved (false = it could not be
 *   moved; the caller decides whether that is reportable).
 */
export function quarantineFile(path: string): boolean {
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
export function writeJsonFile(path: string, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  mkdirSync(dirname(path), { recursive: true });
  // pid+time suffix: two writers never share one temp path.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  try {
    renameSync(tmp, path);
  } catch {
    // Cross-device rename, or a scanner holding the target: the temp write is
    // already durable, so writing the destination directly is the better
    // fallback than losing the update.
    writeFileSync(path, body, 'utf8');
  }
}

/** The read shape every versioned store shares: a named reason, plus "foreign". */
export interface VersionedReading {
  foreignVersion: boolean;
  error: string;
  /** Present only when the file carried a version this build refuses to use. */
  version?: number;
}

/** What a store hands `readVersionedDoc`: the parts it owns. */
export interface VersionedReadOptions<T extends VersionedReading> {
  /** Versions this build may read and write. */
  knownVersions: readonly number[];
  /** Shape version this build writes (drives the "newer build" branch). */
  currentVersion: number;
  /** The neutral reading — every field unset, `error` as given. */
  blank: (error?: string) => T;
  /** Project a parsed document of a KNOWN version onto the reading shape. */
  project: (doc: Record<string, unknown>) => T;
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
export function readVersionedDoc<T extends VersionedReading>(path: string, options: VersionedReadOptions<T>): T {
  const { knownVersions, currentVersion, blank, project } = options;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error: any) {
    if (error && error.code === 'ENOENT') return blank();
    if (error && error.code === 'EISDIR') return blank('state path is a directory, not a file');
    return blank(
      quarantineFile(path)
        ? 'unreadable state file was preserved aside'
        : 'state file is unreadable and could not be preserved aside',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return blank(quarantineFile(path) ? 'corrupt state file was preserved aside' : 'state file is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return blank('state file is not an object');
  const doc = parsed as Record<string, unknown>;
  const version = Number.isInteger(doc.version) ? (doc.version as number) : 0;
  if (!knownVersions.includes(version)) {
    // Two different situations share this branch: a NEWER build wrote it (never
    // overwrite — the user's pick would vanish on the next upgrade) and an older
    // / unknown number we simply do not understand. Only the first is "foreign".
    const foreignVersion = version > currentVersion;
    return {
      ...blank(
        foreignVersion
          ? `state file was written by a newer build (version ${version}, this build knows ${currentVersion})`
          : `state file version ${version} is not one this build can read`,
      ),
      version,
      foreignVersion,
    };
  }
  return project(doc);
}

/** What a refused or failed write reports: a machine-readable code, not prose. */
export interface WriteRefusal {
  ok: false;
  code: string;
  error: string;
}

/**
 * Refuse to overwrite a file written by a NEWER build. Returns `null` when the
 * current reading is foreign-safe (the caller proceeds to write).
 *
 * The route layer maps `foreign-version` to a 409; matching on error TEXT is how
 * a correct refusal gets reported as an unknown failure the day someone rewords
 * the sentence, so the code travels separately from the sentence.
 */
export function foreignVersionRefusal(current: VersionedReading): WriteRefusal | null {
  if (!current.foreignVersion) return null;
  return {
    ok: false,
    code: 'foreign-version',
    error:
      current.error || `state file was written by a newer build (version ${current.version}); refusing to overwrite it`,
  };
}

/**
 * Write one versioned state document, mapping a failed write onto the shared
 * `write-failed` code. Success reports `ok: true` with an empty code/error, so
 * every caller can branch on the same shape.
 */
export function writeVersionedDoc(
  path: string,
  doc: Record<string, unknown>,
): { ok: true; code: ''; error: '' } | WriteRefusal {
  try {
    writeJsonFile(path, doc);
  } catch (error: any) {
    return {
      ok: false,
      code: 'write-failed',
      error: `could not write the state file: ${String(error && error.message ? error.message : error)}`,
    };
  }
  return { ok: true, code: '', error: '' };
}
