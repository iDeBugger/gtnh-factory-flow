import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearDbFault, useTestDb, withDbFault } from "@/test-support/test-db";
import { setDbFaultForTests } from "@/lib/server/db/guard";
import { forgetSessionUsers, makeSessionToken } from "@/lib/server/auth/sessions";
import { resetDbBreaker } from "@/lib/server/db";
import { resetMemoryTokens } from "@/lib/server/limits/memory-rate";
import { PROJECT_SCHEMA_VERSION } from "@/lib/model/types";
import { LIBRARY_MAX_DESIGNS } from "@/lib/library/sync-types";
import * as library from "./route";
import * as design from "./designs/[designId]/route";
import * as members from "./designs/[designId]/members/route";
import * as member from "./designs/[designId]/members/[userId]/route";
import * as folder from "./folders/[folderId]/route";
import * as search from "../accounts/search/route";
import * as meRoute from "../community/auth/me/route";
import * as blueprintList from "../blueprints/route";
import * as blueprintOne from "../blueprints/[blueprintId]/route";

/**
 * Holds each answer of a wrapped repository read until `size` of them have
 * come back, or `waitMs` has passed: two requests that both read before
 * either writes meet here, so a check-then-write race shows. Reads made
 * one after another (one transaction at a time) each wait out the timer.
 */
const gates = vi.hoisted(() => {
  type Gate = { arrive(): Promise<void> };
  const make = (size: number, waitMs = 150): Gate => {
    let arrived = 0;
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return {
      arrive() {
        arrived += 1;
        if (arrived >= size) open();
        return Promise.race([opened, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
      },
    };
  };
  return { make, read: undefined as Gate | undefined, count: undefined as Gate | undefined };
});

vi.mock("@/lib/server/repos/designs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/repos/designs")>();
  return {
    ...actual,
    read: async (...args: Parameters<typeof actual.read>) => {
      const answer = await actual.read(...args);
      await gates.read?.arrive();
      return answer;
    },
    countLive: async (...args: Parameters<typeof actual.countLive>) => {
      const answer = await actual.countLive(...args);
      await gates.count?.arrive();
      return answer;
    },
  };
});

/**
 * Cloud plans over REST, against the local database: sharing a design with
 * other accounts, members reading and saving it, leaving, the live lease
 * refusing plan bodies, deletes dropping members, account search, and the
 * notices the live service is sent.
 */

const testDb = useTestDb();
let notices: Array<{ path: string; auth: string | undefined; body: unknown }> = [];
let noticeServer: Server;
const users: Record<string, { id: string; cookie: string }> = {};

async function makeUser(username: string) {
  const { id } = await testDb()
    .db.insertInto("community_users")
    .values({ username, password_hash: "x:y" })
    .returning("id")
    .executeTakeFirstOrThrow();
  users[username] = { id, cookie: `gtnh_session=${makeSessionToken(id)}` };
}

function request(method: string, path: string, who?: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(who ? { cookie: users[who]!.cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });

function plan(name: string) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: `plan-${name}`,
    name,
    recipes: [],
    nodes: [],
    storages: [],
    edges: [],
    fuelProfiles: [],
    tasks: [{ id: "t1", title: name, status: "todo", order: "a0" }],
  };
}

function upsertBody(name: string, stamp: string, withPlan = true) {
  return {
    name,
    icon: null,
    folderId: "folder-mine",
    closed: false,
    favorite: true,
    order: 3,
    communityPlanId: null,
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: stamp,
    planUpdatedAt: stamp,
    ...(withPlan ? { plan: plan(name) } : {}),
  };
}

beforeAll(async () => {
  vi.stubEnv("COMMUNITY_HASH_SALT", "cloud-plans-test-salt");
  noticeServer = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      notices.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(text),
      });
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((resolve) => noticeServer.listen(0, "127.0.0.1", resolve));
  vi.stubEnv(
    "LIVE_INTERNAL_URL",
    `http://127.0.0.1:${(noticeServer.address() as AddressInfo).port}`,
  );
  vi.stubEnv("LIVE_INTERNAL_TOKEN", "internal-secret");
  for (const name of ["ann", "bob", "carol", "bobby_b", "dan"]) {
    await makeUser(name);
  }
}, 60_000);

afterAll(async () => {
  noticeServer?.close();
  vi.unstubAllEnvs();
});

