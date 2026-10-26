import { describe, expect, it } from "vitest";
import { json } from "@/lib/server/db/parsers";
import { canReadBlueprint, canSeePlan } from "@/lib/server/services/access";
import { useTestDb } from "@/test-support/test-db";
import { OWNER, STRANGER, viewers } from "@/test-support/viewers";
import { sqlRules } from "./visibility";

const MEMBER = "33333333-3333-4333-8333-333333333333";

const testDb = useTestDb();

/** Seeds the rows once per test file; the database lives for the file. */
let seeded: Promise<void> | undefined;
function seed(): Promise<void> {
  seeded ??= (async () => {
    const { db } = testDb();
    await db
      .insertInto("community_users")
      .values([
        { id: OWNER, username: "owner", password_hash: "x" },
        { id: STRANGER, username: "stranger", password_hash: "x" },
        { id: MEMBER, username: "member", password_hash: "x" },
      ])
      .execute();
    const plan = (name: string, is_public: boolean, user_id: string | null) => ({
      name,
      is_public,
      user_id,
      plan: json({}),
      uploader_key: "k",
    });
    await db
      .insertInto("community_plans")
      .values([
        plan("published", true, OWNER),
        plan("published, account gone", true, null),
        plan("unpublished", false, OWNER),
        plan("unpublished, account gone", false, null),
        plan("unpublished, stranger's", false, STRANGER),
      ])
      .execute();
    const blueprint = (name: string, is_public: boolean, user_id: string) => ({
      name,
      is_public,
      user_id,
      payload: json({}),
    });
    await db
      .insertInto("blueprints")
      .values([
        blueprint("own private", false, OWNER),
        blueprint("own public", true, OWNER),
        blueprint("stranger's private", false, STRANGER),
        blueprint("stranger's public", true, STRANGER),
      ])
      .execute();
    const design = (user_id: string, id: string, lease: string | null, deleted = false) => ({
      user_id,
      id,
      name: `${user_id.slice(0, 1)}:${id}`,
      plan: json({}),
      live_lease_until: lease,
      live_lease_token: lease ? `token-${id}` : null,
      deleted_at: deleted ? "2026-01-01T00:00:00Z" : null,
    });
    await db
      .insertInto("library_designs")
      .values([
        // The same design id under two owners: membership names the owner too.
        design(OWNER, "d1", null),
        design(STRANGER, "d1", null),
        design(OWNER, "past", "2026-10-25T10:00:00Z"),
        design(OWNER, "future", "2026-10-25T14:00:00Z"),
        design(OWNER, "gone", null, true),
      ])
      .execute();
    await db
      .insertInto("library_design_members")
      .values({ owner_id: OWNER, design_id: "d1", member_id: MEMBER })
      .execute();
  })();
  return seeded;
}

describe("the SQL rules agree with the service rules", () => {
  it("planVisibleTo selects exactly the posts canSeePlan accepts, for every viewer", async () => {
    await seed();
    const { db } = testDb();
    const rows = await db
      .selectFrom("community_plans")
      .select(["name", "is_public", "user_id"])
      .execute();
    expect(rows).toHaveLength(5);
    for (const [viewerName, viewer] of Object.entries(viewers)) {
      const visible = await db
        .selectFrom("community_plans")
        .select("name")
        .where(sqlRules.planVisibleTo(viewer))
        .execute();
      const expected = rows.filter((row) => canSeePlan(viewer, row)).map((row) => row.name);
      expect(visible.map((row) => row.name).sort(), viewerName).toEqual(expected.sort());
    }
  });

  it("publicPlans is the published posts", async () => {
    await seed();
    const { db } = testDb();
    const shelf = await db
      .selectFrom("community_plans")
      .select("name")
      .where(sqlRules.publicPlans())
      .execute();
    expect(shelf.map((row) => row.name).sort()).toEqual(["published", "published, account gone"]);
  });

  it("blueprintReadableBy selects exactly the blueprints canReadBlueprint accepts, switch on and off", async () => {
    await seed();
    const { db } = testDb();
    const rows = await db
      .selectFrom("blueprints")
      .select(["name", "is_public", "user_id"])
      .execute();
    expect(rows).toHaveLength(4);
    for (const communityOn of [true, false]) {
      for (const [viewerName, viewer] of Object.entries(viewers)) {
        const readable = await db
          .selectFrom("blueprints")
          .select("name")
          .where(sqlRules.blueprintReadableBy(viewer, communityOn))
          .execute();
        const expected = rows
          .filter((row) => canReadBlueprint(viewer, row, communityOn))
          .map((row) => row.name);
        expect(
          readable.map((row) => row.name).sort(),
          `${viewerName}, switch ${communityOn}`,
        ).toEqual(expected.sort());
      }
    }
  });

  it("memberOf finds the member's design and not the other owner's design of the same id", async () => {
    await seed();
    const { db } = testDb();
    const sharedWith = async (userId: string) =>
      (
        await db
          .selectFrom("library_designs")
          .select(["user_id", "id"])
          .where(sqlRules.memberOf(userId))
          .execute()
      ).map((row) => `${row.user_id}/${row.id}`);
    expect(await sharedWith(MEMBER)).toEqual([`${OWNER}/d1`]);
    expect(await sharedWith(STRANGER)).toEqual([]);
    // The owner is not a member of their own design.
    expect(await sharedWith(OWNER)).toEqual([]);
  });

  it("designKey names one design by owner and id", async () => {
    await seed();
    const { db } = testDb();
    const rows = await db
      .selectFrom("library_designs")
      .select(["user_id", "id"])
      .where(sqlRules.designKey(STRANGER, "d1"))
      .execute();
    expect(rows).toEqual([{ user_id: STRANGER, id: "d1" }]);
  });

  it("leaseFreeAt is a null or run-out lease; leaseHeldBy and notTombstoned narrow as named", async () => {
    await seed();
    const { db } = testDb();
    const ids = async (rule: ReturnType<typeof sqlRules.leaseFreeAt>) =>
      (
        await db
          .selectFrom("library_designs")
          .select("id")
          .where("user_id", "=", OWNER)
          .where(rule)
          .execute()
      )
        .map((row) => row.id)
        .sort();
    expect(await ids(sqlRules.leaseFreeAt("2026-10-25T12:00:00.000Z"))).toEqual([
      "d1",
      "gone",
      "past",
    ]);
    expect(await ids(sqlRules.leaseHeldBy("token-future"))).toEqual(["future"]);
    expect(await ids(sqlRules.leaseHeldBy("token-other"))).toEqual([]);
    expect(await ids(sqlRules.notTombstoned())).toEqual(["d1", "future", "past"]);
  });
});
