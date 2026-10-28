import type { MetadataRoute } from "next";
import { robots as siteRobots } from "@/lib/server/site/site-files";

/** The site's crawl rules (`robots` in site-files.ts); Next writes the text. */
export default function robots(): MetadataRoute.Robots {
  return siteRobots();
}
