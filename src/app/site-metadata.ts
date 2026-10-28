import type { Metadata } from "next";
import { APPLE_TOUCH_ICON, SITE_ICONS, SITE_KEYWORDS, SITE_NAME, siteHead } from "@/lib/server/site/head";
import { siteUrl } from "@/lib/site-url";

/**
 * The site's default metadata in Next's terms, from `siteHead()`, so Next's
 * page and the Express page say the same thing. Built at each call so the
 * community setting is read then, never held in a module constant. The image
 * is Next's file convention (opengraph-image.png beside this file), not a key.
 */
export function siteMetadata(): Metadata {
  const head = siteHead();
  return {
    metadataBase: new URL(siteUrl()),
    applicationName: SITE_NAME,
    title: head.title,
    description: head.description,
    alternates: {
      canonical: head.canonical,
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
    keywords: SITE_KEYWORDS,
    openGraph: { ...head.openGraph },
    twitter: { ...head.twitter },
    icons: {
      icon: SITE_ICONS.map((icon) => ({ ...icon })),
      apple: APPLE_TOUCH_ICON,
    },
    other: {
      // The app is already dark. Without this, Dark Reader rewrites inline
      // styles before React hydrates (hydration mismatches). Next drops empty
      // metadata values, so it carries one; Dark Reader only checks the tag.
      "darkreader-lock": "true",
    },
  };
}
