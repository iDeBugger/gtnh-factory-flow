import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { serverDefines } from "./define.mjs";

/**
 * `build:server`: the site's server as one ESM bundle, the way `build:live` bundles the live service. Every
 * package stays external (the image's node_modules holds them); the NEXT_PUBLIC_* build values are inlined
 * (`serverDefines`), as Next inlined them into its server. The community switch and the build id come from the
 * client build's `build.json` (`serverEnv`), so the server is built the way the page it serves was.
 *
 * The bundle is two files:
 * - `app.mjs`, the bundle of src/server/main.ts, which exports `startServer` and never listens on import;
 * - `server.mjs` (`writeEntry`), which sets NODE_ENV to production and only then imports `app.mjs`. ESM evaluates every
 *   static import before a module's body, and a package such as `react/jsx-runtime` picks its development or
 *   production build when it loads, so a first line inside the bundle would run too late. Next's `server.js`
 *   sets NODE_ENV before it requires anything for the same reason.
 */

/**
 * The entry's text: NODE_ENV first, then the server. It is production whatever the caller set, as Next's
 * `server.js` assigns it: the bundle is a production build, and a stray NODE_ENV in a container's env would
 * otherwise load React's development builds and serve the development policy ('unsafe-inline', 'unsafe-eval').
 */
export const ENTRY_SOURCE = `process.env.NODE_ENV = "production";
const { startServer } = await import("./app.mjs");
await startServer();
`;

/** @param {string} outDir */
export function writeEntry(outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "server.mjs"), ENTRY_SOURCE);
}

/**
 * The environment the server is built with: `env`, with the community switch and the build id the client
 * build recorded in `<clientDir>/build.json`. The prerendered shell differs by the switch, so a value here
 * other than the client's would serve one mode's page from the other mode's server: a different value set in
 * `env` fails the build, and a missing build.json asks for the client build first.
 *
 * @param {string} clientDir
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function serverEnv(clientDir, env) {
  const file = path.join(clientDir, "build.json");
  if (!existsSync(file)) {
    throw new Error(`${file} is missing: run build:client before build:server.`);
  }
  const built = JSON.parse(readFileSync(file, "utf8"));
  if (typeof built.modAndCommunity !== "string" || typeof built.buildId !== "string") {
    throw new Error(`${file} must name modAndCommunity and buildId.`);
  }
  if ((env.NEXT_PUBLIC_MOD_AND_COMMUNITY ?? "") !== built.modAndCommunity) {
    throw new Error(
      `NEXT_PUBLIC_MOD_AND_COMMUNITY is ${JSON.stringify(env.NEXT_PUBLIC_MOD_AND_COMMUNITY ?? "")} here but ` +
        `${JSON.stringify(built.modAndCommunity)} in the client build: build both with the same value.`,
    );
  }
  const configured = env.GTNH_BUILD_ID?.trim();
  if (configured && configured !== built.buildId) {
    throw new Error(
      `GTNH_BUILD_ID is ${JSON.stringify(configured)} here but ${JSON.stringify(built.buildId)} in the client build.`,
    );
  }
  return {
    ...env,
    NEXT_PUBLIC_MOD_AND_COMMUNITY: built.modAndCommunity,
    GTNH_BUILD_ID: built.buildId,
  };
}

/**
 * @param {{ root?: string, outDir?: string, clientDir?: string, env?: Record<string, string | undefined> }} [options]
 */
export async function buildServer({
  root = process.cwd(),
  outDir = path.join(root, "dist", "server"),
  clientDir = path.join(root, "dist", "client"),
  env = process.env,
} = {}) {
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "src", "server", "main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: path.join(outDir, "app.mjs"),
    metafile: true,
    define: serverDefines(serverEnv(clientDir, env)),
    logLevel: "warning",
  }).then((result) => {
    writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(result.metafile));
  });
  writeEntry(outDir);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await buildServer();
  console.log("built dist/server/server.mjs and app.mjs");
}
