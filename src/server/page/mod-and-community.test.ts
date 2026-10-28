import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { json } from "@/lib/server/db";
import { setDbFaultForTests } from "@/lib/server/db/guard";
import { clearDbFault, setupTestDb, withDbFault } from "@/test-support/test-db";
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
  quietMarkdown: (await importOriginal<typeof import("@/lib/server/services/plan-preview")>())
    .quietMarkdown,
  getPublicPlanRow: () => getPublicPlanRow(),
  describePlanRow: () => "Makes steel",
}));
vi.mock("@/components/FactoryPlannerApp", () => ({ FactoryPlannerApp: () => null }));

import { renderShell } from "@/client/prerender";
import { siteHead } from "@/lib/server/site/head";
import { headForRequest } from "@/lib/server/site/plan-head";
import { llmsText, robots, sitemapEntries } from "@/lib/server/site/site-files";
import { createApp } from "../app";
import { call, listen, type Listening } from "../test-support/serve";
import { loadPageTemplate } from "./template";

/**
 * What the community switch turns on and off across the site: the page's metadata and JS-less paragraph, the
 * sitemap, llms.txt, robots.txt and `/community`.
 */

const SITE = "https://stage.gtnhplanner.idebugger.net";
const planSearch = new URLSearchParams("plan=plan-1");

const testDb = setupTestDb();
const PUBLIC_ID = "00000000-0000-4000-8000-0000000000c1";
const PRIVATE_ID = "00000000-0000-4000-8000-0000000000c2";

let root: string;

/** Every statement the direct client sends until `clearDbFault`. */
function recordSql(): string[] {
  const sent: string[] = [];
  setDbFaultForTests((text) => {
    sent.push(text);
    return undefined;
  });
  return sent;
}

/** The app with a built page, so `/community` and the 404 answer as in production. */
async function serve(): Promise<Listening> {
  const client = path.join(root, "client");
  return listen(
    createApp({
      env: { production: true, siteUrl: SITE },
      publicDir: path.join(root, "public"),
      datasetsDir: path.join(root, "public", "datasets", "gtnh"),
      clientDir: client,
      template: loadPageTemplate(client),
    }),
  );
}

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  root = mkdtempSync(path.join(tmpdir(), "mod-and-community-"));
  const client = path.join(root, "client");
  mkdirSync(path.join(client, "assets"), { recursive: true });
  mkdirSync(path.join(root, "public"));
  writeFileSync(
    path.join(client, "index.html"),
    '<!doctype html><html lang="en"><head><!--app-head--><script type="module" src="/assets/index-T.js"></script></head>' +
      '<body><div id="root" style="display: contents"></div></body></html>',
  );
  writeFileSync(
    path.join(client, "page.json"),
    JSON.stringify({
      scriptHashes: [`'sha256-${"A".repeat(43)}='`],
      fontPreloads: [],
      assetVersions: {},
    }),
  );
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
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("copy names both served versions", () => {
  withModAndCommunityUnset();

  it("the page metadata, the noscript paragraph and llms.txt name GTNH 2.9 and 2.8.1", async () => {
    const head = siteHead();
    expect(head.description).toContain("Full recipe data for GTNH 2.9 and 2.8.1,");
    expect(head.openGraph.description).toContain("full recipe data for GTNH 2.9 and 2.8.1.");
    expect(head.twitter.description).toContain("full recipe data for GTNH 2.9 and 2.8.1.");
    expect(head.description.toLowerCase()).not.toContain("community");
    const noscript = /<noscript>[\s\S]*<\/noscript>/.exec(renderShell().shell)![0];
    expect(noscript).toContain("full recipe data for GTNH 2.9 and 2.8.1,");
    expect(noscript.toLowerCase()).not.toContain("community");
    const text = await llmsText();
    expect(text).toContain(
      "- Carries full recipe data for GTNH 2.9 and 2.8.1, exported from the game itself",
    );
  });
});

