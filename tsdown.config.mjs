// @ts-check
/**
 * Build configuration — `src/` holds ALL sources (host + client); `lib/` and the root
 * `client.js` are ARTIFACTS that stay VERSIONED.
 *
 * Why the artifacts are committed rather than gitignored (this is a contract, not a
 * preference): the DSH marketplace installs plugins with pnpm, and pnpm refuses to run
 * build scripts for git dependencies outright (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`;
 * the escape hatch is an `allowBuilds` entry an installer does not have). So "drop the
 * committed `lib/` and let `prepare` build on install" is a DEAD END — `prepare` works
 * on an npm git install and NOT on a pnpm one. Without a committed `lib/`, the
 * GitHub-direct channel ships a package whose `main` does not exist.
 * `test/build-gate.test.mjs` fails the suite when an artifact goes STALE, so the
 * committed output can never drift from the sources it claims to be built from.
 *
 * This repository previously had NO build layer on purpose ("edit and refresh"), which
 * is why `AGENTS.md` said so. That changed here; the discipline now is "edit `src/`,
 * run `npm run build`, commit both".
 *
 * Chunk/entry names carry NO content hash: a rebuild then rewrites the same filenames
 * in place, so `git status` shows one `M` per changed file instead of a `D` plus an
 * untracked twin — and a path-limited commit cannot silently drop a freshly-named chunk.
 */
import { defineConfig } from "tsdown";

/** Peer/runtime packages that must resolve from the Host, never be bundled. */
const NEVER_BUNDLE = ["@deepseek-ai/cordis"];

export default defineConfig([
  {
    name: "host",
    entry: ["src/host/index.ts"],
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2023",
    // A single bundle: the published surface is one entry (`package.json#main` +
    // `exports["."]`), and the offline suites import the SOURCES directly.
    splitting: false,
    clean: true,
    minify: false,
    sourcemap: false,
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { entryFileNames: "index.js", chunkFileNames: "[name].js" },
    deps: { neverBundle: [...NEVER_BUNDLE] },
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
    outputOptions: { entryFileNames: "client.js", name: "dsh_atomcode_bridge_client" },
    clean: false,
    minify: false,
    sourcemap: false,
    dts: false,
  },
]);
