/**
 * `dsh-connect-atomcode` host entry point.
 *
 * v0.4.3 refactor: this file used to be a 1,879-line God module holding every
 * host-side concern — config parsing, the stats snapshot, the runtime, both
 * routes, both tools — in one scope. It is now the assembly point only, and the
 * work has moved to purpose-named modules:
 *
 *   - `./config.ts`    readConfig() + the shared tuning constants
 *   - `./runtime.ts`   createRuntime() — the stats bag + daemon lifecycle + quota
 *   - `./stats.ts`     writeJson/sameOrigin/describeDaemonDown/buildStatsBody
 *   - `./routes.ts`    mountRoutes() — the two HTTP routes, disposed as one unit
 *   - `./tools.ts`     mountAskTool() + mountReviewTool() — the two tools
 *
 * The split was done so a reader can find a concern by its file name instead of
 * reading 1,900 lines; the discipline (red lines 1–8, the two provider
 * namespaces, config never trusts input, observable degradation over silent
 * failure) is unchanged and is asserted by the same test suite.
 *
 * @module dsh-connect-atomcode
 */
import { readConfig } from './config.ts';
import { createRuntime } from './runtime.ts';
import { mountRoutes } from './routes.ts';
import { mountAskTool, mountReviewTool } from './tools.ts';

/**
 * The plugin version — hand-edited here and in `package.json`, and the two must
 * agree (`test/wiring.test.mjs` pins this literal against the manifest). It is
 * handed to the runtime as `stats.pluginVersion`, and the stats body reports it
 * to the client.
 */
const PLUGIN = {
  version: '0.4.2',
} as const;

export const name = 'atomcode-bridge';
export const inject = ['tools', 'webServer'];

export function apply(ctx: any, rawConfig: Record<string, any> = {}) {
  // Resolved once, here, and handed to every mount function as the whole
  // `config` object — each one destructures only the fields it consumes, so a
  // field nobody reads any more disappears from a short list instead of
  // lingering as a stale binding at the top of a long function. Same names
  // everywhere, on purpose: a move that also renamed things would stop being
  // readable as proof that nothing else changed.
  const config = readConfig(rawConfig);

  // `log` lives before its other uses so the store’s observer can share the one
  // `[atomcode-bridge]` prefix instead of re-typing it (and so a second logger
  // call site cannot drift from it).
  const log = (message: any) => ctx.logger?.warn(`[atomcode-bridge] ${message}`);

  // An UNDETERMINED profile is named at mount, not left to be discovered as a
  // wrong continuation weeks later: with no prefix, both profiles write the same
  // `default::` key in the shared sessions.json, so a `continue: true` in one
  // resumes the other’s side conversation — a wrong-context answer with no trace
  // of why. Named here (红线 3), and fixable by the user with one config line.
  if (config.sessionKeyPrefixSource === 'none') {
    log(
      '无法判定 DSH profile（DSH_PROFILE 未设置，argv 里也没有 dsh 的 web/desktop 子命令）：' +
        'sessions.json 将不带 profile 前缀。若本机同时跑 web 与 desktop，两侧的会话续接会共用同一个键、互相串线——' +
        '在插件配置里设 session_key_prefix 可消除歧义。',
    );
  }

  // Everything that accumulates across the mount — the live stats bag, the two
  // state stores, daemon liveness and spawning, the quota cache and the
  // panel-facing state — lives in one object rather than as ~420 lines of
  // closures declared right here.
  const runtime = createRuntime({ config, log });
  // The version literal is declared here (see the wiring test) so the snapshot
  // can report it without stats.ts importing the manifest.
  runtime.stats.pluginVersion = PLUGIN.version;

  const tools = ctx.get('tools');
  if (tools === undefined) return; // inject declares it; belt and braces.

  // Each tool owns its own description string end to end.
  const disposeAsk = mountAskTool({ tools, config, runtime });
  const disposeReview = mountReviewTool({ tools, config, runtime, log });

  // `webServer` is declared in `inject`, but degrade quietly if a host mounts
  // this plugin without the route service rather than failing the whole mount.
  const webServer = ctx.get ? ctx.get('webServer') : ctx.webServer;
  // Both routes — the stats read and the panel's provider write — live in
  // mountRoutes(): `webServer` is their only outside dependency, and both read
  // the same runtime, so they are mounted and disposed as one unit.
  const disposeRoutes = mountRoutes({ webServer, runtime, log });

  // NOTE: the daemon is intentionally NOT started at mount. Mounting a plugin
  // should not spawn background processes. `auto_start: true` is honored at the
  // two places the daemon is actually needed: the ask path (which awaits it) and
  // the stats route (which kicks it off), so simply LOOKING at the panel or the
  // composer chip is enough to bring it up — no tool call required.

  // Teardown only runs when the plugin unmounts: `ctx.effect(fn)` executes `fn`
  // at setup and treats its RETURN VALUE as the cleanup, so the disposers must
  // be returned (not invoked in the body — that would unregister the tools
  // immediately). Matches the dsh-connect-sensenova-token-plan pattern.
  ctx.effect(() => {
    return () => {
      disposeAsk();
      disposeReview();
      // One call for both routes: mountRoutes() composed them, so a route added
      // there cannot be forgotten here (which is how the four separate checks
      // that used to live on these lines let a fifth disposer go missing).
      disposeRoutes();
    };
  });
}