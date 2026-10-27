import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbFaultForTests } from "@/lib/server/db/guard";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import { oversizeRequest } from "@/test-support/request-bodies";
import { clearDbFault, useTestDb } from "@/test-support/test-db";
import { BLUEPRINT_MAX_PER_USER } from "@/lib/blueprints/types";
import aluminaLine from "@/components/flow/__fixtures__/alumina-line-shared-reactor.json";
import { json } from "@/lib/server/db";

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

import * as list from "./route";
import * as one from "./[blueprintId]/route";

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

describe("an account's own blueprints", () => {
  withModAndCommunityUnset();

  it("lists the account's own blueprints", async () => {
    sessionUser.mockReturnValue(ann);
    const response = await list.GET(get("/api/blueprints"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ blueprints: [] });
    expect(calls.map((call) => call.sql)).toEqual([
      expect.stringMatching(/^select .* from "blueprints" where "user_id" = \$1 order by "created_at" desc limit \$2$/),
    ]);
    expect(calls[0]?.parameters[0]).toBe(ann.id);
    sessionUser.mockReturnValue(undefined);
    const anonymous = await list.GET(get("/api/blueprints"));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Sign in to use blueprints." });
  });

  it("answers ?scope=public with 404 and sends no query, signed in or not, with or without storage", async () => {
    for (const viewer of [ann, undefined]) {
      for (const configured of [true, false]) {
        sessionUser.mockReturnValue(viewer);
        storage.configured = configured;
        calls.length = 0;
        try {
          const response = await list.GET(get("/api/blueprints?scope=public&search=oil"));
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ error: "There is no public blueprint list." });
          expect(calls).toEqual([]);
        } finally {
          storage.configured = true;
        }
      }
    }
  });

  it("answers 503 on a server with no storage", async () => {
    storage.configured = false;
    try {
      expect((await list.GET(get("/api/blueprints"))).status).toBe(503);
    } finally {
      storage.configured = true;
    }
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

  for (const [setting, use] of [
    ["unset", withModAndCommunityUnset],
    ["on", withModAndCommunityOn],
  ] as const) {
    describe(`with the community setting ${setting}`, () => {
      use();

      it("finds only the reader's own blueprint by id, never someone else's published one", async () => {
        sessionUser.mockReturnValue(ann);
        await one.GET(get(`/api/blueprints/${BLUEPRINT_ID}`), context);
        const [mine] = sent(/ from "blueprints" where "id" = \$1 and "user_id" = \$2$/);
        expect(mine?.parameters).toEqual([BLUEPRINT_ID, ann.id]);

        calls.length = 0;
        sessionUser.mockReturnValue(undefined);
        const stranger = await one.GET(get(`/api/blueprints/${BLUEPRINT_ID}`), context);
        expect(stranger.status).toBe(404);
        expect(await stranger.json()).toEqual({ error: "Blueprint not found." });
        expect(calls).toEqual([]);
      });
    });
  }
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
