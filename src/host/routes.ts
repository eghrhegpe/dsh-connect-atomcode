/**
 * The HTTP routes this plugin serves: the read-only stats snapshot the detail
 * page polls, the write endpoint behind the model dropdown, the
 * reasoning-effort write point, the panel-settings write point, and the daemon
 * session index.
 *
 * The `/ask` route is GONE (2026-10-18): the 锐评 officialization (方针 A)
 * deleted the panel's private ask button + popover — one-click review now goes
 * through the `/atomcode-review` slash command (host-side, zero DSH turns), and
 * free-form questions go through the model's official `atomcode_ask`. The
 * route's only consumer was
 * the private popover; keeping a route with zero callers is how a dead ABI
 * surface survives to confuse the next reader.
 *
 * The `/inject` route is GONE (2026-10-19) for the same reason: 方针 A left it
 * with no in-repo caller, it carried no authentication (same-origin is a CSRF
 * gate, not an identity gate, and every plugin's client bundle shares the one
 * origin), and it could wake an idle session's driver for the price of a POST.
 * The delivery it wired is still reachable — `injectAtomcodeAnswer` /
 * `injectReviewContinuation` live in `./inject.ts` and the `/atomcode-review`
 * continuation calls them host-side, without an HTTP surface at all. A route
 * with zero callers and a cross-session write surface is exactly the dead ABI
 * the `/ask` note above warns about.
 *
 * Extracted from `src/host/index.ts` (apply() split). They are mounted together
 * because they share everything that matters — one `webServer` registration
 * surface, one runtime — and because mounting them apart is how the teardown
 * ended up as separate `if (typeof … === 'function')` checks in apply(),
 * a shape where a fifth disposer goes missing without any compiler complaint.
 * Adding a route here and forgetting its disposer is impossible: the disposer
 * is built from the same `webServer` guard, in the same function.
 *
 * `webServer` is resolved by the caller: getting it needs `ctx`, and keeping
 * `ctx` out of this function is the same rule createRuntime() follows. A host
 * without the service is not an error — the registrations degrade to no-ops.
 *
 * @returns {() => void} one disposer for all routes.
 * @module dsh-connect-atomcode/host/routes
 */
import { PROVIDER_SLOT, normalizeProviderName } from './provider-store.ts';
import { buildStatsBody, sameOrigin, writeJson } from './stats.ts';
import type { Runtime } from './runtime.ts';

const PROVIDER_BODY_LIMIT = 4096;

/**
 * Read and parse a bounded JSON body; the route then judges its fields.
 *
 * The limit is the CALLER's call, because the write routes carry fundamentally
 * different bodies (a slot+name pair vs a whole ask message). Exceeding it is
 * REPORTED, never truncated — a silently half-read body would read to the user
 * as a bad request rather than as a size limit.
 */