describe("cloud plans over REST", () => {
  const designId = "design-shared-1";

  it("shares a plan: the owner adds a member, both libraries show it, the live service hears", async () => {
    const saved = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}`,
        "ann",
        upsertBody("Steel", "2026-10-14T11:00:00.000Z"),
      ),
      params({ designId }),
    );
    expect(saved.status).toBe(200);

    notices = [];
    const shared = await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.bob!.id}`, "ann"),
      params({ designId, userId: users.bob!.id }),
    );
    expect(shared.status).toBe(200);
    expect(await shared.json()).toEqual({ members: [{ id: users.bob!.id, username: "bob" }] });
    expect(notices).toEqual([
      {
        path: "/internal/members",
        auth: "Bearer internal-secret",
        body: {
          doc: `${users.ann!.id}:${designId}`,
          members: [{ id: users.bob!.id, username: "bob" }],
          added: [users.bob!.id],
          owner: { id: users.ann!.id, username: "ann" },
          name: "Steel",
        },
      },
    ]);

    const annLibrary = await (await library.GET(request("GET", "/api/library", "ann"))).json();
    expect(annLibrary.designs.find((d: { id: string }) => d.id === designId).members).toEqual([
      { id: users.bob!.id, username: "bob" },
    ]);
    expect(annLibrary.shared).toEqual([]);

    const bobLibrary = await (await library.GET(request("GET", "/api/library", "bob"))).json();
    expect(bobLibrary.designs).toEqual([]);
    expect(bobLibrary.shared).toEqual([
      expect.objectContaining({
        ownerId: users.ann!.id,
        ownerName: "ann",
        id: designId,
        name: "Steel",
        members: [{ id: users.bob!.id, username: "bob" }],
      }),
    ]);
  });

  it("lets the owner and members read the plan, and nobody else", async () => {
    const asBob = await design.GET(
      request("GET", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "bob"),
      params({ designId }),
    );
    expect(asBob.status).toBe(200);
    const read = await asBob.json();
    expect(read).toMatchObject({ role: "editor", ownerId: users.ann!.id, seq: 0, live: false });
    expect(read.plan.tasks[0].title).toBe("Steel");

    const asAnn = await design.GET(
      request("GET", `/api/library/designs/${designId}`, "ann"),
      params({ designId }),
    );
    expect((await asAnn.json()).role).toBe("owner");

    const asCarol = await design.GET(
      request("GET", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "carol"),
      params({ designId }),
    );
    expect(asCarol.status).toBe(404);
    const bobsOwn = await design.GET(
      request("GET", `/api/library/designs/${designId}`, "bob"),
      params({ designId }),
    );
    expect(bobsOwn.status).toBe(404);
    const badOwner = await design.GET(
      request("GET", `/api/library/designs/${designId}?owner=nope`, "bob"),
      params({ designId }),
    );
    expect(badOwner.status).toBe(400);

    const list = await members.GET(
      request("GET", `/api/library/designs/${designId}/members?owner=${users.ann!.id}`, "bob"),
      params({ designId }),
    );
    expect(await list.json()).toEqual({
      ownerId: users.ann!.id,
      ownerName: "ann",
      role: "editor",
      members: [{ id: users.bob!.id, username: "bob" }],
    });
  });

  it("lets a member save the plan and its name, leaving the owner's folders and stars alone", async () => {
    const saved = await design.PUT(
      request("PUT", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "bob", {
        ...upsertBody("Steel by Bob", "2026-10-14T12:00:00.000Z"),
        folderId: "folder-bob",
        favorite: false,
      }),
      params({ designId }),
    );
    expect(saved.status).toBe(200);
    const data = await testDb()
      .db.selectFrom("library_designs")
      .select(["name", "folder_id", "favorite", "sort_order", "plan"])
      .where("user_id", "=", users.ann!.id)
      .where("id", "=", designId)
      .executeTakeFirst();
    expect(data).toMatchObject({
      name: "Steel by Bob",
      folder_id: "folder-mine",
      favorite: true,
      sort_order: 3,
    });
    expect((data as unknown as { plan: { name: string } }).plan.name).toBe("Steel by Bob");

    const stranger = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}?owner=${users.ann!.id}`,
        "carol",
        upsertBody("Mine now", "2026-10-14T12:30:00.000Z"),
      ),
      params({ designId }),
    );
    expect(stranger.status).toBe(404);
  });

  it("refuses a stamp from the future, from a member or the owner", async () => {
    const clockAhead = { error: "This device's clock is ahead. Check its date and time." };
    const farAhead = await design.PUT(
      request("PUT", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "bob", {
        ...upsertBody("Frozen", "2999-01-01T00:00:00.000Z"),
      }),
      params({ designId }),
    );
    expect(farAhead.status).toBe(400);
    expect(await farAhead.json()).toEqual(clockAhead);
    const data = await testDb()
      .db.selectFrom("library_designs")
      .select("name")
      .where("user_id", "=", users.ann!.id)
      .where("id", "=", designId)
      .executeTakeFirst();
    expect(data).toEqual({ name: "Steel by Bob" });

    // A clock a couple of minutes ahead is ordinary skew; ten minutes is a wrong clock.
    const clockId = "design-clock";
    const twoMinutes = new Date(Date.now() + 2 * 60_000).toISOString();
    const skewed = await design.PUT(
      request("PUT", `/api/library/designs/${clockId}`, "ann", upsertBody("Skewed", twoMinutes)),
      params({ designId: clockId }),
    );
    expect(skewed.status).toBe(200);
    expect((await skewed.json()).behind).toBe(false);
    const tenMinutes = new Date(Date.now() + 10 * 60_000).toISOString();
    const wrong = await design.PUT(
      request("PUT", `/api/library/designs/${clockId}`, "ann", upsertBody("Wrong", tenMinutes)),
      params({ designId: clockId }),
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual(clockAhead);
    // A design made while the clock was ahead keeps saving once it is right: createdAt is never judged.
    const oldClock = await design.PUT(
      request("PUT", `/api/library/designs/${clockId}`, "ann", {
        ...upsertBody("Made ahead", new Date(Date.now() + 3 * 60_000).toISOString()),
        createdAt: "2999-01-01T00:00:00.000Z",
      }),
      params({ designId: clockId }),
    );
    expect(oldClock.status).toBe(200);

    const futureFolder = await folder.PUT(
      request("PUT", "/api/library/folders/folder-clock", "ann", {
        name: "Later",
        createdAt: "2026-10-14T10:00:00.000Z",
        updatedAt: "2999-01-01T00:00:00.000Z",
      }),
      params({ folderId: "folder-clock" }),
    );
    expect(futureFolder.status).toBe(400);
    expect(await futureFolder.json()).toEqual(clockAhead);
  });

  it("refuses a plan body while the live service holds the lease, and still takes metadata", async () => {
    const until = new Date(Date.now() + 90_000).toISOString();
    await testDb()
      .db.updateTable("library_designs")
      .set({ live_lease_until: until })
      .where("user_id", "=", users.ann!.id)
      .where("id", "=", designId)
      .execute();
    const withPlan = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}`,
        "ann",
        upsertBody("Steel", "2026-10-14T13:00:00.000Z"),
      ),
      params({ designId }),
    );
    expect(withPlan.status).toBe(409);
    expect(await withPlan.json()).toMatchObject({ live: true });
    const metaOnly = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}`,
        "ann",
        upsertBody("Steel renamed", "2026-10-14T13:00:00.000Z", false),
      ),
      params({ designId }),
    );
    expect(metaOnly.status).toBe(200);
    expect((await metaOnly.json()).design.name).toBe("Steel renamed");
    const read = await design.GET(
      request("GET", `/api/library/designs/${designId}`, "ann"),
      params({ designId }),
    );
    expect((await read.json()).live).toBe(true);
    await testDb()
      .db.updateTable("library_designs")
      .set({ live_lease_until: null })
      .where("user_id", "=", users.ann!.id)
      .where("id", "=", designId)
      .execute();
  });

  it("lets only the owner share, and a member leave", async () => {
    const bobShares = await member.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}/members/${users.carol!.id}?owner=${users.ann!.id}`,
        "bob",
      ),
      params({ designId, userId: users.carol!.id }),
    );
    expect(bobShares.status).toBe(403);
    await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.carol!.id}`, "ann"),
      params({ designId, userId: users.carol!.id }),
    );
    const bobRemovesCarol = await member.DELETE(
      request(
        "DELETE",
        `/api/library/designs/${designId}/members/${users.carol!.id}?owner=${users.ann!.id}`,
        "bob",
      ),
      params({ designId, userId: users.carol!.id }),
    );
    expect(bobRemovesCarol.status).toBe(403);
    const self = await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.ann!.id}`, "ann"),
      params({ designId, userId: users.ann!.id }),
    );
    expect(self.status).toBe(400);

    notices = [];
    const bobLeaves = await member.DELETE(
      request(
        "DELETE",
        `/api/library/designs/${designId}/members/${users.bob!.id}?owner=${users.ann!.id}`,
        "bob",
      ),
      params({ designId, userId: users.bob!.id }),
    );
    expect(bobLeaves.status).toBe(200);
    expect(await bobLeaves.json()).toEqual({
      members: [{ id: users.carol!.id, username: "carol" }],
    });
    expect(notices.map((notice) => notice.path)).toEqual(["/internal/members"]);
    const gone = await design.GET(
      request("GET", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "bob"),
      params({ designId }),
    );
    expect(gone.status).toBe(404);
  });

  it("deletes for the owner only, dropping every member and telling the live service", async () => {
    const byCarol = await design.DELETE(
      request("DELETE", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "carol"),
      params({ designId }),
    );
    expect(byCarol.status).toBe(403);

    notices = [];
    const byAnn = await design.DELETE(
      request("DELETE", `/api/library/designs/${designId}`, "ann"),
      params({ designId }),
    );
    expect(byAnn.status).toBe(200);
    expect(notices).toEqual([
      {
        path: "/internal/deleted",
        auth: "Bearer internal-secret",
        body: { doc: `${users.ann!.id}:${designId}` },
      },
    ]);
    const carolLibrary = await (await library.GET(request("GET", "/api/library", "carol"))).json();
    expect(carolLibrary.shared).toEqual([]);
    // The owner's list keeps the tombstone, so the id is never reused.
    const annLibrary = await (await library.GET(request("GET", "/api/library", "ann"))).json();
    expect(
      annLibrary.designs.find((d: { id: string }) => d.id === designId).deletedAt,
    ).not.toBeNull();
  });

  it("finds accounts by username prefix, leaving the caller out", async () => {
    resetMemoryTokens();
    const find = async (q: string, who = "bob") =>
      search.GET(request("GET", `/api/accounts/search?q=${encodeURIComponent(q)}`, who));
    expect(await (await find("BO", "ann")).json()).toEqual({
      accounts: [
        { id: users.bob!.id, username: "bob" },
        { id: users.bobby_b!.id, username: "bobby_b" },
      ],
    });
    expect((await (await find("bo")).json()).accounts).toEqual([
      { id: users.bobby_b!.id, username: "bobby_b" },
    ]);
    // `_` matches only itself, not any one character.
    expect((await (await find("bobby_", "ann")).json()).accounts).toHaveLength(1);
    expect((await (await find("bobbyx", "ann")).json()).accounts).toHaveLength(0);
    expect((await (await find("%", "ann")).json()).accounts).toEqual([]);
    // One character is a directory, not a search.
    expect(await (await find("b", "ann")).json()).toEqual({ accounts: [] });
    expect((await search.GET(request("GET", "/api/accounts/search?q=bo"))).status).toBe(401);
    let last = 200;
    for (let i = 0; i < 70; i += 1) {
      last = (await find("d", "dan")).status;
    }
    expect(last).toBe(429);
  });

  it("lists a member only the design shared with them, not another owner's design with the same id", async () => {
    await makeUser("twin_ann");
    await makeUser("twin_bob");
    await makeUser("twin_mem");
    const designId = "design-twin-1";
    for (const owner of ["twin_ann", "twin_bob"]) {
      const saved = await design.PUT(
        request("PUT", `/api/library/designs/${designId}`, owner, upsertBody(owner, "2026-10-20T11:00:00.000Z")),
        params({ designId }),
      );
      expect(saved.status).toBe(200);
    }
    const shared = await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.twin_mem!.id}`, "twin_ann"),
      params({ designId, userId: users.twin_mem!.id }),
    );
    expect(shared.status).toBe(200);

    const listed = await (await library.GET(request("GET", "/api/library", "twin_mem"))).json();
    expect(listed.shared).toEqual([
      expect.objectContaining({
        ownerId: users.twin_ann!.id,
        id: designId,
        name: "twin_ann",
        members: [{ id: users.twin_mem!.id, username: "twin_mem" }],
      }),
    ]);
    const bobs = await (await library.GET(request("GET", "/api/library", "twin_bob"))).json();
    expect(bobs.designs).toEqual([expect.objectContaining({ id: designId, members: [] })]);
  });

  it("holds an owner to 30 new shares an hour, however often they unshare", async () => {
    await makeUser("erin");
    const designId = "design-share-spam";
    const saved = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}`,
        "erin",
        upsertBody("Spam", "2026-10-14T11:00:00.000Z"),
      ),
      params({ designId }),
    );
    expect(saved.status).toBe(200);
    const share = (method: "PUT" | "DELETE") =>
      (method === "PUT" ? member.PUT : member.DELETE)(
        request(method, `/api/library/designs/${designId}/members/${users.bob!.id}`, "erin"),
        params({ designId, userId: users.bob!.id }),
      );
    for (let i = 0; i < 30; i += 1) {
      expect((await share("PUT")).status).toBe(200);
      // Sharing again with someone already in it adds nobody.
      if (i === 0) {
        expect((await share("PUT")).status).toBe(200);
      }
      expect((await share("DELETE")).status).toBe(200);
    }
    const refused = await share("PUT");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "You can share with 30 people an hour. Try again later.",
    });
  });
});

