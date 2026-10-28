import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assetVersion,
  fillTemplate,
  fontPreloads,
  inlineScriptHashes,
  PRELOAD_ALL_FONTS,
  siteAssetVersions,
} from "./prerender.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FONTS_CSS = path.join(ROOT, "src/client/fonts.css");

/**
 * A Vite manifest naming every font file fonts.css loads, as `vite build` writes it for CSS assets: keyed by the
 * path under the Vite root (src/client).
 */
function manifestForFonts() {
  const manifest = {};
  for (const [, url] of readFileSync(FONTS_CSS, "utf8").matchAll(/url\("([^"]+)"\)/g)) {
    const key = path.posix.normalize(url);
    const name = path.posix.basename(url).replace(/(\.[a-z0-9]+)$/, "-HASH$1");
    manifest[key] = { file: `assets/${name}`, src: key };
  }
  return manifest;
}

describe("page.json", () => {
  it("preloads only the default face, Inter, by the owner's choice", () => {
    expect(PRELOAD_ALL_FONTS).toBe(false);
    expect(fontPreloads(manifestForFonts())).toEqual([
      { href: "/assets/inter-latin-HASH.woff2", type: "font/woff2" },
    ]);
  });

  it("can still name Next's 17 preloads, in its order", () => {
    const all = fontPreloads(manifestForFonts(), true);
    expect(all).toHaveLength(17);
    expect(all[0].href).toBe("/assets/jetbrains-mono-latin-HASH.woff2");
    expect(all.map((preload) => preload.type).filter((type) => type === "font/ttf")).toHaveLength(
      6,
    );
  });

  it("hashes the inline scripts the browser runs, and no data block or external script", () => {
    const html =
      '<script>a()</script><script type="application/ld+json">{"x":1}</script>' +
      '<script type="module" src="/assets/index.js"></script><script type="module">b()</script>';
    const hash = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    expect(inlineScriptHashes(html)).toEqual([hash("a()"), hash("b()")]);
  });

  it("reads the type in double quotes, single quotes or none", () => {
    const html =
      "<script type='application/ld+json'>{}</script><script type=application/ld+json>{}</script>" +
      "<script type='module'>c()</script><script type=text/javascript>d()</script>";
    const hash = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    expect(inlineScriptHashes(html)).toEqual([hash("c()"), hash("d()")]);
  });

  it("fills the boot scripts and the shell, and leaves the head for the server", () => {
    const template =
      "<head><!--app-head--></head><body><!--app-boot--><div id=root><!--app-shell--></div></body>";
    const html = fillTemplate(template, {
      shell: "<main>$&</main>",
      bootScripts: ["one()", "two()"],
      structuredData: '{"a":1}',
    });
    expect(html).toBe(
      '<head><!--app-head--></head><body><script>one()</script><script>two()</script><script type="application/ld+json">{"a":1}</script><div id=root><main>$&</main></div></body>',
    );
    expect(() =>
      fillTemplate("<!--app-boot--><!--app-shell-->", {
        shell: "",
        bootScripts: [],
        structuredData: "",
      }),
    ).toThrow();
  });

  it("versions the og image and the favicon by their own bytes", () => {
    const one = assetVersion("opengraph-image.png", Buffer.from("one"));
    expect(one).toMatch(/^opengraph-image\.[0-9a-f]{16}\.png$/);
    expect(assetVersion("opengraph-image.png", Buffer.from("one"))).toBe(one);
    expect(assetVersion("opengraph-image.png", Buffer.from("two"))).not.toBe(one);
    const versions = siteAssetVersions(ROOT);
    expect(versions.ogImage).toBe(
      assetVersion(
        "opengraph-image.png",
        readFileSync(path.join(ROOT, "src/server/page/assets/opengraph-image.png")),
      ),
    );
    expect(versions.favicon).toMatch(/^favicon\.[0-9a-f]{16}\.ico$/);
  });
});

describe("fonts.css", () => {
  it("loads only vendored files, each with its licence beside it", () => {
    const urls = [...readFileSync(FONTS_CSS, "utf8").matchAll(/url\("([^"]+)"\)/g)].map(
      (match) => match[1],
    );
    expect(urls).toHaveLength(40);
    for (const url of urls) {
      expect(existsSync(path.join(ROOT, "src/client", url)), url).toBe(true);
    }
    for (const licence of [
      "Inter",
      "JetBrainsMono",
      "Lexend",
      "AtkinsonHyperlegible",
      "Andika",
      "ComicNeue",
      "Monocraft",
      "OpenDyslexic",
    ]) {
      expect(
        readFileSync(path.join(ROOT, `src/client/fonts/${licence}-LICENSE`), "utf8"),
      ).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });
});
