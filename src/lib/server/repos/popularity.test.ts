import { describe, expect, it } from "vitest";
import { setDbFaultForTests } from "@/lib/server/db/guard";
import { clearDbFault, useTestDb, withDbFault } from "@/test-support/test-db";
import { json } from "../db";
import * as plans from "./plans";
import { publicPlanPage } from "./popularity";

const testDb = useTestDb();

const OWNER = "a0000000-0000-4000-8000-0000000000b1";

/** Posts named by number, ids in that order, published unless listed in `unpublished`. */
async function seed(count: number, unpublished: number[] = []): Promise<void> {
  const db = testDb().db;
  await db.insertInto("community_users").values({ id: OWNER, username: "sweeper", password_hash: "x:y" }).execute();
  for (let i = 0; i < count; i++) {
    await db
      .insertInto("community_plans")
      .values({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        user_id: OWNER,
        author_name: "sweeper",
        name: `Post ${i}`,
        plan: json({ n: i }),
        outputs: json([{ kind: "item", resourceId: `r${i}` }]),
        is_public: !unpublished.includes(i),
        uploader_key: "test",
      })
      .execute();
  }
}

describe("publicPlanPage", () => {
  it("reads one page of the public posts by id, `limit` rows from `offset`, in one statement", async () => {
    await seed(25, [3, 4]);
    const sent: Array<{ text: string; parameters: readonly unknown[] }> = [];
    setDbFaultForTests((text, parameters) => {
      sent.push({ text, parameters });
      return undefined;
    });
    let page;
    try {
      page = await publicPlanPage(10, 10);
    } finally {
      clearDbFault();
    }
    expect(page.map((row) => (row.plan as { n: number }).n)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(page[0]).toEqual({ plan: { n: 12 }, outputs: [{ kind: "item", resourceId: "r12" }] });
    expect(sent).toEqual([
      {
        text: 'select "plan", "outputs" from "community_plans" where "community_plans"."is_public" = $1 order by "id" asc limit $2 offset $3',
        parameters: [true, 10, 10],
      },
    ]);
    // The first page skips the unpublished, the last is short, past the end is empty.
    expect((await publicPlanPage(0, 10)).map((row) => (row.plan as { n: number }).n)).toEqual([
      0, 1, 2, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(await publicPlanPage(20, 10)).toHaveLength(3);
    expect(await publicPlanPage(30, 10)).toEqual([]);
  });

  it("throws when the database does not answer, so the sweep keeps its last ranking", async () => {
    withDbFault(/from "community_plans"/);
    await expect(publicPlanPage(0, 10)).rejects.toThrow(
      "The community database is not responding. Try again in a few minutes.",
    );
  });
});

describe("publicByScore", () => {
  it("reads the public posts best score first, up to the limit, in one statement", async () => {
    const db = testDb().db;
    await db.updateTable("community_plans").set({ upvotes: 0 }).execute();
    for (const [n, upvotes] of [
      [7, 9],
      [3, 50],
      [11, 4],
    ] as const) {
      await db.updateTable("community_plans").set({ upvotes }).where("name", "=", `Post ${n}`).execute();
    }
    const sent: string[] = [];
    setDbFaultForTests((text) => {
      sent.push(text);
      return undefined;
    });
    let rows;
    try {
      rows = await plans.publicByScore<{ id: string; created_at: string; updated_at: string | null }>(
        2,
        plans.PLAN_LINK_FIELDS,
      );
    } finally {
      clearDbFault();
    }
    // Post 3 has the best score but is unpublished.
    expect(rows.map((row) => row.id)).toEqual([
      "00000000-0000-4000-8000-000000000007",
      "00000000-0000-4000-8000-000000000011",
    ]);
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/);
    expect(sent).toEqual([
      'select "id", "created_at", "updated_at" from "community_plans" where "community_plans"."is_public" = $1 order by "score" desc limit $2',
    ]);
  });
});
