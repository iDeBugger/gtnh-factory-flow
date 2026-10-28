import type { MetadataRoute } from "next";
import { sitemapEntries } from "@/lib/server/site/site-files";

/** Re-query the plan list at most hourly, so crawl bursts cost one DB read. */
export const revalidate = 3600;

/** The home page plus every public shared plan (`sitemapEntries`); Next writes the XML. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries();
}
