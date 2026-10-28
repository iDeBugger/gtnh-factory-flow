import { isModAndCommunityOn } from "@/lib/deployment-features";
import type { PlanRow } from "@/lib/server/community-rows";
import { describePlanRow, getPublicPlanRow } from "@/lib/server/services/plan-preview";
import { escapeAttribute, escapeHtml } from "./escape";

/**
 * The page's metadata, framework-free: what Next's layout and page metadata
 * say, and the tags Next writes for them. Next's pages build their metadata
 * from here, and the Express page renders it with `renderHead`, so both say
 * the same thing.
 */

export interface OpenGraph {
  title: string;
  description: string;
  siteName: string;
  type: "website";
  /** A path, resolved against the site's origin. */
  url: string;
}

export interface Twitter {
  card: "summary_large_image";
  title: string;
  description: string;
}

export interface OgImage {
  /** A path on the site, without the cache-busting query (`HeadAssetVersions`). */
  url: string;
  type: string;
  width: number;
  height: number;
  alt: string;
}

export interface PageHead {
  title: string;
  description: string;
  /** A path, resolved against the site's origin. */
  canonical: string;
  openGraph: OpenGraph;
  twitter: Twitter;
  image?: OgImage;
}

/**
 * The query each versioned site file carries, so a crawler or browser that
 * kept the old file asks again once it changes. Next writes the name its
 * bundler gave the file (`?opengraph-image.<content hash>.png`, the same for
 * the favicon); the path serves the file whatever the query says. Absent, the
 * URL carries no query.
 */
export interface HeadAssetVersions {
  ogImage?: string;
  favicon?: string;
}

export const SITE_NAME = "GTNH Planner";
export const SITE_TITLE = "GTNH Planner | GregTech New Horizons Factory Calculator";
export const THEME_COLOR = "#1b1d21";

export const SITE_KEYWORDS = [
  "GTNH Planner",
  "GregTech New Horizons planner",
  "GTNH factory planner",
  "GTNH recipe calculator",
  "GTNH throughput calculator",
  "GregTech factory calculator",
];

