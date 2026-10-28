import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

const plans = [
  {
    id: "p 1",
    name: "Steel",
    description: "Makes steel",
    updated_at: "2026-05-01T10:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "p2",
    name: "Iron",
    description: "",
    updated_at: null,
    created_at: "2026-02-01T00:00:00.000Z",
    machine_count: 2,
  },
];
const configured = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/server/services/config", () => ({ isDatabaseConfigured: () => configured.value }));
vi.mock("@/lib/server/services/community-plans", () => ({
  publicPlansByScore: async () => plans,
}));

import { llmsText, robots, robotsTxt, sitemapEntries, sitemapXml, webManifest } from "./site-files";

const ORIGIN = "http://127.0.0.1:3770";
const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const timeless = (xml: string) =>
  xml.replace(/<lastmod>[^<]*<\/lastmod>/g, "<lastmod><time></lastmod>");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  configured.value = true;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("with the community switch off", () => {
  withModAndCommunityUnset();

  it("writes the robots.txt and manifest Next writes", () => {
    expect(robotsTxt()).toBe(fixture("next-robots-off.txt"));
    expect(JSON.stringify(webManifest())).toBe(fixture("next-manifest.json"));
  });

  it("lists only the home page", async () => {
    const entries = await sitemapEntries();
    expect(entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/`]);
  });
});

describe("with the community switch on", () => {
  withModAndCommunityOn();

  it("writes the sitemap, robots and manifest Next writes", async () => {
    configured.value = false;
    expect(timeless(sitemapXml(await sitemapEntries()))).toBe(fixture("next-sitemap-on.xml"));
    expect(robotsTxt()).toBe(fixture("next-robots-on.txt"));
    expect(JSON.stringify(webManifest())).toBe(fixture("next-manifest.json"));
  });

  it("writes a plan's entry as Next's sitemap writer does", async () => {
    const entries = await sitemapEntries();
    expect(entries.map((entry) => entry.url)).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/?plan=p%201`,
      `${ORIGIN}/?plan=p2`,
    ]);
    const xml = sitemapXml(entries);
    expect(xml).toContain(
      `<url>\n<loc>${ORIGIN}/?plan=p%201</loc>\n<lastmod>2026-05-01T10:00:00.000Z</lastmod>\n<changefreq>monthly</changefreq>\n<priority>0.6</priority>\n</url>\n`,
    );
    expect(xml).toContain(
      `<loc>${ORIGIN}/?plan=p2</loc>\n<lastmod>2026-02-01T00:00:00.000Z</lastmod>\n`,
    );
    expect(xml.endsWith("</url>\n</urlset>\n")).toBe(true);
    // A text date is written as given.
    expect(sitemapXml([{ url: "x", lastModified: "2026-01-01" }])).toContain(
      "<lastmod>2026-01-01</lastmod>",
    );
    expect(robots().rules).toEqual([
      { userAgent: "*", allow: ["/"], disallow: ["/api/", "/datasets/"] },
    ]);
  });

  it("lists plans in llms.txt", async () => {
    const text = await llmsText();
    expect(text).toContain("## Popular community plans");
    expect(text).toContain(`- [Steel](${ORIGIN}/?plan=p%201): Makes steel`);
  });
});
