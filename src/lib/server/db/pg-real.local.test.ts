import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import aluminaLine from "@/components/flow/__fixtures__/alumina-line-shared-reactor.json";
import { BLUEPRINT_MAX_PER_USER } from "@/lib/blueprints/types";
import { LIBRARY_MAX_DESIGNS } from "@/lib/library/sync-types";
import { PROJECT_SCHEMA_VERSION } from "@/lib/model/types";
import { databasePlanStore } from "@/live/store";
import { forgetSessionUsers } from "../auth/sessions";
import type { SignedIn, Viewer } from "../http/viewer";
import * as accounts from "../repos/accounts";
import * as comments from "../repos/comments";
import * as designMembers from "../repos/design-members";
import * as designs from "../repos/designs";
import * as events from "../repos/events";
import * as plans from "../repos/plans";
import * as popularity from "../repos/popularity";
import { saveBlueprint } from "../services/blueprints";
import { addComment } from "../services/comments";
import { countPlanView } from "../services/community-plans";
import { saveDesign } from "../services/library";
import { castVote } from "../services/votes";
import { createDbClient, type DirectDbClient } from "./client";
import { closeDb, resetDbBreaker, setDbForTests, withTransaction } from "./index";

/**
 * The repository cases of the direct swap against a real Postgres reached as
 * the deploy's own roles: the rehearsal stack's database, which
 * `compose.rehearsal.yml` publishes on 127.0.0.1:3482. Each process's
 * statements run under the role that process logs in as, with the grants
 * `db/grants.sql` gives it, and the races run with transactions that truly
 * overlap (on PGlite they never do). It WRITES rows, under fresh account
 * names, and deletes them after, so point it only at a throwaway database.
 *
 *   REAL_DATABASE_URL=postgres://gtnh_site:<password>@127.0.0.1:3482/postgres \
 *   REAL_LIVE_DATABASE_URL=postgres://gtnh_live:<password>@127.0.0.1:3482/postgres \
 *     npx vitest run src/lib/server/db/pg-real.local.test.ts --config vitest.local.config.ts
 *
 * Skipped without REAL_DATABASE_URL; the live store's cases also need
 * REAL_LIVE_DATABASE_URL.
 */

// The rate limits queue one key's requests in this process (`serially`),
// which spaces their transactions out; without them the requests all start
// at once, as requests from several site processes would.
vi.mock("../limits/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../limits/rate-limit")>()),
  checkRateLimit: async () => true,
}));

const siteUrl = process.env.REAL_DATABASE_URL;
const liveUrl = process.env.REAL_LIVE_DATABASE_URL;
// Fresh names per run: the database may hold earlier runs' rows and the
// rehearsal's own accounts. A username is 3 to 24 characters.
const RUN = Math.random().toString(36).slice(2, 8);
const STAMP = "2026-10-21T10:00:00.000Z";

let site: DirectDbClient;
let live: DirectDbClient | undefined;
let owner: SignedIn;
let member: SignedIn;
const made: string[] = [];

async function account(label: string): Promise<SignedIn> {
  const row = await accounts.createAccount(`pr${RUN}${label}`, "hash");
  if (row === "taken") {
    throw new Error(`pr${RUN}${label} is taken`);
  }
  made.push(row.id);
  return { userId: row.id, username: row.username, isAdmin: false, adminToken: false };
}

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
  };
}

function upsert(name: string, stamp: string) {
  return { name, createdAt: STAMP, updatedAt: stamp, planUpdatedAt: stamp, plan: plan(name) };
}

async function makePost(name: string): Promise<string> {
  const { rows } = await site.pool.query<{ id: string }>(
    `insert into community_plans (user_id, author_name, name, game_version, plan, uploader_key)
     values ($1, $2, $3, $4, '{"nodes":[]}', 'pg-real') returning id`,
    [owner.userId, owner.username, name, `pg-real-${RUN}`],
  );
  return rows[0]!.id;
}

const anonymous: Viewer = { isAdmin: false, adminToken: false };
const fromAddress = (address: string) =>
  new Request("http://localhost/", { method: "POST", headers: { "x-client-ip": address } });

