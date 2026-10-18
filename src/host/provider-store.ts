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
 * (read-modify-write), so a web host and a desktop host writing at the same time
 * cannot clobber each other's pick. It is NOT transactional (Node has no portable
 * flock); the residual window is microseconds and the worst loss is one field
 * reverting to "no pick", which degrades to the mount-time `default_provider` —
 * bounded, never corrupt.
 *
 * ## Version guard (write side)
 *
 * A file whose `version` is NEWER than this build understands is FOREIGN: reads
 * report no pick, and writes REFUSE. Without the guard, downgrading the plugin
 * would overwrite the newer shape with ours, and the user's pick would vanish on
 * the next upgrade with no trace.
 *
 * @module dsh-connect-atomcode/provider-store
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  sweepStaleArtifacts,
  readVersionedDoc,
  writeVersionedDoc,
  foreignVersionRefusal,
} from './state-file.ts';

/** Shape version this build writes. */
export const PROVIDER_FILE_VERSION = 1;
/**
 * Versions this build may READ and WRITE. Bumping PROVIDER_FILE_VERSION means
 * adding the new number here too — otherwise this build refuses its own newest
 * files. A number above the max was written by a NEWER build: read as "no pick",
 * never overwritten.
 */
export const KNOWN_PROVIDER_VERSIONS = [PROVIDER_FILE_VERSION];

/**
 * One slot, both on the wire and on disk. It used to be TWO (`ask` and
 * `review`) for two different provider namespaces — 红线 8 — until the review
 * CLI was deleted and every entry point started asking the daemon for the same
 * model profiles. One question remains ("which profile do bridged turns use")
 * and it has one answer.
 */
export const PROVIDER_SLOT = 'ask';

/** One state-file reading: the pick as this build reads it, plus why. */
export interface ProviderDoc {
  ask: string | null;
  foreignVersion: boolean;
  error: string;
  /** Present only when the file carried a version this build refuses to use. */
  version?: number;
}

/** A name longer than this is junk, not a provider. */
const MAX_NAME_LEN = 200;

/** @returns {string} default state file, next to sessions.json. */
export function defaultProviderStatePath(): string {
  return join(homedir(), '.dsh', 'state', 'dsh-connect-atomcode', 'provider.json');
}

/**
 * Normalize one incoming name. `null`/''/whitespace is a legitimate CLEAR, not
 * an error — that is how "未插手" is expressed on the wire.
 * @returns {{ok:boolean, value:string|null, error:string}}
 */
export function normalizeProviderName(raw: unknown) {
  if (raw === null || raw === undefined) return { ok: true, value: null, error: '' };
  if (typeof raw !== 'string') {
    return { ok: false, value: null, error: `provider must be a string or null, got ${typeof raw}` };
  }
  if (raw.trim() === '') return { ok: true, value: null, error: '' };
  const trimmed = raw.trim();
  if (trimmed.length > MAX_NAME_LEN) {
    return { ok: false, value: null, error: `provider name is longer than ${MAX_NAME_LEN} characters` };
  }
  // The name is forwarded VERBATIM as the ask body's `provider` field. The write
  // endpoint accepts any string, so a value like `--no-web` would travel as a
  // trusted identifier. No real provider name starts with a dash;
  // refuse HERE (a named write error on the panel) rather than let the CLI
  // guess, which surfaces as an unrelated flag error three layers away.
  if (trimmed.startsWith('-')) {
    return { ok: false, value: null, error: 'provider name must not start with "-" (the CLI argv would read it as an option, not as this option\'s value)' };
  }
  // A control character here would ride straight into the daemon's JSON body or
  // a CLI argv; no legitimate provider name contains one.
  if (Array.from(trimmed).some((ch) => (ch.codePointAt(0) ?? NaN) < 0x20 || (ch.codePointAt(0) ?? NaN) === 0x7f)) {
    return { ok: false, value: null, error: 'provider name contains control characters' };
  }
  return { ok: true, value: trimmed, error: '' };
}

/**
 * @param {string} [path] state file path (injectable for tests)
 */
export function createProviderStore(path: string = defaultProviderStatePath()) {
  // Shared with sessions.json now (see state-file.ts) — this was a verbatim
  // copy of the same loop, and the copy is where drift hides.
  sweepStaleArtifacts(path);

  /**
   * The document as it sits on disk, or a neutral reading. Never throws: an
   * unparseable file is preserved aside (so a half-write is inspectable) and read
   * as "no pick" WITH a reason — the panel shows the reason rather than silently
   * claiming the user chose nothing (红线 3).
   *
   * The failure ladder itself lives in `state-file.ts` (shared with
   * panel-settings.json); this store supplies only what is ITS own: the version
   * list it accepts, the neutral shape, and how one field is projected.
   */
  function readDoc(): ProviderDoc {
    return readVersionedDoc<ProviderDoc>(path, {
      knownVersions: KNOWN_PROVIDER_VERSIONS,
      currentVersion: PROVIDER_FILE_VERSION,
      blank: (error = '') => ({ ask: null, foreignVersion: false, error }),
      project: (doc) => {
        const clean = (v: unknown) => {
          const n = normalizeProviderName(v);
          return n.ok ? n.value : null;
        };
        return { ask: clean(doc.ask), foreignVersion: false, error: '' };
      },
    });
  }

  return {
    /** @returns {{ask:string|null, foreignVersion:boolean, error:string}} */
    read(): ProviderDoc {
      return readDoc();
    },
    /**
     * Set or clear the one slot (`null`/'' = clear = 未插手). Re-reads first so a
     * concurrent write is not clobbered.
     *
     * `slot` is still taken and checked rather than dropped: the wire has always
     * carried it, and an old client posting the review namespace must get a
     * named refusal, not a write that lands somewhere unexpected.
     *
     * Refusals carry a machine-readable `code`, not just prose: the route maps
     * `foreign-version` to 409 and everything else to 500, and doing that by
     * matching the error TEXT is how a correct refusal gets reported as an unknown
     * failure the day someone rewords the sentence (the same "structure, not
     * wording" rule `lib/quota.js` is built on).
     *
     * @returns {{ok:boolean, value:string|null, error:string, code:string}}
     */
    set(slot: string, name: unknown) {
      if (slot !== PROVIDER_SLOT) {
        return {
          ok: false,
          value: null,
          code: 'unknown-slot',
          error: `unknown provider slot "${String(slot)}" (expected ${PROVIDER_SLOT} — the second namespace died with the review CLI)`,
        };
      }
      const normalized = normalizeProviderName(name);
      if (!normalized.ok) return { ok: false, value: null, code: 'invalid-name', error: normalized.error };
      const current = readDoc();
      const refusal = foreignVersionRefusal(current);
      if (refusal) return { ...refusal, value: null };
      const written = writeVersionedDoc(path, {
        version: PROVIDER_FILE_VERSION,
        ask: normalized.value,
        updatedAt: Date.now(),
      });
      if (!written.ok) return { ok: false, value: null, code: written.code, error: written.error };
      return { ok: true, value: normalized.value, code: '', error: '' };
    },
    /** @returns {string} where the state lives (the panel names it). */
    path() {
      return path;
    },
  };
}
