import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { clientDefines } from "./tools/build/define.mjs";

const src = path.resolve(__dirname, "src");

/** The lightningcss Vite minifies the CSS with, for its feature flags. */
const lightningcss = createRequire(path.join(__dirname, "node_modules/vite/package.json"))(
  "lightningcss",
) as typeof import("lightningcss");

/**
 * The browser bundle (root src/client, out to dist/client) and, with
 * `--ssr prerender.tsx`, the build-time render of the page shell
 * (tools/build/prerender.mjs).
 */
export default defineConfig(({ isSsrBuild }) => ({
  root: path.join(src, "client"),
  // The site's public/ is served by the server, never copied into the bundle.
  publicDir: false,
  resolve: { alias: { "@": src } },
  // The NEXT_PUBLIC_* build values and NODE_ENV, inlined: the browser has no `process`.
  define: clientDefines(process.env),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, isSsrBuild ? "dist/prerender" : "dist/client"),
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
      onwarn(warning, warn) {
        // The "use client" lines Next needed mean nothing to this bundle.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
      ...(isSsrBuild ? { output: { entryFileNames: "[name].mjs" } } : {}),
    },
  },
  // Media range syntax is written out as min-/max- queries, as Next's CSS pipeline wrote it.
  css: { lightningcss: { include: lightningcss.Features.MediaRangeSyntax } },
  // The workers are ES modules (`new Worker(url, { type: "module" })`), the same in dev and build.
  worker: { format: "es" },
  // The shell render bundles the app, so it loads no package the way Node would and needs no node_modules.
  ssr: { noExternal: true },
}));