/** The site icons after the favicon, as `<link rel="icon">` in this order. */
export const SITE_ICONS = [
  { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
  { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
];
export const APPLE_TOUCH_ICON = "/apple-touch-icon.png";

/**
 * `src/app/opengraph-image.png` and its `.alt.txt`, which Next turns into the
 * og:image and twitter:image tags of every page. The alt text is the file's
 * whole content, its last newline included, as Next reads it
 * (head.test.ts holds both to the files).
 */
export const SITE_IMAGE: OgImage = {
  url: "/opengraph-image.png",
  type: "image/png",
  width: 1200,
  height: 630,
  alt: "The GTNH Planner board: a Benzene setup drawn as a flowchart, with the item list on the left and the plan totals on the right\n",
};

/** `src/app/favicon.ico`, which Next links before the other icons. */
const FAVICON = { url: "/favicon.ico", sizes: "48x48", type: "image/x-icon" };

/**
 * The site's own head, built at each call so the community setting is read
 * then: the community clause is said only where the community library is on.
 */
export function siteHead(): PageHead {
  const community = isModAndCommunityOn();
  const shareClause = community
    ? "balance machine ratios, find bottlenecks, and share plans with the community."
    : "balance machine ratios, and find bottlenecks.";
  const socialDescription = `Free factory planner for GregTech: New Horizons with full recipe data for GTNH 2.9 and 2.8.1. Draw production chains, ${shareClause}`;
  return {
    title: SITE_TITLE,
    description: `Plan and optimize GregTech: New Horizons factories on an interactive flowchart. Full recipe data for GTNH 2.9 and 2.8.1, throughput and power calculation, ${community ? "machine ratios, and community-shared plans." : "and machine ratios."}`,
    canonical: "/",
    openGraph: {
      title: SITE_TITLE,
      description: socialDescription,
      siteName: SITE_NAME,
      type: "website",
      url: "/",
    },
    twitter: {
      card: "summary_large_image",
      title: SITE_TITLE,
      description: socialDescription,
    },
    image: SITE_IMAGE,
  };
}

/**
 * A shared plan's head: its name and the author's words (or the plan's
 * numbers), over the site's own image. Next merges a page's metadata into the
 * layout's per top-level key, so the plan's openGraph and twitter replace the
 * site's whole, and the image (a file convention, not a key) stays.
 */
export function planHead(row: PlanRow): PageHead {
  const description = describePlanRow(row);
  const planUrl = `/?plan=${encodeURIComponent(row.id)}`;
  return {
    title: `${row.name} | ${SITE_NAME}`,
    description,
    canonical: planUrl,
    openGraph: {
      title: row.name,
      description,
      siteName: SITE_NAME,
      type: "website",
      url: planUrl,
    },
    twitter: {
      card: "summary_large_image",
      title: row.name,
      description,
    },
    image: SITE_IMAGE,
  };
}

/**
 * The head of `/` for this query: a public plan's while the community library
 * is on, the site's for any other visit. Only a single `plan` parameter names
 * a plan, as in Next, where a repeated one arrives as a list.
 */
export async function headForRequest(search: URLSearchParams): Promise<PageHead> {
  if (!isModAndCommunityOn()) {
    return siteHead();
  }
  const plans = search.getAll("plan");
  const planId = plans.length === 1 ? plans[0] : undefined;
  const row = planId ? await getPublicPlanRow(planId) : undefined;
  return row ? planHead(row) : siteHead();
}

/**
 * Next's `metadataBase` join: the path is joined onto the base's own path.
 * `resolveUrl` in next/dist/lib/metadata/resolvers/resolve-url.js.
 */
function resolveUrl(path: string, origin: string): URL {
  const base = new URL(origin);
  const joined = `${base.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return new URL(joined, base);
}

/**
 * Next's canonical and og:url rule (`resolveAbsoluteUrlWithPathname`, no
 * trailing slash): the site root with no query is the bare origin, anything
 * else the full URL.
 */
function pageUrl(path: string, origin: string): string {
  const url = resolveUrl(path, origin);
  return url.pathname === "/" && url.searchParams.size === 0 ? url.origin : url.href;
}

function versioned(path: string, version: string | undefined): string {
  return version ? `${path}?${version}` : path;
}

const meta = (key: "name" | "property", name: string, content: string) =>
  `<meta ${key}="${escapeAttribute(name)}" content="${escapeAttribute(content)}"/>`;

const link = (attributes: [string, string][]) =>
  `<link ${attributes.map(([name, value]) => `${name}="${escapeAttribute(value)}"`).join(" ")}/>`;

/**
 * The metadata tags of the page, in the order Next writes them: charset,
 * viewport and theme color first, then title, description, the site-wide
 * tags, canonical, Open Graph with its image, Twitter with its image, and the
 * icons. Page URLs are absolute against `origin` (`siteUrl()`, Next's
 * `metadataBase`); the icons and the manifest stay paths, as Next leaves them.
 * Every value goes through the escaping React applies.
 */
export function renderHead(
  head: PageHead,
  origin: string,
  versions: HeadAssetVersions = {},
): string {
  const tags = [
    '<meta charSet="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    meta("name", "theme-color", THEME_COLOR),
    `<title>${escapeHtml(head.title)}</title>`,
    meta("name", "description", head.description),
    meta("name", "application-name", SITE_NAME),
    link([
      ["rel", "manifest"],
      ["href", "/manifest.webmanifest"],
    ]),
    meta("name", "keywords", SITE_KEYWORDS.join(",")),
    meta("name", "robots", "index, follow"),
    meta(
      "name",
      "googlebot",
      "index, follow, max-video-preview:-1, max-image-preview:large, max-snippet:-1",
    ),
    meta("name", "darkreader-lock", "true"),
    link([
      ["rel", "canonical"],
      ["href", pageUrl(head.canonical, origin)],
    ]),
    meta("property", "og:title", head.openGraph.title),
    meta("property", "og:description", head.openGraph.description),
    meta("property", "og:url", pageUrl(head.openGraph.url, origin)),
    meta("property", "og:site_name", head.openGraph.siteName),
  ];
  const image = head.image;
  const imageUrl = image
    ? resolveUrl(versioned(image.url, versions.ogImage), origin).href
    : undefined;
  if (image && imageUrl) {
    tags.push(
      meta("property", "og:image", imageUrl),
      meta("property", "og:image:type", image.type),
      meta("property", "og:image:width", String(image.width)),
      meta("property", "og:image:height", String(image.height)),
      meta("property", "og:image:alt", image.alt),
    );
  }
  tags.push(
    meta("property", "og:type", head.openGraph.type),
    meta("name", "twitter:card", head.twitter.card),
    meta("name", "twitter:title", head.twitter.title),
    meta("name", "twitter:description", head.twitter.description),
  );
  if (image && imageUrl) {
    tags.push(
      meta("name", "twitter:image", imageUrl),
      meta("name", "twitter:image:alt", image.alt),
      meta("name", "twitter:image:type", image.type),
      meta("name", "twitter:image:width", String(image.width)),
      meta("name", "twitter:image:height", String(image.height)),
    );
  }
  tags.push(
    link([
      ["rel", "icon"],
      ["href", versioned(FAVICON.url, versions.favicon)],
      ["sizes", FAVICON.sizes],
      ["type", FAVICON.type],
    ]),
    ...SITE_ICONS.map((icon) =>
      link([
        ["rel", "icon"],
        ["href", icon.url],
        ["type", icon.type],
        ["sizes", icon.sizes],
      ]),
    ),
    link([
      ["rel", "apple-touch-icon"],
      ["href", APPLE_TOUCH_ICON],
    ]),
  );
  return tags.join("");
}
