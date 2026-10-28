import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { clientDefines } from "./tools/build/define.mjs";

const src = path.resolve(import.meta.dirname, "src");

/** The lightningcss Vite minifies the CSS with, for its feature flags. */
const lightningcss = createRequire(
  path.join(import.meta.dirname, "node_modules/vite/package.json"),
)("lightningcss") as typeof import("lightningcss");

/**
 * The browser bundle (root src/client, out to dist/client) and, with
 * `--ssr prerender.tsx`, the build-time render of the page shell
 * (tools/build/prerender.mjs).
 */
/**
 * Writes `build.json` beside the client build: the build values the bundle was given, an unset one as null.
 * The server build takes them from it (tools/build/build-server.mjs), so a server is never built with other
 * values than the page it serves, whose prerendered shell differs by the switch and whose JSON-LD names the
 * site. The deploy's env check reads it from the image (tools/deploy/check-env.mjs).
 */
function buildValues(defines: Record<string, string>): Plugin {
  return {
    name: "gtnh-build-values",
    apply: "build",
    generateBundle() {
      const value = (name: string) => JSON.parse(defines[`process.env.${name}`]!) as string;
      const whenSet = (name: string) => {
        const literal = defines[`process.env.${name}`]!;
        return literal === "undefined" ? null : (JSON.parse(literal) as string);
      };
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source: `${JSON.stringify(
          {
            modAndCommunity: value("NEXT_PUBLIC_MOD_AND_COMMUNITY"),
            buildId: value("NEXT_PUBLIC_GTNH_BUILD_ID"),
            siteUrl: whenSet("NEXT_PUBLIC_SITE_URL"),
            liveUrl: whenSet("NEXT_PUBLIC_LIVE_URL"),
            datasetManifestUrl: whenSet("NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL"),
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}

export default defineConfig(({ isSsrBuild, mode }) => {
  const defines = clientDefines(process.env, { mode });
  return {
    root: path.join(src, "client"),
    // The site's public/ is served by the server, never copied into the bundle.
    publicDir: false,
    resolve: { alias: { "@": src } },
    // The NEXT_PUBLIC_* build values and NODE_ENV, inlined: the browser has no `process`. NODE_ENV follows Vite's
    // mode, so the dev server keeps "development" and the dev aids behind it, and `vite build` gives "production".
    define: defines,
    plugins: [react(), tailwindcss(), ...(isSsrBuild ? [] : [buildValues(defines)])],
    build: {
      outDir: path.resolve(import.meta.dirname, isSsrBuild ? "dist/prerender" : "dist/client"),
      emptyOutDir: true,
      manifest: !isSsrBuild,
      // Next's browser list, with Firefox at 114: the first with module workers.
      target: ["chrome111", "edge111", "firefox114", "safari16.4"],
      // The CSS keeps Next's list unchanged (Firefox 111), so its colours and media queries are lowered exactly as
      // Next lowered them: module workers set the script floor, not the stylesheet's.
      cssTarget: ["chrome111", "edge111", "firefox111", "safari16.4"],
      // Fonts are files, never data: URLs, so a preload names them and each face loads only when used.
      assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
      rollupOptions: {
        ...(isSsrBuild ? { output: { entryFileNames: "[name].mjs" } } : {}),
      },
    },
    // Media range syntax is written out as min-/max- queries, as Next's CSS pipeline wrote it.
    css: { lightningcss: { include: lightningcss.Features.MediaRangeSyntax } },
    // The workers are ES modules (`new Worker(url, { type: "module" })`), the same in dev and build.
    worker: { format: "es" },
    // The shell render bundles the app, so it loads no package the way Node would and needs no node_modules.
    ssr: { noExternal: true },
  };
});
