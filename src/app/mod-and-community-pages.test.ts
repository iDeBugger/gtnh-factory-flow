import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { json } from "@/lib/server/db";
import { setDbFaultForTests } from "@/lib/server/db/guard";
import { clearDbFault, useTestDb, withDbFault } from "@/test-support/test-db";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

const row = {
  id: "plan-1",
  name: "Steel line",
  description: "Makes steel",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: null,
};

vi.mock("@/lib/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/db")>();
  return {
    ...actual,
    isDatabaseConfigured: () => true,
  };
});
const getPublicPlanRow = vi.fn(async () => row);
vi.mock("@/lib/server/services/plan-preview", async (importOriginal) => ({
  quietMarkdown: (await importOriginal<typeof import("@/lib/server/services/plan-preview")>()).quietMarkdown,
  getPublicPlanRow: () => getPublicPlanRow(),
  describePlanRow: () => "Makes steel",
}));
vi.mock("@/components/FactoryPlannerApp", () => ({ FactoryPlannerApp: () => null }));

import sitemap from "./sitemap";
import robots from "./robots";
import { GET as llms } from "./llms.txt/route";
import Home, { generateMetadata } from "./page";
import { renderToStaticMarkup } from "react-dom/server";
import CommunityRedirect from "./community/page";
import { siteMetadata } from "./site-metadata";

const planSearch = { searchParams: Promise.resolve({ plan: "plan-1" }) };

const testDb = useTestDb();
const PUBLIC_ID = "00000000-0000-4000-8000-0000000000c1";
const PRIVATE_ID = "00000000-0000-4000-8000-0000000000c2";

/** Every statement the direct client sends until `clearDbFault`. */
function recordSql(): string[] {
  const sent: string[] = [];
  setDbFaultForTests((text) => {
    sent.push(text);
    return undefined;
  });
  return sent;
}

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stage.gtnhplanner.idebugger.net");
  const db = testDb().db;
  const owner = await db
    .insertInto("community_users")
    .values({ username: "smith", password_hash: "x:y" })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const [id, isPublic] of [
    [PUBLIC_ID, true],
    [PRIVATE_ID, false],
  ] as const) {
    await db
      .insertInto("community_plans")
      .values({
        id,
        user_id: owner.id,
        author_name: "smith",
        name: isPublic ? "Steel line" : "Draft line",
        plan: json({ nodes: [] }),
        is_public: isPublic,
        uploader_key: "test",
      })
      .execute();
  }
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("copy names both served versions", () => {
  withModAndCommunityUnset();

  it("the page metadata, the noscript paragraph and llms.txt name GTNH 2.9 and 2.8.1", async () => {
    const layoutMetadata = siteMetadata();
    expect(layoutMetadata.description).toContain("Full recipe data for GTNH 2.9 and 2.8.1,");
    expect(layoutMetadata.openGraph?.description).toContain("full recipe data for GTNH 2.9 and 2.8.1.");
    expect(layoutMetadata.twitter?.description).toContain("full recipe data for GTNH 2.9 and 2.8.1.");
    expect(String(layoutMetadata.description).toLowerCase()).not.toContain("community");
    const noscript = renderToStaticMarkup(Home());
    expect(noscript).toContain("full recipe data for GTNH 2.9 and 2.8.1,");
    expect(noscript.toLowerCase()).not.toContain("community");
    const text = await (await llms()).text();
    expect(text).toContain("- Carries full recipe data for GTNH 2.9 and 2.8.1, exported from the game itself");
  });
});

describe("with the setting unset", () => {
  withModAndCommunityUnset();

  it("the sitemap lists only the home page", async () => {
    const sent = recordSql();
    try {
      const entries = await sitemap();
      expect(entries.map((entry) => entry.url)).toEqual(["https://stage.gtnhplanner.idebugger.net/"]);
    } finally {
      clearDbFault();
    }
    expect(sent).toEqual([]);
  });

  it("llms.txt names no community plan and no community", async () => {
    const text = await (await llms()).text();
    expect(text).not.toContain("?plan=");
    expect(text.toLowerCase()).not.toContain("community");
    expect(text).toContain("balance machine ratios, and compute EU/t power draw and throughput. No account");
  });

  it("robots.txt allows no community card", () => {
    expect(robots().rules).toMatchObject([{ allow: ["/"] }]);
  });

  it("a ?plan= link gets the default metadata, with no lookup", async () => {
    getPublicPlanRow.mockClear();
    expect(await generateMetadata(planSearch)).toEqual({});
    expect(getPublicPlanRow).not.toHaveBeenCalled();
  });

  it("the site's descriptions say nothing of the community", () => {
    const meta = siteMetadata();
    for (const text of [meta.description, meta.openGraph?.description, meta.twitter?.description]) {
      expect(text).toBeTruthy();
      expect(String(text).toLowerCase()).not.toContain("community");
    }
  });

  it("/community does not exist", async () => {
    await expect(CommunityRedirect(planSearch)).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
  });
});

describe("with the setting on", () => {
  withModAndCommunityOn();

  it("the sitemap and llms.txt list community plans, and robots allows their card", async () => {
    const entries = await sitemap();
    expect(entries.map((entry) => entry.url)).toContain(`https://stage.gtnhplanner.idebugger.net/?plan=${PUBLIC_ID}`);
    expect(entries.map((entry) => entry.url)).not.toContain(`https://stage.gtnhplanner.idebugger.net/?plan=${PRIVATE_ID}`);
    const text = await (await llms()).text();
    expect(text).toContain("## Popular community plans");
    expect(text).toContain(`- [Steel line](https://stage.gtnhplanner.idebugger.net/?plan=${PUBLIC_ID}): Makes steel`);
    expect(text).not.toContain(PRIVATE_ID);
    expect(text).toContain("share plans with the community");
    expect(robots().rules).toMatchObject([{ allow: ["/", "/api/community/plans/*/card"] }]);
  });

  it("the sitemap and llms.txt answer without community plans when the database fails", async () => {
    const refused = Object.assign(new Error("boom"), { code: "XX000", severity: "ERROR" });
    for (const error of [undefined, refused]) {
      withDbFault(/from "community_plans"/, error);
      try {
        const entries = await sitemap();
        expect(entries.map((entry) => entry.url)).toEqual(["https://stage.gtnhplanner.idebugger.net/"]);
        const answer = await llms();
        expect(answer.status).toBe(200);
        const text = await answer.text();
        expect(text).not.toContain("## Popular community plans");
        expect(text).not.toContain("?plan=");
        expect(text).toContain("share plans with the community");
      } finally {
        clearDbFault();
      }
    }
  });

  it("the site's descriptions name community plans", () => {
    const meta = siteMetadata();
    expect(meta.description).toContain("community-shared plans.");
    expect(meta.openGraph?.description).toContain("share plans with the community.");
    expect(meta.twitter?.description).toContain("share plans with the community.");
  });

  it("a ?plan= link unfurls as its plan, and /community redirects to it", async () => {
    expect(await generateMetadata(planSearch)).toMatchObject({ title: "Steel line | GTNH Planner" });
    await expect(CommunityRedirect(planSearch)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });
});