describe("with the setting unset", () => {
  withModAndCommunityUnset();

  it("the sitemap lists only the home page", async () => {
    const sent = recordSql();
    try {
      const entries = await sitemapEntries();
      expect(entries.map((entry) => entry.url)).toEqual([`${SITE}/`]);
    } finally {
      clearDbFault();
    }
    expect(sent).toEqual([]);
  });

  it("llms.txt names no community plan and no community", async () => {
    const text = await llmsText();
    expect(text).not.toContain("?plan=");
    expect(text.toLowerCase()).not.toContain("community");
    expect(text).toContain(
      "balance machine ratios, and compute EU/t power draw and throughput. No account",
    );
  });

  it("robots.txt allows the site and keeps the API out", () => {
    expect(robots().rules).toMatchObject([{ allow: ["/"] }]);
  });

  it("a ?plan= link gets the default metadata, with no lookup", async () => {
    getPublicPlanRow.mockClear();
    expect(await headForRequest(planSearch)).toEqual(siteHead());
    expect(getPublicPlanRow).not.toHaveBeenCalled();
  });

  it("the site's descriptions say nothing of the community", () => {
    const head = siteHead();
    for (const text of [head.description, head.openGraph.description, head.twitter.description]) {
      expect(text).toBeTruthy();
      expect(text.toLowerCase()).not.toContain("community");
    }
  });

  it("/community does not exist", async () => {
    const server = await serve();
    try {
      expect((await call(server.port, "GET", "/community?plan=plan-1")).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("with the setting on", () => {
  withModAndCommunityOn();

  it("the sitemap and llms.txt list community plans", async () => {
    const entries = await sitemapEntries();
    expect(entries.map((entry) => entry.url)).toContain(`${SITE}/?plan=${PUBLIC_ID}`);
    expect(entries.map((entry) => entry.url)).not.toContain(`${SITE}/?plan=${PRIVATE_ID}`);
    const text = await llmsText();
    expect(text).toContain("## Popular community plans");
    expect(text).toContain(`- [Steel line](${SITE}/?plan=${PUBLIC_ID}): Makes steel`);
    expect(text).not.toContain(PRIVATE_ID);
    expect(text).toContain("share plans with the community");
    expect(robots().rules).toMatchObject([{ allow: ["/"] }]);
  });

  it("the sitemap and llms.txt answer without community plans when the database fails", async () => {
    const refused = Object.assign(new Error("boom"), { code: "XX000", severity: "ERROR" });
    for (const error of [undefined, refused]) {
      withDbFault(/from "community_plans"/, error);
      try {
        const entries = await sitemapEntries();
        expect(entries.map((entry) => entry.url)).toEqual([`${SITE}/`]);
        const text = await llmsText();
        expect(text).not.toContain("## Popular community plans");
        expect(text).not.toContain("?plan=");
        expect(text).toContain("share plans with the community");
      } finally {
        clearDbFault();
      }
    }
  });

  it("the site's descriptions name community plans", () => {
    const head = siteHead();
    expect(head.description).toContain("community-shared plans.");
    expect(head.openGraph.description).toContain("share plans with the community.");
    expect(head.twitter.description).toContain("share plans with the community.");
  });

  it("a ?plan= link unfurls as its plan, and /community redirects to it", async () => {
    const head = await headForRequest(planSearch);
    expect(head).toMatchObject({ title: "Steel line | GTNH Planner" });
    // No image of its own: the site's opengraph-image.png stands, as on every other page.
    expect(head.image).toEqual(siteHead().image);
    expect(head.openGraph).not.toHaveProperty("images");
    const server = await serve();
    try {
      const answer = await call(server.port, "GET", "/community?plan=plan-1");
      expect(answer.status).toBe(307);
      expect(answer.headers.find(([name]) => name === "location")?.[1]).toBe("/?plan=plan-1");
    } finally {
      await server.close();
    }
  });
});
