/**
 * dead-port.mjs — one "nothing is listening here" SENTINEL port, per use site.
 *
 * Why this file exists. Suites each used to hardcode their own sentinel, and two
 * of them (`protocol` and `review`) picked THE SAME NUMBER independently; the
 * runner then serialized every suite to dodge that collision — a fixture defect
 * disciplined into policy. Worse, all those sentinels sat in the 459xx band,
 * which is INSIDE the OS dynamic port range (Linux assigns 32768–60999 to
 * `listen(0)`; Windows 49152–65535). Under any parallelism a concurrent
 * binder's ephemeral port could BE the sentinel another suite believes is dead:
 * "nothing listens here" was an assumption, and the assumption was occasionally
 * false — in the very direction that turns a refusal assertion into a green lie.
 *
 * The rules this file encodes:
 *  - ONE base port (default 21190; `ATOMCODE_TEST_PORT_BASE` shifts the whole
 *    band on a machine where something real lives there), refused outright
 *    when malformed — a silent fallback would re-collide two suites, the exact
 *    failure this helper exists to make impossible;
 *  - one integer offset per use site, globally unique, assigned below:
 *      0  test/dead-port.test.mjs's own probe
 *      1  stats-route   2  env-hermetic    3  snapshot-contract
 *      4  protocol render mount            5  protocol provision mount
 *      6  protocol refusal case           7  review mount
 *      8  wiring defaults mount           9  wiring cancel mount (needs REFUSAL
 *         fast-fail, so the suite verifies via requireDeadPort)
 *     10  output-budget mount
 *    11  wiring review-default probe, FIRST direct entry
 *    12  wiring review-default probe, SECOND direct entry — both REFUSAL-critical:
 *         the probe's diagnostic NAMES the port, so the suite verifies via
 *         requireDeadPort instead of assuming.
 *    uniqueness and "no reintroduced literal" are pinned by
 *    test/dead-port.test.mjs, not by this comment;
 *  - base + every offset stays BELOW 32768 (`DYNAMIC_BAND_FLOOR`), so no
 *    concurrent `listen(0)` can ever be handed a sentinel. That is what makes
 *    the parallel default in scripts/test.mjs safe, not just fast.
 *
 * `scripts/tools-snapshot.mjs` still hardcodes its own port: it is a manually
 * run generator, never scheduled concurrently with the suites, so it cannot
 * race these numbers in practice.
 */
import net from 'node:net';

/** Default anchor of the sentinel band — well below every OS dynamic range. */
export const DEFAULT_BASE = 21190;

/** The floor Linux assigns to ephemeral ports; Windows starts higher (49152). */
export const DYNAMIC_BAND_FLOOR = 32768;

/**
 * The sentinel for one use site. Throws on a malformed `ATOMCODE_TEST_PORT_BASE`
 * rather than defaulting: guessing a band is how two suites end up sharing one.
 * An unset (or empty) base means "use DEFAULT_BASE" — empty is the documented
 * "no opinion" spelling, not a typo to police.
 */
export function sentinelPort(offset) {
  const raw = process.env.ATOMCODE_TEST_PORT_BASE;
  if (raw === undefined || raw === '') return DEFAULT_BASE + offset;
  const base = Number(raw);
  if (!Number.isInteger(base) || base < 1024 || base > 60000) {
    throw new Error(
      `ATOMCODE_TEST_PORT_BASE=${raw} is not an integer in 1024..60000 — refusing to guess which port band a suite means`,
    );
  }
  return base + offset;
}

/**
 * Prove the sentinel is free RIGHT NOW, then release it. A pass means "nothing
 * listened a moment ago, and no concurrent `listen(0)` can be assigned this
 * number (it sits below every dynamic range)". A collision throws NAMED, so a
 * developer with something real in the band moves the whole block instead of
 * watching a suite assert `reason: 'refused'` against a port that answers.
 */
export async function requireDeadPort(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err) => {
      reject(
        new Error(
          `sentinel port ${port} is NOT free (${err.code}) — something real listens where a suite expects a refusal. ` +
            'Move every sentinel at once: ATOMCODE_TEST_PORT_BASE=<another integer whose band stays under 32768>',
          { cause: err },
        ),
      );
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
  return port;
}
