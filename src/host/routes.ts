/**
 * The two HTTP routes this plugin serves: the read-only stats snapshot the
 * detail page polls, and the write endpoint behind the model dropdown.
 *
 * Extracted from `src/host/index.ts` (v0.4.3 split). They are mounted together
 * because they share everything that matters — one `webServer` registration
 * surface, one runtime — and because mounting them apart is how the teardown
 * ended up as four separate `if (typeof … === 'function')` checks in apply(),
 * a shape where a fifth disposer goes missing without any compiler complaint.
 *
 * `webServer` is resolved by the caller: getting it needs `ctx`, and keeping
 * `ctx` out of this function is the same rule createRuntime() follows. A host
 * without the service is not an error — both registrations degrade to no-ops.
 *
 * @returns {() => void} one disposer for both routes.
 * @module dsh-connect-atomcode/host/routes
 */
import { PROVIDER_SLOTS, normalizeProviderName } from './provider-store.ts';
import { buildStatsBody, sameOrigin, writeJson } from './stats.ts';
import type { Runtime } from './runtime.ts';

const PROVIDER_BODY_LIMIT = 4096;

/** Read and parse a bounded JSON body; the route then judges its fields. */
async function readJsonBody(request: any) {
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
      received += buffer.byteLength;
      if (received > PROVIDER_BODY_LIMIT) return { ok: false, error: `request body is larger than ${PROVIDER_BODY_LIMIT} bytes` };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: 'could not read the request body' };
  }
  if (chunks.length === 0) return { ok: false, error: 'a JSON body is required' };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return { ok: false, error: 'the body is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'the body must be a JSON object' };
  }
  return { ok: true, value: parsed };
}

/**
 * @param {{ webServer: any; runtime: Runtime; log: (message: any) => void }} deps
 * @returns {() => void} one disposer for both routes.
 */
