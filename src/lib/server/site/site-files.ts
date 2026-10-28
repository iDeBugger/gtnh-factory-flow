import { isModAndCommunityOn } from "@/lib/deployment-features";
import { publicPlansByScore } from "@/lib/server/services/community-plans";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { describePlanRow, quietMarkdown } from "@/lib/server/services/plan-preview";
import { siteUrl } from "@/lib/site-url";
import { APP_VERSION } from "@/lib/version";

/**
 * The site files crawlers read (sitemap.xml, robots.txt, the web manifest,
 * llms.txt), framework-free. Next's metadata files return the data here and
 * Next writes it; `sitemapXml` and `robotsTxt` write it the way Next does
 * (`resolveSitemap` and `resolveRobots` in
 * next/dist/build/webpack/loaders/metadata/resolve-route-data.js), so a server
 * without Next sends the same bytes.
 */

export interface SitemapEntry {
  url: string;
  lastModified?: Date | string;
  changeFrequency?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

export interface RobotsRule {
  userAgent: string;
  allow: string[];
  disallow: string[];
}

export interface Robots {
  rules: RobotsRule[];
  sitemap: string;
}

/**
 * The home page plus every public shared plan. A plan link carries its own
 * title and description (head.ts), so each one is a real page worth indexing,
 * not just an app-state URL. Only plans a stranger could open are listed: the
 * same `is_public !== false` rule the page head uses. With the community
 * library switched off there are no plan pages, so only the home page is
 * listed.
 */
export async function sitemapEntries(): Promise<SitemapEntry[]> {
  const base = siteUrl();
  const entries: SitemapEntry[] = [
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

/**
 * Next's sitemap writer for the fields the site uses. Next writes each value
 * as it is, unescaped: every URL here is the site's origin plus an encoded
 * plan id, which holds no `&` or `<`.
 */
export function sitemapXml(entries: SitemapEntry[]): string {
  let content = '<?xml version="1.0" encoding="UTF-8"?>\n';
  content += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const entry of entries) {
    content += "<url>\n";
    content += `<loc>${entry.url}</loc>\n`;
    if (entry.lastModified) {
      const date =
        entry.lastModified instanceof Date ? entry.lastModified.toISOString() : entry.lastModified;
      content += `<lastmod>${date}</lastmod>\n`;
    }
    if (entry.changeFrequency) {
      content += `<changefreq>${entry.changeFrequency}</changefreq>\n`;
    }
    if (typeof entry.priority === "number") {
      content += `<priority>${entry.priority}</priority>\n`;
    }
    content += "</url>\n";
  }
  content += "</urlset>\n";
  return content;
}

/** Crawlers may read the site; JSON endpoints and dataset shards have no place in an index. */
export function robots(): Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/"], disallow: ["/api/", "/datasets/"] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}

/** robots.txt as Next writes `robots()`: each rule's lines and a blank line, then the sitemap. */
export function robotsTxt(): string {
  const data = robots();
  let content = "";
  for (const rule of data.rules) {
    content += `User-Agent: ${rule.userAgent}\n`;
    for (const path of rule.allow) {
      content += `Allow: ${path}\n`;
    }
    for (const path of rule.disallow) {
      content += `Disallow: ${path}\n`;
    }
    content += "\n";
  }
  content += `Sitemap: ${data.sitemap}\n`;
  return content;
}

/** The web app manifest. Next and the Express site both send it as `JSON.stringify` of this. */
export function webManifest() {
  return {
    name: "GTNH Planner",
    short_name: "GTNH Planner",
    description: "Factory planner and recipe calculator for GregTech: New Horizons.",
    start_url: "/",
    display: "standalone" as const,
    background_color: "#1b1d21",
    theme_color: "#1b1d21",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable" as const,
      },
    ],
  };
}

async function topPlans(base: string): Promise<string[]> {
  if (!isModAndCommunityOn() || !isDatabaseConfigured()) {
    return [];
  }
  try {
    const rows = await publicPlansByScore(10, "summary");
    // A name and a description are player text: one line each, with no markdown of their own.
    return rows.map(
      (row) =>
        `- [${quietMarkdown(row.name)}](${base}/?plan=${encodeURIComponent(row.id)}): ${quietMarkdown(describePlanRow(row))}`,
    );
  } catch {
    return [];
  }
}

/**
 * The site as one page of markdown for language-model crawlers (the llms.txt
 * convention), which run no JavaScript and so see the planner as an empty
 * page. Top shared plans are linked because each plan URL server-renders its
 * name and summary into metadata. With the community library switched off,
 * neither the plans nor the community are mentioned.
 */
export async function llmsText(): Promise<string> {
  const base = siteUrl();
  const community = isModAndCommunityOn();
  const plans = await topPlans(base);

  const lines = [
    "# GTNH Planner",
    "",
    `> Free browser-based factory planner and recipe calculator for GregTech: New Horizons (GTNH), the Minecraft expert modpack. Draw production chains on an interactive flowchart, balance machine ratios, ${community ? "compute EU/t power draw and throughput, and share plans with the community" : "and compute EU/t power draw and throughput"}. No account and no install needed.`,
    "",
    "Key facts:",
    "",
    "- Carries full recipe data for GTNH 2.9 and 2.8.1, exported from the game itself (NEI/RecEx), including multiblock machines, ore dictionary alternatives, and programmed circuit settings.",
    "- Models GregTech mechanics faithfully: voltage tiers and overclocking, parallel processing on multiblocks, heat bonuses on the Electric Blast Furnace family, machine-specific speed and power coefficients.",
    "- A solver computes steady-state flow for the whole factory at once: what every machine produces and consumes per second, where the bottleneck is, and how full each machine runs.",
    "- Plans export as shareable links, JSON, PNG, or GIF. Opening a shared link loads the full plan, editable, with nothing to sign up for.",
    "- The planner is a client-side application. Pages carry little static HTML; a plan link's name and summary are server-rendered into its page metadata, so fetching a plan URL is the way to read a plan.",
    `- Version ${APP_VERSION} as of this file; ${base}/api/version reports what is live.`,
    "",
    "## Start here",
    "",
    `- [The planner](${base}/): the app itself. Everything happens on one page.`,
    community
      ? `- [Sitemap](${base}/sitemap.xml): the home page plus every public community plan.`
      : `- [Sitemap](${base}/sitemap.xml): the home page.`,
    "",
  ];

  if (plans.length > 0) {
    lines.push("## Popular community plans", "", ...plans, "");
  }

  return lines.join("\n");
}
