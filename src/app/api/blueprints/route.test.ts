import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbFaultForTests } from "@/lib/server/db/guard";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import { oversizeRequest } from "@/test-support/request-bodies";
import { clearDbFault, useTestDb } from "@/test-support/test-db";
import { BLUEPRINT_MAX_PER_USER, PUBLIC_BLUEPRINT_PAGE_SIZE } from "@/lib/blueprints/types";
import aluminaLine from "@/components/flow/__fixtures__/alumina-line-shared-reactor.json";
import { json } from "@/lib/server/db";
import * as blueprintsRepo from "@/lib/server/repos/blueprints";

const testDb = useTestDb();

/** Every statement the routes send, as compiled, with its parameters. */
const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];

/** The statements sent that match `pattern`. */
const sent = (pattern: RegExp) => calls.filter((call) => pattern.test(call.sql));

const sessionUser = vi.fn<() => { id: string; username: string } | undefined>(() => undefined);
const storage = { configured: true };

vi.mock("@/lib/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/db")>();
  return {
    ...actual,
    isDatabaseConfigured: () => storage.configured,
  };
});
vi.mock("@/lib/server/auth/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/auth/sessions")>();
  return { ...actual, getSessionUser: vi.fn(async () => sessionUser()) };
});
vi.mock("@/lib/server/limits/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/limits/rate-limit")>();
  return { ...actual, checkRateLimit: vi.fn(async () => true) };
});
vi.mock("@/lib/server/auth/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/auth/keys")>();
  return {
    ...actual,
    makeVoterKey: vi.fn(async () => "voter"),
    makeActorKey: vi.fn(() => "actor"),
  };
});

import * as list from "./route";
import * as one from "./[blueprintId]/route";
import * as publish from "./[blueprintId]/publish/route";
import * as vote from "./[blueprintId]/vote/route";
import * as download from "./[blueprintId]/download/route";

// A well-formed id: a malformed one is answered before any query.
const BLUEPRINT_ID = "0b6f7c1e-3d2a-4e5f-8a9b-1c2d3e4f5a6b";
const context = { params: Promise.resolve({ blueprintId: BLUEPRINT_ID }) };
const ann = { id: "a0000000-0000-4000-8000-0000000000a1", username: "ann" };

function get(url: string): Request {
  return new Request(`http://localhost${url}`);
}
function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });
}

beforeAll(async () => {
  await testDb().db
    .insertInto("community_users")
    .values({ id: ann.id, username: ann.username, password_hash: "x:y" })
    .execute();
});

beforeEach(() => {
  calls.length = 0;
  setDbFaultForTests((sql, parameters) => {
    calls.push({ sql, parameters });
    return undefined;
  });
  sessionUser.mockReset();
  sessionUser.mockReturnValue(undefined);
});

afterEach(() => {
  clearDbFault();
});

