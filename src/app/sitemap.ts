import type { MetadataRoute } from "next";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { publicPlansByScore } from "@/lib/server/services/community-plans";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { siteUrl } from "@/lib/site-url";

/** Re-query the plan list at most hourly, so crawl bursts cost one DB read. */
export const revalidate = 3600;

/**
 * The home page plus every public shared plan. A plan link carries its own
 * title, description and preview card (see `generateMetadata` in page.tsx),
 * so each one is a real page worth indexing, not just an app-state URL.
 * Only plans a stranger could open are listed: the same `is_public !== false`
 * rule the unfurler uses. With the community library switched off there are
 * no plan pages, so only the home page is listed.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const entries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
  ];

  if (!isModAndCommunityOn() || !isDatabaseConfigured()) {
    return entries;
  }

  try {
    const rows = await publicPlansByScore(1000, "links");
    for (const row of rows) {
      entries.push({
        url: `${base}/?plan=${encodeURIComponent(row.id)}`,
        lastModified: new Date(row.updated_at ?? row.created_at),
        changeFrequency: "monthly",
        priority: 0.6,
      });
    }
  } catch {
    // A sitemap that lists only the home page is still a valid sitemap.
  }

  return entries;
}
