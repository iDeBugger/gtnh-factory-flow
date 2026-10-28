import { readFileSync } from "node:fs";
import path from "node:path";
import type { Response } from "express";
import { HEAD_LEAD, type HeadAssetVersions } from "@/lib/server/site/head";
import { escapeAttribute } from "@/lib/server/site/escape";

/** A font file the page preloads, as page.json names it. */
export interface FontPreload {
  href: string;
  type: string;
}

/**
 * The built page (`dist/client/index.html`) and what the build says about it (`page.json`): the hashes of its
 * inline scripts, the fonts it preloads and the version queries of the site image and the favicon.
 */
export interface PageTemplate {
  html: string;
  scriptHashes: string[];
  fontPreloads: FontPreload[];
  assetVersions: HeadAssetVersions;
}

const HEAD_MARK = "<!--app-head-->";

/**
 * The head in Next's order: the charset and the viewport first, then the font preloads and the stylesheet and
 * script tags the build wrote after the mark, then the per-request metadata at the mark. The charset leads so
 * the browser meets it within the first 1024 bytes, before any tag it must read as text.
 */
function arrangeHead(html: string, fontPreloads: FontPreload[]): string {
  if (html.split(HEAD_MARK).length !== 2) {
    throw new Error(`The page template must hold ${HEAD_MARK} once.`);
  }
  const match = /<head>([\s\S]*?)<\/head>/.exec(html);
  if (!match || !match[1]!.includes(HEAD_MARK)) {
    throw new Error(`The page template's <head> must hold ${HEAD_MARK}.`);
  }
  const [before, after] = match[1]!.split(HEAD_MARK) as [string, string];
  if (before.trim() !== "") {
    throw new Error(`The page template's <head> must open with ${HEAD_MARK}.`);
  }
  const buildTags = after
    .split("\n")
    .map((line) => line.trim())
    .join("");
  // The build hashed each inline script as it wrote it; joining the lines must leave every one unchanged.
  if (inlineScripts(buildTags).join("\0") !== inlineScripts(after).join("\0")) {
    throw new Error(
      "An inline script in the page template's head spans lines: joining the head's lines would change it, and its build hash would no longer match.",
    );
  }
  const head = HEAD_LEAD + fontPreloads.map(preloadTag).join("") + buildTags + HEAD_MARK;
  return (
    html.slice(0, match.index) + `<head>${head}</head>` + html.slice(match.index + match[0].length)
  );
}

/** The text of each inline script (one without `src`) in `html`, in order. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\ssrc\s*=/i.test(match[1] ?? ""))
    .map((match) => match[2]!);
}

function preloadTag(font: FontPreload): string {
  return `<link rel="preload" href="${escapeAttribute(font.href)}" as="font" type="${escapeAttribute(font.type)}" crossorigin=""/>`;
}

/** One CSP hash source as the build writes it. */
const SCRIPT_HASH = /^'sha256-[A-Za-z0-9+/]{43}='$/;

/**
 * page.json's script hashes, refused when missing, empty or malformed. The page always carries its boot
 * scripts, so an empty list means the build lost them, and the policy must not lose them with it.
 */
function checkedScriptHashes(hashes: unknown): string[] {
  if (
    !Array.isArray(hashes) ||
    hashes.length === 0 ||
    !hashes.every((hash) => typeof hash === "string" && SCRIPT_HASH.test(hash))
  ) {
    throw new Error(
      "page.json must list the sha256 hash of every inline script the page runs (scriptHashes).",
    );
  }
  return hashes as string[];
}

/** Reads the built page and its page.json once, at start. A page.json without its script hashes is refused. */
export function loadPageTemplate(clientDir: string): PageTemplate {
  const html = readFileSync(path.join(clientDir, "index.html"), "utf8");
  const page = JSON.parse(readFileSync(path.join(clientDir, "page.json"), "utf8")) as {
    scriptHashes?: unknown;
    fontPreloads: FontPreload[];
    assetVersions?: HeadAssetVersions;
  };
  return {
    html: arrangeHead(html, page.fontPreloads),
    scriptHashes: checkedScriptHashes(page.scriptHashes),
    fontPreloads: page.fontPreloads,
    assetVersions: page.assetVersions ?? {},
  };
}

/** The page with `head` (the metadata tags, `renderMetadataTags`) at the head mark. */
export function renderPage(template: PageTemplate, head: string): string {
  // A function, so a `$` in player text is never read as a replacement pattern.
  return template.html.replace(HEAD_MARK, () => head);
}

/** The `Link` header Next sent on the page's answers: one font preload per item, in page.json's order. */
export function preloadLinkHeader(fonts: FontPreload[]): string {
  return fonts
    .map((font) => `<${font.href}>; rel=preload; as="font"; crossorigin=""; type="${font.type}"`)
    .join(", ");
}

/** Next's no-store rule for a page it rendered per request. */
export const PAGE_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

/**
 * The headers Next put on every answer of a dynamic page, the 307 of `redirect()` included: `vary` (its
 * compression's Accept-Encoding; the router's names are gone with the router), the font preloads, no-store and
 * the HTML type.
 */
export function setPageHeaders(res: Response, link: string): void {
  res.setHeader("vary", "Accept-Encoding");
  if (link) res.setHeader("link", link);
  res.setHeader("cache-control", PAGE_CACHE_CONTROL);
  res.setHeader("content-type", "text/html; charset=utf-8");
}

/** Next's answer to OPTIONS on a page: 400, no type, no body. */
export function pageOptionsAnswer(res: Response): void {
  res.statusCode = 400;
  res.end();
}