describe("saves, creations and deletes arriving at once", () => {
  afterEach(() => {
    gates.read = undefined;
    gates.count = undefined;
    clearDbFault();
    resetDbBreaker();
  });

  // The newer save (the owner's: it asks no membership first, so its
  // transaction starts first) lands first, which is the order where "exactly
  // one behind" is the right outcome; older first, both land and the newer wins.
  it("two saves racing with newer stamps, the newer landing first: it lands, the older is behind", async () => {
    await makeUser("race_own");
    await makeUser("race_mem");
    const designId = "design-race-1";
    const made = await design.PUT(
      request("PUT", `/api/library/designs/${designId}`, "race_own", upsertBody("Start", "2026-10-21T10:00:00.000Z")),
      params({ designId }),
    );
    expect(made.status).toBe(200);
    const shared = await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.race_mem!.id}`, "race_own"),
      params({ designId, userId: users.race_mem!.id }),
    );
    expect(shared.status).toBe(200);

    gates.read = gates.make(2);
    const [byOwner, byMember] = await Promise.all([
      design.PUT(
        request("PUT", `/api/library/designs/${designId}`, "race_own", upsertBody("Owner's", "2026-10-21T10:00:02.000Z")),
        params({ designId }),
      ),
      design.PUT(
        request(
          "PUT",
          `/api/library/designs/${designId}?owner=${users.race_own!.id}`,
          "race_mem",
          upsertBody("Member's", "2026-10-21T10:00:01.000Z"),
        ),
        params({ designId }),
      ),
    ]);
    expect([byOwner.status, byMember.status]).toEqual([200, 200]);
    const behind = [(await byOwner.json()).behind, (await byMember.json()).behind];
    expect(behind.filter((value) => value === false)).toHaveLength(1);
    const { rows } = await testDb().pglite.query<{ name: string }>(
      "select name from library_designs where user_id = $1 and id = $2",
      [users.race_own!.id, designId],
    );
    expect(rows).toEqual([{ name: "Owner's" }]);
  });

  it("the cap holds when creations arrive at once", async () => {
    await makeUser("cap_own");
    const owner = users.cap_own!.id;
    await testDb().pglite.query(
      `insert into library_designs (user_id, id, name, plan)
       select $1, 'seeded-' || n, 'Seeded', '{}' from generate_series(1, $2::int) as n`,
      [owner, LIBRARY_MAX_DESIGNS - 4],
    );
    gates.count = gates.make(5);
    const answers = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        design.PUT(
          request("PUT", `/api/library/designs/design-cap-${n}`, "cap_own", upsertBody(`Cap ${n}`, "2026-10-21T11:00:00.000Z")),
          params({ designId: `design-cap-${n}` }),
        ),
      ),
    );
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 409]);
    const refused = answers.find((answer) => answer.status === 409)!;
    expect(await refused.json()).toEqual({
      error: `Your plans are full (${LIBRARY_MAX_DESIGNS} designs). Delete some first.`,
    });
    const { rows } = await testDb().pglite.query<{ count: number }>(
      "select count(*)::int as count from library_designs where user_id = $1 and deleted_at is null",
      [owner],
    );
    expect(rows).toEqual([{ count: LIBRARY_MAX_DESIGNS }]);
  });

  it("a tombstone takes its members in the same write", async () => {
    await makeUser("tomb_own");
    await makeUser("tomb_mem");
    const designId = "design-tomb-1";
    await design.PUT(
      request("PUT", `/api/library/designs/${designId}`, "tomb_own", upsertBody("Kept", "2026-10-21T12:00:00.000Z")),
      params({ designId }),
    );
    await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.tomb_mem!.id}`, "tomb_own"),
      params({ designId, userId: users.tomb_mem!.id }),
    );

    withDbFault(/delete from "library_design_members"/);
    const deleted = await design.DELETE(
      request("DELETE", `/api/library/designs/${designId}`, "tomb_own"),
      params({ designId }),
    );
    expect(deleted.status).toBe(500);
    clearDbFault();

    const { rows } = await testDb().pglite.query<{ deleted_at: string | null }>(
      "select deleted_at from library_designs where user_id = $1 and id = $2",
      [users.tomb_own!.id, designId],
    );
    expect(rows).toEqual([{ deleted_at: null }]);
    const memberLibrary = await (await library.GET(request("GET", "/api/library", "tomb_mem"))).json();
    expect(memberLibrary.shared).toEqual([expect.objectContaining({ id: designId })]);
  });
});