export function mountRoutes({
  webServer,
  runtime,
  log,
}: {
  webServer: any;
  runtime: Runtime;
  log: (message: any) => void;
}) {
  const {
    stats,
    sessions,
    refreshHealth,
    ensureDaemonStarted,
    readQuota,
    refreshPanelState,
    refreshModelCatalog,
    providerStore,
  } = runtime;

  const disposeStats = webServer && typeof webServer.register === 'function'
    ? webServer.register({
        kind: 'exact',
        path: '/api/atomcode-bridge/stats',
        handler: async (request: any, response: any) => {
          if (request && request.method && request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' });
            response.end();
            return;
          }
          if (!sameOrigin(request)) {
            response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('forbidden');
            return;
          }
          // Reflect the live tracked-session count on read (prefix-scoped: only this
          // store's keys, so a sibling profile's lines never inflate it).
          stats.sessionsTracked = sessions.count();
          // Same read, one more fact: how stale the oldest surviving key is. A
          // bare count cannot tell "one live line" from "nine ids a daemon that
          // exited three days ago left behind" — which is exactly the state the
          // count used to report as healthy.
          stats.sessionsOldestAgeMs = sessions.oldestAgeMs();
          await refreshHealth();
          // Opening the panel is itself a good moment to bring the daemon up.
          // Fire-and-forget: the start poll can run 30s, and this handler must
          // answer well inside the panel's 5s poll. `ensureDaemonStarted` is
          // shared, so this cannot race the mount or an ask into two daemons.
          if (!stats.daemonUp) void ensureDaemonStarted();
          const quota = await readQuota();
          // Panel-facing knobs: the stored picks + the catalogue the dropdowns
          // list. Sync read of a ~200-byte file, then one cached metadata call.
          refreshPanelState();
          await refreshModelCatalog();
          // HEAD gets headers only — a body on HEAD violates HTTP semantics.
          // The panel only ever GETs, but the method gate above lets HEAD
          // through deliberately, so honor it correctly here.
          if (request.method === 'HEAD') {
            response.writeHead(200, { 'cache-control': 'no-store' });
            response.end();
            return;
          }
          writeJson(response, 200, buildStatsBody(stats, quota), { 'cache-control': 'no-store' });
        },
      })
    : () => {};

  // ── 面板的模型选择写入点（同源，读自己那份 state 文件） ───────────────────
  // This route is what makes the dropdown a control instead of a decoration: the
  // pick is persisted to the PLUGIN's own state file (`provider.json`, next to
  // sessions.json) and read back per call — never into `~/.atomcode/config.toml`
  // (红线 8: that file is another application's configuration and stays read-only
  // for us). Same-origin gated like the stats route; a bounded JSON body; the slot
  // must be one of the two namespaces, and clearing is expressed as null.
  const disposeProvider = webServer && typeof webServer.register === 'function'
    ? webServer.register({
        kind: 'exact',
        path: '/api/atomcode-bridge/provider',
        handler: async (request: any, response: any) => {
          const method = request && request.method ? request.method : 'GET';
          if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
            writeJson(response, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, HEAD, POST' });
            return;
          }
          if (!sameOrigin(request)) {
            writeJson(response, 403, { ok: false, error: 'forbidden: origin mismatch' });
            return;
          }
          if (method === 'POST') {
            const body = await readJsonBody(request);
            if (!body.ok) {
              writeJson(response, 400, { ok: false, error: body.error });
              return;
            }
            const slot = body.value.slot;
            if (!PROVIDER_SLOTS.includes(slot)) {
              writeJson(response, 400, {
                ok: false,
                error: `slot must be one of ${PROVIDER_SLOTS.join(' / ')} (the two paths take different provider names — 红线 8)`,
              });
              return;
            }
            // A MISSING key is not a CLEAR. `normalizeProviderName(undefined)`
            // reads null as "clear the pick", which is how the wire spells
            // 未插手 — but that also made a body without the field silently
            // erase the user's selection (an older client, a hand-typed curl,
            // a truncated body). Clearing must be an OBSERVABLE act: the field
            // has to be present and null/''; absent is a 400 that says so.
            if (!Object.prototype.hasOwnProperty.call(body.value, 'provider')) {
              writeJson(response, 400, {
                ok: false,
                error: 'provider field is missing: name it, or send null explicitly to clear the pick',
              });
              return;
            }
            // normalizeProviderName is the ONLY validation: null/'' clears, and a
            // name we do not recognize is still passed through — the daemon or the
            // CLI judges it, and the turn reports the provider that ACTUALLY ran
            // (`runtime_info`), so a typo surfaces instead of being guessed away.
            const normalized = normalizeProviderName(body.value.provider);
            if (!normalized.ok) {
              writeJson(response, 400, { ok: false, error: normalized.error });
              return;
            }
            const written = providerStore.set(slot, normalized.value);
            if (!written.ok) {
              // A refused write is never swallowed: the panel shows the reason, and
              // a foreign (newer-build) file gets its own status so the user knows
              // this is a version situation, not a broken button. The status is
              // chosen from the store's CODE, never from its wording — matching
              // prose is how a correct refusal becomes a mysterious 500.
              const status = written.code === 'foreign-version' ? 409 : 500;
              log(`provider pick refused (${slot}): ${written.error}`);
              writeJson(response, status, { ok: false, error: written.error });
              return;
            }
            log(`provider pick saved (${slot}): ${written.value === null ? 'cleared' : written.value}`);
          }
          refreshPanelState();
          // HEAD gets headers only — a body on HEAD violates HTTP semantics, and
          // the method gate above lets HEAD through deliberately. The stats route
          // already honors this; this route must not be the half that does not.
          if (method === 'HEAD') {
            response.writeHead(200, { 'cache-control': 'no-store' });
            response.end();
            return;
          }
          // `ok` is part of the contract on BOTH methods: the client treats any
          // response without `ok: true` as a failure, so a successful write that
          // answered with a bare provider branch would render as an error.
          writeJson(response, 200, { ok: true, ...buildStatsBody(stats, null).provider }, { 'cache-control': 'no-store' });
        },
      })
    : () => {};

  return () => {
    disposeStats();
    disposeProvider();
  };
}