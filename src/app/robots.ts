import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        // JSON endpoints and dataset shards have no place in an index.
        disallow: ["/api/", "/datasets/"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