describe("blueprints with the setting unset", () => {
  withModAndCommunityUnset();

  it("answers 404 to the public shelf, publishing, voting and placing a public blueprint", async () => {
    sessionUser.mockReturnValue(ann);
    const answers = [
      await list.GET(get("/api/blueprints?scope=public")),
      await publish.POST(post(`/api/blueprints/${BLUEPRINT_ID}/publish`, { publish: true }), context),
      await vote.POST(post(`/api/blueprints/${BLUEPRINT_ID}/vote`, { deviceId: "d", value: 1 }), context),
      await download.POST(post(`/api/blueprints/${BLUEPRINT_ID}/download`, {}), context),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: "Not found" });
    }
    expect(calls).toEqual([]);
  });

  it("answers the public shelf as absent on a server with no storage, not 503", async () => {
    storage.configured = false;
    try {
      const shelf = await list.GET(get("/api/blueprints?scope=public"));
      expect(shelf.status).toBe(404);
      expect(await shelf.json()).toEqual({ error: "Not found" });
      expect((await list.GET(get("/api/blueprints"))).status).toBe(503);
    } finally {
      storage.configured = true;
    }
  });

  it("still lists the account's own blueprints", async () => {
    sessionUser.mockReturnValue(ann);
    const response = await list.GET(get("/api/blueprints"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ blueprints: [] });
    const [own] = sent(/^select .* from "blueprints" where "user_id" = \$1 order by "created_at" desc limit \$2$/);
    expect(own?.parameters[0]).toBe(ann.id);
  });

  it("refuses a save whose declared length is over the cap without reading it", async () => {
    sessionUser.mockReturnValue(ann);
    const { request, counts } = oversizeRequest(
      "http://localhost/api/blueprints",
      "POST",
      3 * 1024 * 1024,
    );
    const response = await list.POST(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Blueprint is too large to save." });
    expect(counts.pulls).toBe(0);
    expect(calls).toEqual([]);
  });

  it("finds only the reader's own blueprint by id, never someone else's published one", async () => {
    sessionUser.mockReturnValue(ann);
    await one.GET(get(`/api/blueprints/${BLUEPRINT_ID}`), context);
    const [mine] = sent(/ from "blueprints" where \("id" = \$1 and "blueprints"\."user_id" = \$2\)$/);
    expect(mine?.parameters).toEqual([BLUEPRINT_ID, ann.id]);

    calls.length = 0;
    sessionUser.mockReturnValue(undefined);
    const stranger = await one.GET(get(`/api/blueprints/${BLUEPRINT_ID}`), context);
    expect(stranger.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("blueprints with the setting on", () => {
  withModAndCommunityOn();

  it("serves the public shelf and lets a public blueprint be read by id", async () => {
    const shelf = await list.GET(get("/api/blueprints?scope=public"));
    expect(shelf.status).toBe(200);
    expect(sent(/ from "blueprints" where "blueprints"\."is_public" = \$1 order by /)).toHaveLength(1);

    calls.length = 0;
    sessionUser.mockReturnValue(ann);
    await one.GET(get(`/api/blueprints/${BLUEPRINT_ID}`), context);
    const [readable] = sent(
      / from "blueprints" where \("id" = \$1 and \("blueprints"\."is_public" = \$2 or "blueprints"\."user_id" = \$3\)\)$/,
    );
    expect(readable?.parameters).toEqual([BLUEPRINT_ID, true, ann.id]);
  });

  it("keeps a shelf search inside its own parameters", async () => {
    const shelf = await list.GET(get("/api/blueprints?scope=public&search=oil,is_public.eq.false"));
    expect(shelf.status).toBe(200);
    const [search] = sent(/ from "blueprints" where /);
    expect(search?.sql).toMatch(
      / where \("blueprints"\."is_public" = \$1 and \("name" ilike \$2 or "description" ilike \$3 or "tags_text" ilike \$4\)\) order by /,
    );
    expect(search?.parameters.slice(0, 4)).toEqual([
      true,
      "%oil is public.eq.false%",
      "%oil is public.eq.false%",
      "%oil is public.eq.false%",
    ]);

    // The shelf reads the search as the community does: `*` is dropped, a #tag narrows tags.
    calls.length = 0;
    await list.GET(get("/api/blueprints?scope=public&search=" + encodeURIComponent("#fuel a*b")));
    const [tagged] = sent(/ from "blueprints" where /);
    expect(tagged?.sql).toMatch(
      / where \("blueprints"\."is_public" = \$1 and "tags_text" ilike \$2 and \("name" ilike \$3 or "description" ilike \$4 or "tags_text" ilike \$5\)\) order by /,
    );
    expect(tagged?.parameters.slice(0, 5)).toEqual([true, "%fuel%", "%a b%", "%a b%", "%a b%"]);
  });

  it("reaches publishing, voting and placing", async () => {
    sessionUser.mockReturnValue(ann);
    const answers = [
      await publish.POST(post(`/api/blueprints/${BLUEPRINT_ID}/publish`, { publish: true }), context),
      await vote.POST(post(`/api/blueprints/${BLUEPRINT_ID}/vote`, { deviceId: "d", value: 1 }), context),
      await download.POST(post(`/api/blueprints/${BLUEPRINT_ID}/download`, {}), context),
    ];
    for (const answer of answers) {
      expect(await answer.json()).not.toEqual({ error: "Not found" });
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("the public shelf against the database", () => {
  withModAndCommunityOn();

  /** Ann's blueprints for this case, published unless said; answers their ids by name. */
  async function seed(
    rows: Array<{ name: string; description?: string; tags?: string; isPublic?: boolean; votes?: number; downloads?: number; publishedAt: string }>,
  ): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const row of rows) {
      const inserted = await testDb()
        .db.insertInto("blueprints")
        .values({
          user_id: ann.id,
          name: row.name,
          author_name: ann.username,
          description: row.description ?? "",
          tags_text: row.tags ?? "",
          payload: json({ nodes: [] }),
          is_public: row.isPublic ?? true,
          upvotes: row.votes ?? 0,
          downloads: row.downloads ?? 0,
          published_at: row.publishedAt,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      ids[row.name] = inserted.id;
    }
    return ids;
  }

  afterEach(async () => {
    await testDb().db.deleteFrom("blueprints").execute();
  });

  const shelf = async (query: string) => {
    const answer = await list.GET(get(`/api/blueprints?scope=public&${query}`));
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { blueprints: Array<{ name: string }>; hasMore: boolean };
    return { names: body.blueprints.map((row) => row.name), hasMore: body.hasMore };
  };

  it("matches names, descriptions and tags, narrows by tag and creator, and never shows an unpublished one", async () => {
    await seed([
      { name: "Oil rig", publishedAt: "2026-10-01T00:00:00Z", tags: "petro" },
      { name: "Gas plant", description: "Burns oil", publishedAt: "2026-10-02T00:00:00Z" },
      { name: "Refinery", tags: "oil petro", publishedAt: "2026-10-03T00:00:00Z" },
      { name: "Hidden oil", isPublic: false, publishedAt: "2026-10-04T00:00:00Z" },
    ]);
    expect((await shelf("sort=newest&search=oil")).names).toEqual(["Refinery", "Gas plant", "Oil rig"]);
    expect((await shelf("sort=newest&search=" + encodeURIComponent("#petro"))).names).toEqual(["Refinery", "Oil rig"]);
    expect((await shelf("sort=newest&search=" + encodeURIComponent("#petro rig"))).names).toEqual(["Oil rig"]);
    expect((await shelf("sort=newest&search=" + encodeURIComponent("@ann oil"))).names).toHaveLength(3);
    expect((await shelf("sort=newest&search=" + encodeURIComponent("@an oil"))).names).toEqual([]);
    expect((await shelf("sort=newest&search=" + encodeURIComponent("@"))).names).toEqual([]);
  });

  it("never widens a match on %, _ or a filter's syntax in the box", async () => {
    await seed([
      { name: "50% steel", publishedAt: "2026-10-01T00:00:00Z" },
      { name: "500 steel", publishedAt: "2026-10-02T00:00:00Z" },
      { name: "a_b furnace", publishedAt: "2026-10-03T00:00:00Z" },
      { name: "axb furnace", publishedAt: "2026-10-04T00:00:00Z" },
      { name: "Private", isPublic: false, publishedAt: "2026-10-05T00:00:00Z" },
    ]);
    // The box drops % and _ (search-query.ts): "a_b" reads "a b", which neither name holds.
    expect((await shelf("search=" + encodeURIComponent("a_b"))).names).toEqual([]);
    expect((await shelf("search=" + encodeURIComponent("%"))).names).toHaveLength(4);
    expect((await shelf("search=" + encodeURIComponent("oil,is_public.eq.false"))).names).toEqual([]);
    expect((await shelf("search=" + encodeURIComponent("x' or '1'='1"))).names).toEqual([]);
    // Past the box, the shelf's own LIKE escape holds: % and _ match only themselves.
    const page = (text: string) =>
      blueprintsRepo.listPublic({
        search: { tags: [], author: "", bareAuthor: false, text },
        sort: "newest",
        offset: 0,
        limit: 10,
      });
    expect((await page("a_b")).map((row) => row.name)).toEqual(["a_b furnace"]);
    expect((await page("50%")).map((row) => row.name)).toEqual(["50% steel"]);
    expect((await page("\\")).map((row) => row.name)).toEqual([]);
  });

  it("sorts by score, downloads or publish time, newest first on ties, and pages with one row to spare", async () => {
    await seed([
      { name: "Old top", votes: 5, downloads: 1, publishedAt: "2026-10-01T00:00:00Z" },
      { name: "New top", votes: 5, downloads: 9, publishedAt: "2026-10-03T00:00:00Z" },
      { name: "Low", votes: 1, downloads: 9, publishedAt: "2026-10-02T00:00:00Z" },
    ]);
    expect((await shelf("")).names).toEqual(["New top", "Old top", "Low"]);
    expect((await shelf("sort=downloads")).names).toEqual(["New top", "Low", "Old top"]);
    expect((await shelf("sort=newest")).names).toEqual(["New top", "Low", "Old top"]);
    expect((await shelf("sort=nonsense")).names).toEqual(["New top", "Old top", "Low"]);
    expect(await shelf("page=0")).toMatchObject({ hasMore: false });
    expect(await shelf("page=1")).toEqual({ names: [], hasMore: false });

    await seed(
      Array.from({ length: PUBLIC_BLUEPRINT_PAGE_SIZE }, (_, i) => ({
        name: `Filler ${i}`,
        publishedAt: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`,
      })),
    );
    const first = await shelf("sort=newest&page=0");
    expect(first.names).toHaveLength(PUBLIC_BLUEPRINT_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    const second = await shelf("sort=newest&page=1");
    expect(second).toMatchObject({ hasMore: false });
    expect(second.names).toHaveLength(3);
    expect(new Set([...first.names, ...second.names]).size).toBe(PUBLIC_BLUEPRINT_PAGE_SIZE + 3);
  });
});

describe("saving a blueprint", () => {
  withModAndCommunityUnset();

  const saver = { id: "b0000000-0000-4000-8000-0000000000b2", username: "bea" };
  const payload = {
    nodes: aluminaLine.nodes,
    storages: aluminaLine.storages ?? [],
    annotations: [],
    pockets: [],
    edges: aluminaLine.edges ?? [],
    recipes: aluminaLine.recipes,
  };
  const save = (name: string) =>
    list.POST(post("/api/blueprints", { name, payload, tags: [], needs: [], outputs: [] }));
  const held = async () =>
    Number(
      (
        await testDb()
          .db.selectFrom("blueprints")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("user_id", "=", saver.id)
          .executeTakeFirstOrThrow()
      ).count,
    );

  beforeAll(async () => {
    await testDb()
      .db.insertInto("community_users")
      .values({ id: saver.id, username: saver.username, password_hash: "x:y" })
      .execute();
  });

  beforeEach(async () => {
    await testDb().db.deleteFrom("blueprints").where("user_id", "=", saver.id).execute();
    calls.length = 0;
    sessionUser.mockReturnValue(saver);
  });

  it("locks its account, then counts and inserts, so saves at once meet the cap one at a time", async () => {
    const response = await save("Locked");
    expect(response.status).toBe(200);
    const statements = calls.map((call) => call.sql);
    const lock = statements.findIndex((text) =>
      /^select "id" from "community_users" where "id" = \$1 for no key update$/.test(text),
    );
    const count = statements.findIndex((text) => /^select count\(\*\) as "count" from "blueprints"/.test(text));
    const insert = statements.findIndex((text) => /^insert into "blueprints"/.test(text));
    expect(lock, statements.join("\n")).toBeGreaterThanOrEqual(0);
    expect(count).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(count);
    expect(calls[lock]!.parameters).toEqual([saver.id]);
    expect(await held()).toBe(1);
  });

  it("refuses a save past the cap and stores nothing", async () => {
    await testDb()
      .db.insertInto("blueprints")
      .values(
        Array.from({ length: BLUEPRINT_MAX_PER_USER }, (_, i) => ({
          user_id: saver.id,
          name: `Held ${i}`,
          payload: json({ nodes: [] }),
        })),
      )
      .execute();
    const response = await save("One too many");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: `Your blueprints are full (${BLUEPRINT_MAX_PER_USER}). Delete some first.`,
    });
    expect(await held()).toBe(BLUEPRINT_MAX_PER_USER);
  });

  it("answers a failed count with the save's sentence and stores nothing, never reading it as none", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setDbFaultForTests((text) =>
        /^select count\(\*\) as "count" from "blueprints"/.test(text)
          ? Object.assign(new Error("count refused"), { code: "XX000", severity: "ERROR" })
          : undefined,
      );
      const refused = await save("Uncounted");
      expect(refused.status).toBe(500);
      expect(await refused.json()).toEqual({ error: "Blueprint could not be saved." });
      expect(logged).toHaveBeenCalled();
      clearDbFault();
      expect(await held()).toBe(0);
    } finally {
      logged.mockRestore();
    }
  });
});
