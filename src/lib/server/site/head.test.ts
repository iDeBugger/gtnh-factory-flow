import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRow } from "@/lib/server/community-rows";
import { readPngHeader } from "@/lib/server/services/plan-preview";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

const getPublicPlanRow = vi.fn<(id: string) => Promise<PlanRow | undefined>>();
vi.mock("@/lib/server/services/plan-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/services/plan-preview")>()),
  getPublicPlanRow: (id: string) => getPublicPlanRow(id),
}));

import { FAVICON, renderHead, SITE_IMAGE, siteHead } from "./head";
import { headForRequest, planHead } from "./plan-head";

const ORIGIN = "http://127.0.0.1:3770";
const PLAN_ID = "00000000-0000-4000-8000-0000000000c1";
const VERSIONS = { ogImage: "opengraph-image.x.png", favicon: "favicon.x.ico" };

const row = {
  id: PLAN_ID,
  name: "Parity plan",
  description: "A plan for the parity run.",
  machine_count: 1,
  highest_tier: null,
  author_name: "parity",
  needs: [],
  outputs: [],
  game_version: "",
} as unknown as PlanRow;

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

/**
 * One tag per line, in the order written (order is part of the compare), with
 * the cache-busting query of the site image and the favicon as `?<hash>`: Next
 * takes it from its bundler's file name, the Express build from its own hash.
 */
function tagsOneLine(html: string): string {
  const tags =
    html.match(/<title>[\s\S]*?<\/title>|<meta\b(?:"[^"]*"|[^>"])*>|<link\b(?:"[^"]*"|[^>"])*>/g) ??
    [];
  return (
    tags
      .map((tag) =>
        tag
          .replace(/(\/opengraph-image\.png)\?[^"]+"/, '$1?<hash>"')
          .replace(/(\/favicon\.ico)\?[^"]+"/, '$1?<hash>"'),
      )
      .join("\n") + "\n"
  );
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  getPublicPlanRow.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("with the community switch off", () => {
  withModAndCommunityUnset();

  it("renders the site head exactly as Next does, mode off", () => {
    expect(tagsOneLine(renderHead(siteHead(), ORIGIN, VERSIONS))).toBe(
      fixture("next-head-off.html"),
    );
  });

  it("gives a ?plan= link the site head, with no lookup", async () => {
    getPublicPlanRow.mockResolvedValue(row);
    expect(await headForRequest(new URLSearchParams(`plan=${PLAN_ID}`))).toEqual(siteHead());
    expect(getPublicPlanRow).not.toHaveBeenCalled();
  });
});

describe("with the community switch on", () => {
  withModAndCommunityOn();

  it("renders the site head exactly as Next does, mode on", () => {
    expect(tagsOneLine(renderHead(siteHead(), ORIGIN, VERSIONS))).toBe(
      fixture("next-head-on.html"),
    );
  });

  it("renders a plan's head exactly as Next does", () => {
    expect(tagsOneLine(renderHead(planHead(row), ORIGIN, VERSIONS))).toBe(
      fixture("next-head-on-plan.html"),
    );
  });

  it("looks the plan up and renders its head", async () => {
    getPublicPlanRow.mockResolvedValue(row);
    expect(await headForRequest(new URLSearchParams(`plan=${PLAN_ID}&x=1`))).toEqual(planHead(row));
    expect(getPublicPlanRow).toHaveBeenCalledWith(PLAN_ID);
  });

  it("falls back to the site head for a missing plan, a plan crawlers may not see, no plan and a repeated plan", async () => {
    getPublicPlanRow.mockResolvedValue(undefined);
    expect(await headForRequest(new URLSearchParams("plan=missing"))).toEqual(siteHead());
    expect(await headForRequest(new URLSearchParams(""))).toEqual(siteHead());
    expect(await headForRequest(new URLSearchParams("plan="))).toEqual(siteHead());
    getPublicPlanRow.mockClear();
    getPublicPlanRow.mockResolvedValue(row);
    // Next reads a repeated parameter as a list, and only a single string names a plan.
    expect(await headForRequest(new URLSearchParams(`plan=${PLAN_ID}&plan=${PLAN_ID}`))).toEqual(
      siteHead(),
    );
    expect(getPublicPlanRow).not.toHaveBeenCalled();
  });

  it("escapes player text in every tag that carries it", () => {
    const html = renderHead(
      planHead({ ...row, name: `</title><script>x</script>"&'`, description: "a\nb" }),
      ORIGIN,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
    expect(html).toContain("&quot;&amp;&#x27;");
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<meta name="description" content="a\nb"/>');
    const escaped = "&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;&quot;&amp;&#x27;";
    expect(html).toContain(`<title>${escaped} | GTNH Planner</title>`);
    expect(html).toContain(`<meta property="og:title" content="${escaped}"/>`);
    expect(html).toContain(`<meta name="twitter:title" content="${escaped}"/>`);
  });

  it("writes no tag for an empty value, as Next does", () => {
    const empty = planHead({ ...row, name: "" });
    const html = renderHead(
      {
        ...empty,
        title: "",
        description: "",
        openGraph: { ...empty.openGraph, description: "" },
        twitter: { ...empty.twitter, description: "" },
      },
      ORIGIN,
    );
    expect(html).not.toContain("<title>");
    expect(html).not.toMatch(/content=""/);
    for (const name of [
      "description",
      "og:title",
      "og:description",
      "twitter:title",
      "twitter:description",
    ]) {
      expect(html, name).not.toMatch(new RegExp(`(name|property)="${name}"`));
    }
    expect(html).toContain('<meta property="og:site_name" content="GTNH Planner"/>');
  });

  it("links a plan id that needs escaping as Next's URL resolution writes it", () => {
    const html = renderHead(planHead({ ...row, id: `a b&"'` }), ORIGIN);
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/?plan=a%20b%26%22%27"/>`);
  });
});

describe("the head module", () => {
  it("loads no database module, so the template and the 404 page load none through it", () => {
    const source = readFileSync(new URL("./head.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gms)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["@/lib/deployment-features", "./escape"]);
  });
});

describe("the site image", () => {
  it("is the file beside the pages, with its alt text and size", () => {
    const alt = readFileSync(
      new URL("../../../server/page/assets/opengraph-image.alt.txt", import.meta.url),
      "utf8",
    );
    expect(SITE_IMAGE.alt).toBe(alt);
    const png = readFileSync(
      new URL("../../../server/page/assets/opengraph-image.png", import.meta.url),
    );
    expect(readPngHeader(png)).toEqual({ width: SITE_IMAGE.width, height: SITE_IMAGE.height });
  });

  it("links the favicon with the type and the largest size the file holds", () => {
    const ico = readFileSync(new URL("../../../server/page/assets/favicon.ico", import.meta.url));
    // ICONDIR: reserved 0, type 1 (an icon), then one 16-byte entry per image (a 0 side means 256).
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const sides = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
      const at = 6 + 16 * index;
      return [ico[at] || 256, ico[at + 1] || 256] as const;
    });
    const largest = sides.reduce((best, side) =>
      side[0] * side[1] > best[0] * best[1] ? side : best,
    );
    expect(FAVICON.sizes).toBe(`${largest[0]}x${largest[1]}`);
    expect(FAVICON.type).toBe("image/x-icon");
  });

  it("carries no query when the build gives no version", () => {
    const html = renderHead(siteHead(), ORIGIN);
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/opengraph-image.png"/>`);
    expect(html).toContain(
      '<link rel="icon" href="/favicon.ico" sizes="48x48" type="image/x-icon"/>',
    );
  });
});