/**
 * The statements each write sends, in order, as the direct client compiled
 * them. On PGlite transactions never overlap, so the race cases above pass
 * with or without row locks; these pin the locks that make them hold on
 * Postgres, where requests run on connections of their own.
 */
describe("the locks each write takes", () => {
  function recordSql(): string[] {
    const sent: string[] = [];
    setDbFaultForTests((text) => {
      sent.push(text);
      return undefined;
    });
    return sent;
  }
  const at = (sent: string[], pattern: RegExp, from = 0) => {
    const index = sent.findIndex((text, i) => i >= from && pattern.test(text));
    expect(index, `${pattern} in\n${sent.join("\n")}`).toBeGreaterThanOrEqual(0);
    return index;
  };
  const DESIGN_READ = /^select .*"live_lease_until" from "library_designs" where \("library_designs"\."user_id" = \$\d+ and "library_designs"\."id" = \$\d+\)/;
  const ACCOUNT_LOCK = /^select "id" from "community_users" where "id" = \$1 for no key update$/;

  it("a save reads its design for update, the owner's and a member's alike", async () => {
    await makeUser("lock_own");
    await makeUser("lock_mem");
    const designId = "design-lock-1";
    await design.PUT(
      request("PUT", `/api/library/designs/${designId}`, "lock_own", upsertBody("Lock", "2026-10-22T10:00:00.000Z")),
      params({ designId }),
    );
    await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.lock_mem!.id}`, "lock_own"),
      params({ designId, userId: users.lock_mem!.id }),
    );
    for (const [who, query, stamp] of [
      ["lock_own", "", "2026-10-22T10:01:00.000Z"],
      ["lock_mem", `?owner=${users.lock_own!.id}`, "2026-10-22T10:02:00.000Z"],
    ] as const) {
      const sent = recordSql();
      const saved = await design.PUT(
        request("PUT", `/api/library/designs/${designId}${query}`, who, upsertBody("Lock", stamp)),
        params({ designId }),
      );
      expect(saved.status).toBe(200);
      const read = at(sent, DESIGN_READ);
      expect(sent[read], who).toMatch(/ for update$/);
      at(sent, /^update "library_designs"/, read);
      clearDbFault();
    }
  });

  it("a new design locks its account, reads again, then counts and inserts", async () => {
    await makeUser("lock_new");
    const sent = recordSql();
    const saved = await design.PUT(
      request("PUT", "/api/library/designs/design-lock-new", "lock_new", upsertBody("New", "2026-10-22T11:00:00.000Z")),
      params({ designId: "design-lock-new" }),
    );
    expect(saved.status).toBe(200);
    const first = at(sent, DESIGN_READ);
    expect(sent[first]).toMatch(/ for update$/);
    const lock = at(sent, ACCOUNT_LOCK, first + 1);
    const again = at(sent, DESIGN_READ, lock + 1);
    expect(sent[again]).toMatch(/ for update$/);
    const count = at(sent, /^select count\(\*\) as "count" from "library_designs"/, again + 1);
    at(sent, /^insert into "library_designs"/, count + 1);
  });

  it("a new folder locks its account before it counts, and a folder save reads for update", async () => {
    await makeUser("lock_fold");
    const sent = recordSql();
    const saved = await folder.PUT(
      request("PUT", "/api/library/folders/folder-lock", "lock_fold", {
        name: "Locked",
        createdAt: "2026-10-22T12:00:00.000Z",
        updatedAt: "2026-10-22T12:00:00.000Z",
      }),
      params({ folderId: "folder-lock" }),
    );
    expect(saved.status).toBe(200);
    const read = at(sent, /^select .* from "library_folders" where .* for update$/);
    const lock = at(sent, ACCOUNT_LOCK, read + 1);
    at(sent, /^select .* from "library_folders" where .* for update$/, lock + 1);
    const count = at(sent, /^select count\(\*\) as "count" from "library_folders"/, lock + 1);
    at(sent, /^insert into "library_folders"/, count + 1);
  });

  it("a share locks the design before it counts members and inserts", async () => {
    await makeUser("lock_share");
    await makeUser("lock_guest");
    const designId = "design-lock-share";
    await design.PUT(
      request("PUT", `/api/library/designs/${designId}`, "lock_share", upsertBody("Share", "2026-10-22T13:00:00.000Z")),
      params({ designId }),
    );
    const sent = recordSql();
    const shared = await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.lock_guest!.id}`, "lock_share"),
      params({ designId, userId: users.lock_guest!.id }),
    );
    expect(shared.status).toBe(200);
    const lock = at(sent, /^select "id" from "library_designs" where .* for update$/);
    const list = at(sent, /^select .* from "library_design_members" inner join "community_users"/, lock + 1);
    at(sent, /^insert into "library_design_members"/, list + 1);
  });
});

