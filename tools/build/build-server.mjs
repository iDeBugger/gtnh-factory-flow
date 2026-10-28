import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { serverDefines } from "./define.mjs";

/**
 * `build:server`: the site's server as one ESM bundle, the way `build:live` bundles the live service. Every
 * package stays external (the image's node_modules holds them); the NEXT_PUBLIC_* build values are inlined
 * (`serverDefines`), as Next inlined them into its server.
 *
 * The bundle is two files:
 * - `app.mjs`, the bundle of src/server/main.ts, which exports `startServer` and never listens on import;
 * - `server.mjs` (`writeEntry`), which sets NODE_ENV and only then imports `app.mjs`. ESM evaluates every
 *   static import before a module's body, and a package such as `react/jsx-runtime` picks its development or
 *   production build when it loads, so a first line inside the bundle would run too late. Next's `server.js`
 *   sets NODE_ENV before it requires anything for the same reason.
 */

/** The entry's text: NODE_ENV first, a value the caller set kept, then the server. */
export const ENTRY_SOURCE = `process.env.NODE_ENV ??= "production";
const { startServer } = await import("./app.mjs");
await startServer();
`;

/** @param {string} outDir */
export function writeEntry(outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "server.mjs"), ENTRY_SOURCE);
}

/**
 * @param {{ root?: string, outDir?: string, env?: Record<string, string | undefined> }} [options]
 */
export async function buildServer({
  root = process.cwd(),
  outDir = path.join(root, "dist", "server"),
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
    define: serverDefines(env),
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
