/**
 * loopback.ts — "is this base_url a process on THIS machine?", asked once.
 *
 * Two halves need the same answer about the same string:
 *
 *  - the HOST, before spawning a review, decides whether to probe the endpoint
 *    first (a dead local proxy deserves a named diagnosis, not the CLI's bare
 *    `Cancelled`);
 *  - the RENDERER, when the user picks that entry, words the dependency warning
 *    ("评审经本机进程转发计费，它一停 review 立刻断").
 *
 * Those two used to be two hand-written copies of the same four-line predicate.
 * The copies agreed, which is exactly why nobody noticed — and the day one of
 * them learned about, say, `0.0.0.0` or a bracketed IPv6 form, the panel would
 * warn about an endpoint the host never probes (or stay silent about one it
 * does). This repository's rule is one fact, one place; a predicate shared by
 * two bundles is the case that rule exists for.
 *
 * ## Why not a `shared/` type-only module
 *
 * The client half is an IIFE (tsdown inlines this into `client.js`) and the host
 * half is ESM per source file (tsdown emits it as a shared chunk under `lib/`).
 * Both are build outputs of the same source, so the two halves cannot disagree
 * at runtime — which is the point.
 *
 * ## Scope
 *
 * Deliberately narrow: loopback by HOSTNAME, which is what the two callers mean.
 * A `base_url` of `https://gateway.example.com` is not local even if the machine
 * can reach it, so it is NOT this predicate's business. Anything unparseable is
 * NOT loopback — returning true there would produce warnings about endpoints
 * nobody can point at.
 *
 * @module dsh-connect-atomcode/shared/loopback
 */

/** Hostnames that mean "a process on this machine", never a remote host. */
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);

/**
 * @param {unknown} baseUrl - an OpenAI-compatible base_url, e.g. `http://127.0.0.1:8899/v1`.
 * @returns {boolean} true only for a parseable loopback URL.
 */
export function isLoopbackBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== 'string') return false;
  const trimmed = baseUrl.trim();
  if (trimmed === '') return false;
  try {
    const { hostname } = new URL(trimmed);
    if (LOOPBACK_HOSTS.has(hostname)) return true;
    // The whole `127.0.0.0/8` range is loopback, not just `127.0.0.1` — a
    // sidecar bound to 127.0.0.2 (or a proxy config that spells it that way) is
    // the same kind of dependency.
    return /^127\./.test(hostname);
  } catch {
    return false;
  }
}
