import { describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

const row = {
  id: "plan-1",
  name: "Steel line",
  description: "Makes steel",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: null,
};

/** A stand-in query builder: every call chains, and awaiting it answers one public plan. */
function query(): unknown {
  const proxy: unknown = new Proxy(() => undefined, {
    get(_target, name) {
      if (name === "then") {
        return (resolve: (value: unknown) => void) => resolve({ data: [row], error: null });
      }
      return () => proxy;
    },
  });
  return proxy;
}

const getCommunityDb = vi.fn(() => query());
vi.mock("@/lib/server/community", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/community")>();
  return { ...actual, isCommunityConfigured: () => true, getCommunityDb: () => getCommunityDb() };
});
const getPublicPlanRow = vi.fn(async () => row);
vi.mock("@/lib/server/plan-preview", () => ({
  getPublicPlanRow: () => getPublicPlanRow(),
  describePlanRow: () => "Makes steel",
}));
vi.mock("@/components/FactoryPlannerApp", () => ({ FactoryPlannerApp: () => null }));

import sitemap from "./sitemap";
import robots from "./robots";
import { GET as llms } from "./llms.txt/route";
import { generateMetadata } from "./page";
import CommunityRedirect from "./community/page";

const planSearch = { searchParams: Promise.resolve({ plan: "plan-1" }) };

describe("with the setting unset", () => {
  withModAndCommunityUnset();

  it("the sitemap lists only the home page", async () => {
    getCommunityDb.mockClear();
    const entries = await sitemap();
    expect(entries.map((entry) => entry.url)).toEqual(["https://gtnhplanner.com/"]);
    expect(getCommunityDb).not.toHaveBeenCalled();
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
    expect(entries.map((entry) => entry.url)).toContain("https://gtnhplanner.com/?plan=plan-1");
    const text = await (await llms()).text();
    expect(text).toContain("## Popular community plans");
    expect(text).toContain("share plans with the community");
    expect(robots().rules).toMatchObject([{ allow: ["/", "/api/community/plans/*/card"] }]);
  });

  it("a ?plan= link unfurls as its plan, and /community redirects to it", async () => {
    expect(await generateMetadata(planSearch)).toMatchObject({ title: "Steel line | GTNH Planner" });
    await expect(CommunityRedirect(planSearch)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });
});
