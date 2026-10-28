import { readFileSync } from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import {
  llmsText,
  robotsTxt,
  sitemapEntries,
  sitemapXml,
  webManifest,
} from "@/lib/server/site/site-files";
import { ttlMemo } from "@/lib/server/site/ttl-memo";
import { revalidatedMethodNotAllowed } from "../middleware/not-found";

/** How long the sitemap and llms.txt are served from memory: Next's `revalidate = 3600`. */
export const SITE_FILE_TTL_MS = 3_600_000;

/** What Next sent on a metadata file (sitemap, robots, manifest, favicon, og image): cached, but always revalidated. */
const METADATA_CACHE_CONTROL = "public, max-age=0, must-revalidate";

export interface SiteRoutesOptions {
  /** The folder holding `favicon.ico` and `opengraph-image.png`. */
  filesDir: string;
}

/**
 * The site files crawlers and browsers ask for, as Next's metadata files and the llms.txt route answered them:
 * GET and HEAD with Next's type and cache rule, and any other method Next's 405 with `Allow: GET` and
 * `Allow: HEAD`. The sitemap and llms.txt query the database, so each is held in memory for an hour; the
 * favicon and the og image are read once, at start. A conditional or range request gets the whole file, as
 * from Next.
 */
export function siteRoutes(options: SiteRoutesOptions): Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const sitemap = ttlMemo(SITE_FILE_TTL_MS, async () => sitemapXml(await sitemapEntries()));
  const llms = ttlMemo(SITE_FILE_TTL_MS, llmsText);
  const favicon = readFileSync(path.join(options.filesDir, "favicon.ico"));
  const ogImage = readFileSync(path.join(options.filesDir, "opengraph-image.png"));

  const files: [string, string, string, () => Promise<string | Buffer> | string | Buffer][] = [
    ["/sitemap.xml", "application/xml", METADATA_CACHE_CONTROL, sitemap],
    ["/robots.txt", "text/plain", METADATA_CACHE_CONTROL, robotsTxt],
    [
      "/manifest.webmanifest",
      "application/manifest+json",
      METADATA_CACHE_CONTROL,
      () => JSON.stringify(webManifest()),
    ],
    ["/favicon.ico", "image/x-icon", METADATA_CACHE_CONTROL, () => favicon],
    ["/opengraph-image.png", "image/png", METADATA_CACHE_CONTROL, () => ogImage],
    ["/llms.txt", "text/plain; charset=utf-8", "public, max-age=3600", llms],
  ];
  for (const [route, type, cacheControl, body] of files) {
    router.get(route, async (_req, res, next) => {
      try {
        const content = await body();
        res.statusCode = 200;
        res.setHeader("cache-control", cacheControl);
        res.setHeader("content-type", type);
        res.end(content);
      } catch (error) {
        next(error);
      }
    });
    router.all(route, revalidatedMethodNotAllowed());
  }
  return router;
}
