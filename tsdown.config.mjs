// @ts-check
/**
 * Build configuration — `src/` holds the sources; the root `client.js` and everything
 * under `lib/` are ARTIFACTS that stay VERSIONED.
 *
 * Why the artifacts are committed rather than gitignored (this is a contract, not a
 * preference): the DSH marketplace installs plugins with pnpm, and pnpm refuses to run
 * build scripts for git dependencies outright (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`;
 * the escape hatch is an `allowBuilds` entry an installer does not have). So "drop the
 * committed output and let `prepare` build on install" is a DEAD END — `prepare` works
 * on an npm git install and NOT on a pnpm one. Without a committed artifact, the
 * GitHub-direct channel ships a package whose `main`/`client` does not exist.
 * `test/build-gate.test.mjs` fails the suite when an artifact goes STALE, so the
 * committed output can never drift from the sources it claims to be built from.
 *
 * This repository previously had NO build layer on purpose ("edit and refresh"), which
 * is why `AGENTS.md` said so. That changed; the discipline now is "edit `src/`, run
 * `npm run build`, commit both". Both halves are migrated: the client is an IIFE at the
 * package root, the host is one ESM file per source module under `lib/`.
 *
 * Chunk/entry names carry NO content hash: a rebuild then rewrites the same filenames
 * in place, so `git status` shows one `M` per changed file instead of a `D` plus an
 * untracked twin — and a path-limited commit cannot silently drop a freshly-named chunk.
 */
import { defineConfig } from "tsdown";

/** Peer/runtime packages that must resolve from the Host, never be bundled. */
const NEVER_BUNDLE_HOST = ["@deepseek-ai/cordis"];

export default defineConfig([
  {
    name: "host",
    // Multiple entries, NOT one bundle. The host half is loaded as ESM from disk
    // by Node, and its module graph is load-bearing at TEST time: `wiring` and
    // `protocol` reach into `lib/review.js` to install the fake spawner
    // (`setSpawnOverride`) that `lib/index.js` then runs. Bundling everything into
    // `lib/index.js` inlined a SECOND copy of that module, so the override landed
    // on a module nobody called and the test drove the REAL review CLI — which is
    // how this was caught. Emitting one artifact per source file keeps the shared
    // instance, and the suites keep driving the built host half.
    entry: {
      index: "src/host/index.ts",
      daemon: "src/host/daemon.ts",
      review: "src/host/review.ts",
      quota: "src/host/quota.ts",
      sessions: "src/host/sessions.ts",
      "provider-store": "src/host/provider-store.ts",
      // apply()-split of the former God module: each concern is its own entry so
      // `lib/` stays "one artifact per source module" and a reader can find a
      // concern by its file name. These are NEW entries — nothing that already
      // existed moves, so the suites that reach into a specific `lib/*.js`
      // (wiring, protocol, ask-glue, stats-route) keep their imports working.
      config: "src/host/config.ts",
      stats: "src/host/stats.ts",
      runtime: "src/host/runtime.ts",
      routes: "src/host/routes.ts",
      tools: "src/host/tools.ts",
      // The one module BOTH halves read (`src/client/rows.ts` bundles it too).
      // It gets its own entry so it lands at a stable path instead of being
      // inlined into whichever host module happened to import it first — that
      // is how `lib/review.js` once became a re-export shell with the real code
      // in a generated `lib/review2.js`, which breaks the "one artifact per
      // source module" naming this config promises (see the header).
      loopback: "src/shared/loopback.ts",
    },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2023",
    // Shared modules become shared chunks rather than being duplicated per entry
    // (the duplication above is exactly what broke the seam).
    splitting: true,
    // `clean: true` is what makes the migration atomic: building REPLACES the
    // hand-written `lib/*.js` leaves, so a half-built tree cannot linger.
    clean: true,
    minify: false,
    sourcemap: false,
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    // NO content hash: a rebuild rewrites the same filenames in place.
    outputOptions: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    deps: { neverBundle: [...NEVER_BUNDLE_HOST] },
  },
  {
    name: "client",
    entry: ["src/client/index.ts"],
    // The client artifact lives at the PACKAGE ROOT by contract: `package.json#exports`
    // ("`./client`"), the browser loader, and `test/client-id.test.mjs` all consume the
    // same path. So outDir is "." and clean must never run here.
    outDir: ".",
    format: "iife",
    platform: "browser",
    target: "es2020",
    // `react` keeps resolving through the loader's module table, never bundled: the
    // browser world materializes the factory with its own `require`, and the Node suites
    // hand it a stand-in. In the sources the call goes through a plain parameter, which
    // the bundler cannot see, so this pin is belt and braces.
    deps: { neverBundle: ["react", "react-dom", "@deepseek-ai/dsh-client-ui-primitives"] },
    // NO `name`: the entry exports nothing (the registration is delivered by the
    // `__ModuleLoader__.load(...)` side effect), and naming it would make the IIFE
    // bundler emit a `var <name> = ...` page-global that the hand-written artifact
    // never had.
    outputOptions: { entryFileNames: "client.js" },
    clean: false,
    minify: false,
    sourcemap: false,
    dts: false,
  },
]);
