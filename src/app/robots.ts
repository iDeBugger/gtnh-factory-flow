import type { MetadataRoute } from "next";
import { isModAndCommunityOn } from "@/lib/deployment-features";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gtnhplanner.com";
  return {
    rules: [
      {
        userAgent: "*",
        // The card route stays crawlable: Twitterbot honours robots.txt, and
        // blocking it would strip the image off every shared plan's unfurl.
        // With the community library switched off there is no card to allow.
        allow: isModAndCommunityOn() ? ["/", "/api/community/plans/*/card"] : ["/"],
        // JSON endpoints and dataset shards have no place in an index.
        disallow: ["/api/", "/datasets/"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
