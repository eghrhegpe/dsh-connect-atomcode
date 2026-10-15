// @ts-check
/**
 * Build configuration — `src/` holds the sources; the root `client.js` and (once the
 * host half lands) `lib/` are ARTIFACTS that stay VERSIONED.
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
 * `npm run build`, commit both".
 *
 * ⚠️ The migration is being done in two phases (client, then host). The host entry is
 * NOT here yet on purpose: it is added together with `src/host/`, because pointing an
 * entry at a file that does not exist makes `npm run build` fail outright. Until then
 * `lib/` is still the hand-written host half, and only the client half is a build
 * output.
 *
 * Chunk/entry names carry NO content hash: a rebuild then rewrites the same filenames
 * in place, so `git status` shows one `M` per changed file instead of a `D` plus an
 * untracked twin — and a path-limited commit cannot silently drop a freshly-named chunk.
 */
import { defineConfig } from "tsdown";

/** Peer/runtime packages that must resolve from the Host, never be bundled. */
const NEVER_BUNDLE_HOST = ["@deepseek-ai/cordis"];

export default defineConfig([
  // ── The host entry is added in the host phase, together with `src/host/`. ──
  // {
  //   name: "host",
  //   entry: ["src/host/index.ts"],
  //   outDir: "lib",
  //   format: "esm",
  //   platform: "node",
  //   target: "es2023",
  //   splitting: false,
  //   clean: true,
  //   minify: false,
  //   sourcemap: false,
  //   dts: false,
  //   outExtensions: () => ({ js: ".js" }),
  //   outputOptions: { entryFileNames: "index.js", chunkFileNames: "[name].js" },
  //   deps: { neverBundle: [...NEVER_BUNDLE_HOST] },
  // },
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