describe.skipIf(!siteUrl)("Postgres as the deploy's roles", () => {
  beforeAll(async () => {
    site = createDbClient("site", { DATABASE_URL: siteUrl, DATABASE_POOL_MAX: "12" });
    setDbForTests(site.db);
    owner = await account("o");
    member = await account("m");
  }, 60_000);

  afterAll(async () => {
    setDbForTests(site.db);
    // Every row the cases made hangs off these accounts (on delete cascade)
    // but the event log's, which is keyed by its actor.
    if (made.length > 0) {
      await site.pool.query("delete from community_users where id = any($1)", [made]);
    }
    await site.pool.query("delete from community_events where actor_key like $1", [`pg-real-${RUN}%`]);
    setDbForTests(undefined);
    await site.db.destroy();
    await live?.db.destroy();
    await closeDb();
    resetDbBreaker();
  }, 60_000);

  describe("the site role", () => {
    it("logs in as gtnh_site and holds no more than its grants", async () => {
      const { rows } = await site.pool.query<{ current_user: string }>("select current_user");
      expect(rows[0]!.current_user).toBe("gtnh_site");
      await expect(site.pool.query("select * from schema_migrations")).rejects.toThrow(/permission denied/);
      await expect(site.pool.query("create table pg_real_probe (a int)")).rejects.toThrow(/permission denied/);
    });

    it("searches account names by the typed characters only, and takes a name once", async () => {
      const underscore = await account("_b");
      await account("xb");
      expect((await accounts.searchByPrefix(`pr${RUN}_`, owner.userId)).map((row) => row.id)).toEqual([
        underscore.userId,
      ]);
      expect(await accounts.createAccount(underscore.username, "hash")).toBe("taken");
      expect(await accounts.readLoginAccount(underscore.username)).toMatchObject({ password_hash: "hash" });
      await accounts.setSessionEpoch(underscore.userId, 1_766_000_000_000);
      expect(await accounts.readSessionAccount(underscore.userId)).toMatchObject({ session_epoch: 1_766_000_000_000 });
      expect(await accounts.accountExists(underscore.userId)).toBe(true);
      expect((await accounts.usernamesFor([owner.userId, member.userId])).size).toBe(2);
    });

    it("counts, prunes and records the event log", async () => {
      const actor = `pg-real-${RUN}`;
      await events.insert([
        { actorKey: actor, action: "probe" },
        { actorKey: actor, action: "probe" },
      ]);
      expect(await events.countSince(actor, "probe", new Date(Date.now() - 60_000))).toBe(2);
      expect((await events.oldestIdsBefore(new Date(Date.now() + 60_000), 5)).length).toBeGreaterThan(0);
    });

    it("lets one of two saves with newer stamps land and keeps the newest name", async () => {
      for (let round = 0; round < 8; round++) {
        const designId = `pg-real-race-${round}`;
        const start = await saveDesign(owner, owner.userId, designId, upsert("Start", STAMP));
        expect(start.ok).toBe(true);
        await withTransaction(async (tx) => {
          expect(await designMembers.lockDesign(owner.userId, designId, tx)).toBe(true);
          expect(await designMembers.add(owner.userId, designId, member.userId, tx)).toBe("added");
        });
        const [byOwner, byMember] = await Promise.all([
          saveDesign(owner, owner.userId, designId, upsert("Owner's", "2026-10-21T10:00:02.000Z")),
          saveDesign(member, owner.userId, designId, upsert("Member's", "2026-10-21T10:00:01.000Z")),
        ]);
        expect(byOwner).toMatchObject({ ok: true, value: { behind: false } });
        expect(byMember.ok).toBe(true);
        expect(await designs.read(owner.userId, designId, { withPlan: false })).toMatchObject({ name: "Owner's" });
      }
    }, 60_000);

    it("holds the design cap when twenty creations arrive at once", async () => {
      const creator = await account("c");
      const free = 10;
      await site.pool.query(
        `insert into library_designs (user_id, id, name, plan)
         select $1, 'seeded-' || n, 'Seeded', '{}' from generate_series(1, $2::int) as n`,
        [creator.userId, LIBRARY_MAX_DESIGNS - free],
      );
      const answers = await Promise.all(
        Array.from({ length: 20 }, (_, n) => saveDesign(creator, creator.userId, `race-${n}`, upsert(`Race ${n}`, STAMP))),
      );
      expect(answers.filter((answer) => answer.ok)).toHaveLength(free);
      expect(await designs.countLive(creator.userId)).toBe(LIBRARY_MAX_DESIGNS);
    }, 60_000);

    it("tombstones a design and drops its members in one transaction", async () => {
      const designId = "pg-real-gone";
      expect((await saveDesign(owner, owner.userId, designId, upsert("Gone", STAMP))).ok).toBe(true);
      await withTransaction((tx) => designMembers.add(owner.userId, designId, member.userId, tx));
      await withTransaction(async (tx) => {
        await designs.tombstone(owner.userId, designId, STAMP, tx);
        await designMembers.deleteOfDesign(owner.userId, designId, tx);
      });
      expect(await designMembers.list(owner.userId, designId)).toEqual([]);
      expect(await designs.read(owner.userId, designId, { withPlan: false })).toMatchObject({
        deleted_at: expect.anything(),
      });
    });

    it("counts twenty views at once as twenty, and keeps a thread's count equal to its comments", async () => {
      const watched = await makePost("Watched");
      const viewed = await Promise.all(
        Array.from({ length: 20 }, () => countPlanView(anonymous, watched, fromAddress("10.9.0.1"))),
      );
      expect(viewed.every((answer) => answer.ok)).toBe(true);
      expect(await plans.readSummary(watched)).toMatchObject({ views: 20 });

      const thread = await makePost("Busy thread");
      const added = await Promise.all(
        Array.from({ length: 10 }, (_, i) => addComment(owner, thread, owner.userId, { body: `Comment ${i}` })),
      );
      expect(added.every((answer) => answer.ok)).toBe(true);
      expect(await comments.list(thread, 50)).toHaveLength(10);
      expect(await plans.readSummary(thread)).toMatchObject({ comment_count: 10 });
    }, 60_000);

    it("reads a page and its count on one snapshot, whatever commits between them", async () => {
      await makePost("Before");
      const query: plans.PlanListQuery = {
        search: { tags: [], author: "", bareAuthor: false, text: "" },
        gameVersion: `pg-real-${RUN}`,
        makes: [],
        takes: [],
        shelf: { kind: "public" },
        sort: { column: "created_at", ascending: false, nullsLast: false },
        offset: 0,
        limit: 100,
      };
      const result = await withTransaction(
        async (tx) => {
          const first = await plans.list(query, tx);
          await makePost("Between");
          return { first, second: await plans.list(query, tx) };
        },
        { readSnapshot: true },
      );
      expect(result.second).toEqual(result.first);
      expect((await plans.list(query)).total).toBe(result.first.total + 1);
      // A page past the last still counts every post.
      expect(await plans.list({ ...query, offset: 9_900 })).toMatchObject({ rows: [], total: result.first.total + 1 });
    });

    it("lands ten votes at once from ten addresses as ten", async () => {
      const voted = await makePost("Rushed");
      const answers = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          castVote("plan", voted, anonymous, { deviceId: `rush-${i}`, value: 1 }, fromAddress(`10.8.0.${i + 1}`)),
        ),
      );
      expect(answers.every((answer) => answer.ok)).toBe(true);
      const { rows } = await site.pool.query<{ upvotes: number; up: number }>(
        `select p.upvotes, (select count(*)::int from community_votes v where v.plan_id = p.id and v.value = 1) as up
         from community_plans p where p.id = $1`,
        [voted],
      );
      expect(rows[0]).toEqual({ upvotes: 10, up: 10 });
    }, 60_000);

    it("holds the blueprint cap when twenty saves arrive at once with one place left", async () => {
      const saver = await account("s");
      await site.pool.query(
        `insert into blueprints (user_id, name, payload)
         select $1, 'Held ' || n, '{"nodes":[]}' from generate_series(1, $2::int) as n`,
        [saver.userId, BLUEPRINT_MAX_PER_USER - 1],
      );
      const payload = {
        nodes: aluminaLine.nodes,
        storages: aluminaLine.storages ?? [],
        annotations: [],
        pockets: [],
        edges: aluminaLine.edges ?? [],
        recipes: aluminaLine.recipes,
      };
      const answers = await Promise.all(
        Array.from({ length: 20 }, (_, n) => saveBlueprint(saver, { name: `Race ${n}`, payload })),
      );
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      const { rows } = await site.pool.query<{ count: number }>(
        "select count(*)::int as count from blueprints where user_id = $1",
        [saver.userId],
      );
      expect(rows[0]!.count).toBe(BLUEPRINT_MAX_PER_USER);
    }, 60_000);

    it("reads the public posts by score and the popularity sweep's pages", async () => {
      const ranked = await makePost("Ranked");
      const links = await plans.publicByScore<{ id: string }>(10_000, plans.PLAN_LINK_FIELDS);
      expect(links.map((row) => row.id)).toContain(ranked);
      const page = await popularity.publicPlanPage(0, 10);
      expect(page.length).toBeGreaterThan(0);
      expect(page[0]).toHaveProperty("plan");
    });
  });

  describe.skipIf(!liveUrl)("the live role", () => {
    const store = databasePlanStore();
    const until = () => new Date(Date.now() + 90_000);

    beforeAll(async () => {
      expect((await saveDesign(owner, owner.userId, "pg-real-live", upsert("Live", STAMP))).ok).toBe(true);
      await withTransaction((tx) => designMembers.add(owner.userId, "pg-real-live", member.userId, tx));
      live = createDbClient("live", { DATABASE_URL: liveUrl });
      setDbForTests(live.db);
    }, 60_000);

    afterAll(() => {
      forgetSessionUsers();
      setDbForTests(site.db);
    });

    it("logs in as gtnh_live and reads no password", async () => {
      const { rows } = await live!.pool.query<{ current_user: string }>("select current_user");
      expect(rows[0]!.current_user).toBe("gtnh_live");
      await expect(live!.pool.query("select password_hash from community_users")).rejects.toThrow(/permission denied/);
      await expect(live!.pool.query("update library_designs set name = 'x'")).rejects.toThrow(/permission denied/);
    });

    it("runs every store call and answers the lease as the rooms expect", async () => {
      expect(await store.account(owner.userId)).toMatchObject({ id: owner.userId, username: owner.username });
      expect(await store.role(member.userId, owner.userId, "pg-real-live")).toBe("editor");
      expect(await store.members(owner.userId, "pg-real-live")).toEqual([{ id: member.userId, username: member.username }]);
      expect(await store.usernames([owner.userId])).toEqual(new Map([[owner.userId, owner.username]]));
      expect(await store.size(owner.userId, "pg-real-live")).toBeGreaterThan(0);

      expect(await store.lease(owner.userId, "pg-real-live", "tok-a", until())).toMatchObject({ seq: 0 });
      expect(await store.renew(owner.userId, "pg-real-live", "tok-a", until())).toBe("held");
      expect(await store.renew(owner.userId, "pg-real-live", "tok-b", until())).toBe("lost");
      expect(await store.renew(owner.userId, "pg-real-gone", "tok-a", until())).toBe("gone");
      expect(await store.flush(owner.userId, "pg-real-live", "tok-a", plan("Flushed") as never, 1, until())).toBe("held");
      await store.lease(owner.userId, "pg-real-live", "tok-new", until());
      expect(await store.flush(owner.userId, "pg-real-live", "tok-a", plan("Stale") as never, 2, until())).toBe("lost");
      await store.release(owner.userId, "pg-real-live", "tok-new");

      setDbForTests(site.db);
      expect(await designs.read(owner.userId, "pg-real-live", { withPlan: true })).toMatchObject({
        seq: 1,
        plan: { name: "Flushed" },
        live_lease_until: null,
      });
      setDbForTests(live!.db);
    });
  });
});
