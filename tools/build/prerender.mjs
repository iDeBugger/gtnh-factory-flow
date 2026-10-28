import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The last step of `build:client`. It renders the page shell with the SSR
 * build of src/client/prerender.tsx, fills the built template's
 * `<!--app-boot-->` and `<!--app-shell-->`, and leaves `<!--app-head-->` for
 * the server, which writes the site or per-plan head per request. Beside the
 * page it writes page.json:
 * - `scriptHashes`: the CSP hash of every inline script that runs, so the
 *   policy needs no 'unsafe-inline' for scripts. JSON-LD is a data block, not
 *   a script, and needs none.
 * - `fontPreloads`: the font files the server names in its `Link` header;
 * - `assetVersions`: the cache-busting query of the og:image and favicon URLs
 *   in the head (`assetVersion`).
 */

/**
 * Whether every face is preloaded, as Next did (17 files, about 2.5 MB on a
 * first visit), or only the default face, Inter. Off: a player who picked
 * another font may see one swap from its fallback face on a cold load, and
 * every other visitor loads only what they use.
 */
export const PRELOAD_ALL_FONTS = false;

/** The default face's preloaded file: its latin subset, the one Next preloaded for Inter. */
const DEFAULT_PRELOADS = ["inter-latin.woff2"];

/** Next's full preload list, in the order its `Link` header named the files. */
const ALL_PRELOADS = [
  "jetbrains-mono-latin.woff2",
  "inter-latin.woff2",
  "atkinson-hyperlegible-700-latin.woff2",
  "Monocraft.ttf",
  "Monocraft-Black.ttf",
  "Monocraft-Bold.ttf",
  "Monocraft-ExtraLight.ttf",
  "Monocraft-Light.ttf",
  "Monocraft-SemiBold.ttf",
  "OpenDyslexic-Bold.otf",
  "OpenDyslexic-Regular.otf",
  "comic-neue-700-latin.woff2",
  "lexend-latin.woff2",
  "atkinson-hyperlegible-400-latin.woff2",
  "comic-neue-400-latin.woff2",
  "andika-700-latin.woff2",
  "andika-400-latin.woff2",
];

const FONT_TYPES = { ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };

/** Script types a browser runs; any other type is a data block. */
const EXECUTABLE_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);

/**
 * `'sha256-<base64>'` of each inline script's text that the browser runs, in
 * page order.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? "";
    if (/\ssrc\s*=/i.test(attributes)) continue;
    const type = /\stype\s*=\s*"([^"]*)"/i.exec(attributes)?.[1]?.trim().toLowerCase() ?? "";
    if (!EXECUTABLE_TYPES.has(type)) continue;
    hashes.push(`'sha256-${createHash("sha256").update(match[2], "utf8").digest("base64")}'`);
  }
  return hashes;
}

/**
 * The font preloads, mapped to their built `/assets` names through the Vite
 * manifest.
 *
 * @param {Record<string, { file: string }>} manifest
 * @param {boolean} all
 * @returns {{ href: string, type: string }[]}
 */
export function fontPreloads(manifest, all = PRELOAD_ALL_FONTS) {
  return (all ? ALL_PRELOADS : DEFAULT_PRELOADS).map((name) => {
    const key = Object.keys(manifest).find((source) => source.endsWith(`app/fonts/${name}`));
    if (!key) throw new Error(`The Vite manifest names no built file for ${name}.`);
    return {
      href: `/${manifest[key].file}`,
      type: FONT_TYPES[/** @type {keyof typeof FONT_TYPES} */ (path.extname(name))],
    };
  });
}

/** The site files whose head URLs carry a version query, as `HeadAssetVersions` in head.ts names them. */
export const VERSIONED_SITE_FILES = {
  ogImage: "src/app/opengraph-image.png",
  favicon: "src/app/favicon.ico",
};

/**
 * The query a site file's head URL carries: `<name>.<content hash>.<ext>`, the
 * shape of the name Next's bundler gave the file. The hash is the file's own
 * sha256, so the query changes exactly when the file does, and a crawler or
 * browser holding the old image asks again.
 *
 * @param {string} fileName
 * @param {Buffer} bytes
 * @returns {string}
 */
export function assetVersion(fileName, bytes) {
  const extension = path.extname(fileName);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `${path.basename(fileName, extension)}.${hash}${extension}`;
}

/**
 * `assetVersion` of each versioned site file under `root`.
 *
 * @param {string} root
 * @returns {{ ogImage: string, favicon: string }}
 */
export function siteAssetVersions(root) {
  return /** @type {{ ogImage: string, favicon: string }} */ (
    Object.fromEntries(
      Object.entries(VERSIONED_SITE_FILES).map(([key, file]) => [
        key,
        assetVersion(path.basename(file), readFileSync(path.join(root, file))),
      ]),
    )
  );
}

/**
 * The page with the boot scripts and the shell filled in.
 *
 * @param {string} template
 * @param {{ shell: string, bootScripts: string[], structuredData: string }} rendered
 * @returns {string}
 */
export function fillTemplate(template, { shell, bootScripts, structuredData }) {
  for (const mark of ["<!--app-head-->", "<!--app-boot-->", "<!--app-shell-->"]) {
    if (template.split(mark).length !== 2) throw new Error(`The template must hold ${mark} once.`);
  }
  const boot =
    bootScripts.map((script) => `<script>${script}</script>`).join("") +
    `<script type="application/ld+json">${structuredData}</script>`;
  // Functions, so a `$` in the markup is never read as a replacement pattern.
  return template.replace("<!--app-boot-->", () => boot).replace("<!--app-shell-->", () => shell);
}

async function main() {
  const root = process.cwd();
  const clientDir = path.join(root, "dist", "client");
  const { renderShell } = await import(
    pathToFileURL(path.join(root, "dist", "prerender", "prerender.mjs")).href
  );
  const template = readFileSync(path.join(clientDir, "index.html"), "utf8");
  const html = fillTemplate(template, renderShell());
  const manifest = JSON.parse(readFileSync(path.join(clientDir, ".vite", "manifest.json"), "utf8"));
  const page = {
    scriptHashes: inlineScriptHashes(html),
    fontPreloads: fontPreloads(manifest),
    assetVersions: siteAssetVersions(root),
  };
  writeFileSync(path.join(clientDir, "index.html"), html);
  writeFileSync(path.join(clientDir, "page.json"), `${JSON.stringify(page, null, 2)}\n`);
  console.log(
    `prerendered dist/client/index.html: ${page.scriptHashes.length} inline scripts, ${page.fontPreloads.length} font preloads`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