const DOWN = { error: "The community database is not responding. Try again in a few minutes." };

/** Every answer is the down line, a 500 no cache keeps. */
async function expectDown(answers: Array<[string, Promise<Response>]>) {
  for (const [name, pending] of answers) {
    const answer = await pending;
    expect(answer.status, name).toBe(500);
    expect(answer.headers.get("cache-control"), name).toBe("no-store");
    expect(await answer.json(), name).toEqual(DOWN);
  }
}

describe("when the database fails a read", () => {
  /** The test database, failing every query or request that names `table` as a stalled database does. */
  function failing(table: string) {
    forgetSessionUsers();
    resetDbBreaker();
    withDbFault(new RegExp(`/rest/v1/${table}|"${table}"`));
  }

  afterEach(() => {
    clearDbFault();
    resetDbBreaker();
  });

  it("fails the library rather than answer it without the plans shared with you", async () => {
    // The client removes every shared copy a library answer leaves out.
    const designId = "design-outage-1";
    await design.PUT(
      request("PUT", `/api/library/designs/${designId}`, "carol", upsertBody("Glass", "2026-10-19T11:00:00.000Z")),
      params({ designId }),
    );
    await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.dan!.id}`, "carol"),
      params({ designId, userId: users.dan!.id }),
    );
    const healthy = await (await library.GET(request("GET", "/api/library", "dan"))).json();
    expect(healthy.shared).toEqual([expect.objectContaining({ id: designId })]);

    failing("library_design_members");
    const answer = await library.GET(request("GET", "/api/library", "dan"));
    expect(answer.status).toBe(500);
    expect((await answer.json()).shared).toBeUndefined();
  });

  it("says it cannot tell who is signed in, never that nobody is", async () => {
    failing("community_users");
    const answer = await library.GET(request("GET", "/api/library", "dan"));
    expect(answer.status).toBe(500);
    expect(await answer.json()).toEqual(DOWN);
    const me = await meRoute.GET(request("GET", "/api/community/auth/me", "dan"));
    expect(me.status).toBe(503);
    expect(await me.json()).toEqual({
      error: "The community database is not responding. Try again in a few minutes.",
    });

    clearDbFault();
    const back = await meRoute.GET(request("GET", "/api/community/auth/me", "dan"));
    expect(await back.json()).toEqual({ user: { username: "dan", isAdmin: false } });
    const gone = await meRoute.GET(
      new Request("http://localhost/api/community/auth/me", {
        headers: { cookie: `gtnh_session=${makeSessionToken("00000000-0000-4000-8000-000000000000")}` },
      }),
    );
    expect(await gone.json()).toEqual({ user: null });
  });

  it("answers the down line on every library, blueprint and search route once the account cache expired", async () => {
    const designId = "design-outage-2";
    const folderId = "folder-outage-2";
    const blueprintId = "0b6f7c1e-3d2a-4e5f-8a9b-1c2d3e4f5a6b";
    const shareTo = users.dan!.id;
    failing("community_users");
    await expectDown([
      ["library", library.GET(request("GET", "/api/library", "carol"))],
      [
        "design GET",
        design.GET(
          request("GET", `/api/library/designs/${designId}`, "carol"),
          params({ designId }),
        ),
      ],
      [
        "design PUT",
        design.PUT(
          request(
            "PUT",
            `/api/library/designs/${designId}`,
            "carol",
            upsertBody("Tin", "2026-10-19T11:00:00.000Z"),
          ),
          params({ designId }),
        ),
      ],
      [
        "design DELETE",
        design.DELETE(
          request("DELETE", `/api/library/designs/${designId}`, "carol"),
          params({ designId }),
        ),
      ],
      [
        "members",
        members.GET(
          request("GET", `/api/library/designs/${designId}/members`, "carol"),
          params({ designId }),
        ),
      ],
      [
        "share",
        member.PUT(
          request("PUT", `/api/library/designs/${designId}/members/${shareTo}`, "carol"),
          params({ designId, userId: shareTo }),
        ),
      ],
      [
        "unshare",
        member.DELETE(
          request("DELETE", `/api/library/designs/${designId}/members/${shareTo}`, "carol"),
          params({ designId, userId: shareTo }),
        ),
      ],
      [
        "folder PUT",
        folder.PUT(
          request("PUT", `/api/library/folders/${folderId}`, "carol", {
            name: "F",
            createdAt: "2026-10-19T11:00:00.000Z",
            updatedAt: "2026-10-19T11:00:00.000Z",
          }),
          params({ folderId }),
        ),
      ],
      [
        "folder DELETE",
        folder.DELETE(
          request("DELETE", `/api/library/folders/${folderId}`, "carol"),
          params({ folderId }),
        ),
      ],
    ]);
    await expectDown([
      ["blueprints", blueprintList.GET(request("GET", "/api/blueprints", "carol"))],
      [
        "blueprint POST",
        blueprintList.POST(request("POST", "/api/blueprints", "carol", { name: "B" })),
      ],
      [
        "blueprint GET",
        blueprintOne.GET(
          request("GET", `/api/blueprints/${blueprintId}`, "carol"),
          params({ blueprintId }),
        ),
      ],
      [
        "blueprint PUT",
        blueprintOne.PUT(
          request("PUT", `/api/blueprints/${blueprintId}`, "carol", { name: "B" }),
          params({ blueprintId }),
        ),
      ],
      [
        "blueprint DELETE",
        blueprintOne.DELETE(
          request("DELETE", `/api/blueprints/${blueprintId}`, "carol"),
          params({ blueprintId }),
        ),
      ],
    ]);
    await expectDown([
      ["search", search.GET(request("GET", "/api/accounts/search?q=da", "carol"))],
    ]);
  });

  it("answers the down line when the rate limit cannot be read or recorded", async () => {
    const designId = "design-outage-3";
    const folderId = "folder-outage-3";
    const blueprintId = "0b6f7c1e-3d2a-4e5f-8a9b-1c2d3e4f5a6c";
    const shareTo = users.dan!.id;
    failing("community_events");
    await expectDown([
      [
        "design PUT",
        design.PUT(
          request(
            "PUT",
            `/api/library/designs/${designId}`,
            "carol",
            upsertBody("Tin", "2026-10-19T11:00:00.000Z"),
          ),
          params({ designId }),
        ),
      ],
      [
        "share",
        member.PUT(
          request("PUT", `/api/library/designs/${designId}/members/${shareTo}`, "carol"),
          params({ designId, userId: shareTo }),
        ),
      ],
      [
        "folder PUT",
        folder.PUT(
          request("PUT", `/api/library/folders/${folderId}`, "carol", {
            name: "F",
            createdAt: "2026-10-19T11:00:00.000Z",
            updatedAt: "2026-10-19T11:00:00.000Z",
          }),
          params({ folderId }),
        ),
      ],
      [
        "blueprint POST",
        blueprintList.POST(request("POST", "/api/blueprints", "carol", { name: "B" })),
      ],
      [
        "blueprint PUT",
        blueprintOne.PUT(
          request("PUT", `/api/blueprints/${blueprintId}`, "carol", { name: "B" }),
          params({ blueprintId }),
        ),
      ],
    ]);
  });
});
