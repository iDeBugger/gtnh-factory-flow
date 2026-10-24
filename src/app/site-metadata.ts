import type { Metadata } from "next";
import { isModAndCommunityOn } from "@/lib/deployment-features";

export const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gtnhplanner.com";

/**
 * The site's default metadata, built at each call so the community setting is
 * read then, never held in a module constant: the community clause is said
 * only where the community library is on.
 */
export function siteMetadata(): Metadata {
  const community = isModAndCommunityOn();
  const shareClause = community
    ? "balance machine ratios, find bottlenecks, and share plans with the community."
    : "balance machine ratios, and find bottlenecks.";
  return {
    metadataBase: new URL(siteUrl),
    applicationName: "GTNH Planner",
    title: "GTNH Planner | GregTech New Horizons Factory Calculator",
    description:
      `Plan and optimize GregTech: New Horizons factories on an interactive flowchart. Full recipe data for GTNH 2.9, throughput and power calculation, ${community ? "machine ratios, and community-shared plans." : "and machine ratios."}`,
    alternates: {
      canonical: "/",
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
    keywords: [
      "GTNH Planner",
      "GregTech New Horizons planner",
      "GTNH factory planner",
      "GTNH recipe calculator",
      "GTNH throughput calculator",
      "GregTech factory calculator",
    ],
    openGraph: {
      title: "GTNH Planner | GregTech New Horizons Factory Calculator",
      description:
        `Free factory planner for GregTech: New Horizons with full recipe data for GTNH 2.9. Draw production chains, ${shareClause}`,
      siteName: "GTNH Planner",
      type: "website",
      url: "/",
    },
    twitter: {
      card: "summary_large_image",
      title: "GTNH Planner | GregTech New Horizons Factory Calculator",
      description:
        `Free factory planner for GregTech: New Horizons with full recipe data for GTNH 2.9. Draw production chains, ${shareClause}`,
    },
    icons: {
      icon: [
        { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
        { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
      ],
      apple: "/apple-touch-icon.png",
    },
    other: {
      // The app is already dark. Without this, Dark Reader rewrites inline
      // styles before React hydrates (hydration mismatches). Next drops empty
      // metadata values, so it carries one; Dark Reader only checks the tag.
      "darkreader-lock": "true",
    },
  };
}