async function readJsonBody(request: any, limit: number = PROVIDER_BODY_LIMIT) {
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
      received += buffer.byteLength;
      if (received > limit) return { ok: false, error: `request body is larger than ${limit} bytes` };
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
 * Mount one exact route and hand back its disposer.
 *
 * Every route in this file is registered the same way, so a host without
 * `webServer` (or without `register`) degrades all routes to a no-op through ONE
 * guard. This replaced six copies of the same ternary, one of which (`/inject`)
 * had drifted to a bare truthiness check — the single place a host exposing
 * `webServer` without `register` would have thrown instead of degrading.
 * Adding a route and forgetting its disposer is impossible: the disposer is
 * this function's return value, not a local someone must remember to call in
 * the teardown at the bottom.
 *
 * `methods` is the ONE place the method gate lives. Each handler used to write
 * its own copy, and they drifted: `/stats` and `/provider` refused a MISSING
 * method, `/inject` and `/reasoning-effort` read it as POST, `/sessions`
 * checked nothing at all — one file, one author, several answers to the same
 * malformed request. A handler that forgets the gate here is caught by the
 * `allow` header this wrapper writes, so a new route cannot silently guess.
 *
 * @param webServer - `ctx.webServer`, or anything falsy on a host without it.
 * @param descriptor - `{ kind: 'exact', path, methods, handler }` for one route;
 *   `methods` is the request-method whitelist that the handler may read back.
 * @returns the disposer, never undefined.
 */
function mountRoute(
  webServer: any,
  descriptor: {
    kind: 'exact';
    path: string;
    methods: readonly string[];
    handler: (request: any, response: any) => any;
  },
): () => void {
  if (!webServer || typeof webServer.register !== 'function') return () => {};
  const { path, methods, handler } = descriptor;
  return webServer.register({
    kind: 'exact',
    path,
    handler: (request: any, response: any) => {
      // A MISSING method is a malformed request, not a GET (red-line 3: no
      // silent default). The `allow` header names the whitelist the route owns,
      // so a caller sees what it may send instead of an opaque 405.
      if (!request || !request.method || !methods.includes(request.method)) {
        writeJson(response, 405, { ok: false, error: 'method not allowed' }, { allow: methods.join(', ') });
        return;
      }
      return handler(request, response);
    },
  });
}

/**
 * Answer a cross-origin request with the one refusal every non-stats route
 * gives. (The stats route answers 403 as `text/plain` — it is polled by tools
 * that never parse JSON, so it keeps its own wording.)
 *
 * @returns true when it answered — the caller must then `return`.
 */
function refuseCrossOrigin(request: any, response: any): boolean {
  if (sameOrigin(request)) return false;
  writeJson(response, 403, { ok: false, error: 'forbidden: origin mismatch' });
  return true;
}

/**
 * Read the bounded JSON body, or send the 400 the caller would have written.
 *
 * The 400 body is `{ ok: false, error }` on all four write routes because the
 * client treats any response without `ok: true` as a failure and renders
 * `error`; keeping the shape in one place is what keeps it that way.
 *
 * @returns the parsed body, or null when the 400 already went out.
 */
async function readBodyOr400(request: any, response: any, limit: number = PROVIDER_BODY_LIMIT) {
  const body = await readJsonBody(request, limit);
  if (body.ok) return body;
  writeJson(response, 400, { ok: false, error: body.error });
  return null;
}

/**
 * @param {{ webServer: any; runtime: Runtime; log: (message: any) => void }} deps
 * @returns {() => void} one disposer for all routes.
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
    panelSettingsStore,
  } = runtime;

  const disposeStats = mountRoute(webServer, {
        kind: 'exact',
        path: '/api/atomcode-bridge/stats',
        methods: ['GET', 'HEAD'],
        handler: async (request: any, response: any) => {
          if (!sameOrigin(request)) {
            response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('forbidden');
            return;
          }
          // HEAD answers BEFORE any side effect. It used to run the whole read
          // path first and then decide to return headers only — which meant a
          // single HEAD from any uptime checker (a load balancer, a browser
          // link preview, a monitoring probe) would START THE DAEMON and spend
          // a `status` round trip, i.e. act on the user's machine in response
          // to a request that asked for nothing but headers. The panel only
          // ever GETs, so HEAD exists here for probes, and a probe must be
          // free. Everything below is the GET path.
          if (request.method === 'HEAD') {
            response.writeHead(200, { 'cache-control': 'no-store' });
            response.end();
            return;
          }
          // Reflect the live tracked-session count on read (prefix-scoped: only this
          // store's keys, so a sibling profile's lines never inflate it), plus how
          // stale the oldest surviving key is — ONE read for both. A bare count
          // cannot tell "one live line" from "nine ids a daemon that exited three
          // days ago left behind" — which is exactly the state the count used to
          // report as healthy. Two accessors back to back meant two full reads and
          // two parses of the same file on every 5s poll.
          const sessionsSnapshot = sessions.snapshot();
          stats.sessionsTracked = sessionsSnapshot.tracked;
          stats.sessionsOldestAgeMs = sessionsSnapshot.oldestAgeMs;
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
          // (The HEAD branch above already returned; reaching here means GET.)
          writeJson(response, 200, buildStatsBody(stats, quota), { 'cache-control': 'no-store' });
        },
      });

  // ── 面板的模型选择写入点（同源，读自己那份 state 文件） ───────────────────
  // This route is what makes the dropdown a control instead of a decoration: the
  // pick is persisted to the PLUGIN's own state file (`provider.json`, next to
  // sessions.json) and read back per call — never into `~/.atomcode/config.toml`
  // (红线 8: that file is another application's configuration and stays read-only
  // for us). Same-origin gated like the stats route; a bounded JSON body; the slot
  // must be one of the two namespaces, and clearing is expressed as null.
  const disposeProvider = mountRoute(webServer, {
        kind: 'exact',
        path: '/api/atomcode-bridge/provider',
        methods: ['GET', 'HEAD', 'POST'],
        handler: async (request: any, response: any) => {
          const method = request.method;
          if (refuseCrossOrigin(request, response)) return;
          if (method === 'POST') {
            const body = await readBodyOr400(request, response);
            if (!body) return;
            const slot = body.value.slot;
            if (slot !== PROVIDER_SLOT) {
              writeJson(response, 400, {
                ok: false,
                error: `slot must be "${PROVIDER_SLOT}" (the second namespace died with the review CLI)`,
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
      });

  // ── Set the persistent reasoning-effort on the daemon ─────────────────────
  // POST /api/atomcode-bridge/reasoning-effort  { effort: "low"|"medium"|... }
  // The daemon's /live/reasoning_effort endpoint sets a per-provider persistent
  // value; this route is the panel-side write point for it. A 404 from the
  // daemon (endpoint not present on this build) is reported, not swallowed.
  const disposeReasoningEffort = mountRoute(webServer, {
        kind: 'exact',
        path: '/api/atomcode-bridge/reasoning-effort',
        methods: ['POST'],
        handler: async (request: any, response: any) => {
          if (refuseCrossOrigin(request, response)) return;
          const body = await readBodyOr400(request, response);
          if (!body) return;
          const effort = body.value.effort;
          if (typeof effort !== 'string' || effort.trim() === '') {
            writeJson(response, 400, { ok: false, error: 'effort is required and must be a non-empty string' });
            return;
          }
          const result = await runtime.setReasoningEffort(effort.trim());
          writeJson(response, 200, result, { 'cache-control': 'no-store' });
        },
      });

  // ── List the daemon's sessions ────────────────────────────────────────────
  // GET /api/atomcode-bridge/sessions
  // Returns the daemon's full session index (all projects). The panel filters
  // by working_dir on the render side; the route itself does not filter.
  // A 404 from the daemon (endpoint not present on this build) is reported.
  const disposeSessions = mountRoute(webServer, {
        kind: 'exact',
        path: '/api/atomcode-bridge/sessions',
        methods: ['GET'],
        handler: async (_request: any, response: any) => {
          if (refuseCrossOrigin(_request, response)) return;
          try {
            const sessions = await runtime.listSessions();
            writeJson(response, 200, { ok: true, sessions }, { 'cache-control': 'no-store' });
          } catch (error: any) {
            const reason = String(error && error.message ? error.message : error);
            writeJson(response, 502, { ok: false, error: reason }, { 'cache-control': 'no-store' });
          }
        },
      });

  // ── Panel settings write: briefMode + workingDir overrides ─────────────────
  // POST /api/atomcode-bridge/panel-settings  { briefMode?, workingDir? }
  // Persists the panel's overrides to the plugin's own state file
  // (panel-settings.json, next to provider.json). Read PER CALL by the
  // execute path, so a click takes effect on the very next turn.
  // GET answers with the current panel-settings reading + the effective values.
  const PANEL_SETTINGS_BODY_LIMIT = 2048;
  const disposePanelSettings = mountRoute(webServer, {
        kind: 'exact',
        path: '/api/atomcode-bridge/panel-settings',
        methods: ['GET', 'HEAD', 'POST'],
        handler: async (request: any, response: any) => {
          if (refuseCrossOrigin(request, response)) return;
          const method = request.method;
          if (method === 'POST') {
            const body = await readBodyOr400(request, response, PANEL_SETTINGS_BODY_LIMIT);
            if (!body) return;
            const fields: Record<string, unknown> = {};
            if (Object.prototype.hasOwnProperty.call(body.value, 'briefMode')) {
              fields.briefMode = body.value.briefMode;
            }
            if (Object.prototype.hasOwnProperty.call(body.value, 'workingDir')) {
              fields.workingDir = body.value.workingDir;
            }
            if (Object.keys(fields).length === 0) {
              writeJson(response, 400, { ok: false, error: 'at least one of briefMode or workingDir must be present' });
              return;
            }
            const written = panelSettingsStore.set(fields);
            if (!written.ok) {
              const status = written.code === 'foreign-version' ? 409 : 500;
              log(`panel-settings write refused: ${written.error}`);
              writeJson(response, status, { ok: false, error: written.error });
              return;
            }
            log(`panel-settings saved: ${JSON.stringify(fields)}`);
          }
          // GET / HEAD: answer with the current reading.
          const current = panelSettingsStore.read();
          if (method === 'HEAD') {
            response.writeHead(200, { 'cache-control': 'no-store' });
            response.end();
            return;
          }
          writeJson(response, 200, {
            ok: true,
            briefMode: current.briefMode,
            workingDir: current.workingDir,
            ...(current.foreignVersion ? { foreignVersion: true } : {}),
            ...(current.error ? { error: current.error } : {}),
          }, { 'cache-control': 'no-store' });
        },
      });

  return () => {
    disposeStats();
    disposeProvider();
    disposeReasoningEffort();
    disposeSessions();
    disposePanelSettings();
  };
}