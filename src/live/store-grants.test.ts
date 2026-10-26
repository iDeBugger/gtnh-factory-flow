import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { forgetSessionUsers } from "@/lib/server/auth/sessions";
import { useDbForTests } from "@/lib/server/db";
import { GuardedDialect } from "@/lib/server/db/guard";
import { applyMigrations } from "@/lib/server/db/migrations";
import type { Database } from "@/lib/server/db/schema";
import { deploySqlWithoutPsql } from "@/test-support/deploy-sql";
import { databasePlanStore } from "./store";

/**
 * The live store's own statements under the live service's database role
 * (`gtnh_live`, `tools/deploy/db/app-roles.sql`): every `PlanStore` method
 * runs with only the column grants the role holds, and the lease answers
 * as the rooms expect.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const STRANGER = "55555555-5555-4555-8555-555555555555";

let pglite: PGlite;

/** Runs `work` as the database owner, then goes back to the live role. */
async function asOwner<T>(work: () => Promise<T>): Promise<T> {
  await pglite.exec("reset role");
  try {
    return await work();
  } finally {
    await pglite.exec("set role gtnh_live");
  }
}

async function row(designId: string) {
  return asOwner(async () => {
    const { rows } = await pglite.query<{
      plan: unknown;
      seq: number;
      live_lease_until: string | null;
      live_lease_token: string | null;
      plan_bytes: number;
    }>(
      "select plan, seq, live_lease_until, live_lease_token, plan_bytes from library_designs where user_id = $1 and id = $2",
      [OWNER, designId],
    );
    return rows[0];
  });
}

beforeAll(async () => {
  pglite = new PGlite();
  await applyMigrations(pglite);
  await pglite.exec(deploySqlWithoutPsql("app-roles.sql"));
  await pglite.query(
    "insert into community_users (id, username, password_hash, session_epoch) values ($1, 'owner', 'h', 3), ($2, 'member', 'h', 0), ($3, 'stranger', 'h', 0)",
    [OWNER, MEMBER, STRANGER],
  );
  // 2,048 characters as Postgres prints the jsonb (a space after the colon).
  const bigPlan = JSON.stringify({ text: "x".repeat(2048 - '{"text": ""}'.length) });
  await pglite.query(
    `insert into library_designs (user_id, id, name, plan, seq) values
      ($1, 'd1', 'Design', '{"nodes":[]}', 7),
      ($1, 'big', 'Big', $2, 0),
      ($1, 'gone', 'Gone', '{}', 0)`,
    [OWNER, bigPlan],
  );
  await pglite.query("update library_designs set deleted_at = now() where id = 'gone'");
  await pglite.query(
    "insert into library_design_members (owner_id, design_id, member_id) values ($1, 'd1', $2)",
    [OWNER, MEMBER],
  );
  useDbForTests(
    new Kysely<Database>({ dialect: new GuardedDialect(new PGliteDialect({ pglite })) }),
  );
  await pglite.exec("set role gtnh_live");
}, 60_000);

afterEach(() => {
  forgetSessionUsers();
});

afterAll(async () => {
  useDbForTests(undefined);
  await pglite.close();
});

describe("the live store under the live role", () => {
  const store = databasePlanStore();
  const until = () => new Date(Date.now() + 90_000);

  it("reads accounts, roles, members, names and sizes", async () => {
    expect(await store.account(OWNER)).toEqual({ id: OWNER, username: "owner", epoch: 3 });
    expect(await store.account("00000000-0000-4000-8000-000000000000")).toBeUndefined();
    store.forgetAccount(OWNER);
    expect(await store.role(OWNER, OWNER, "d1")).toBe("owner");
    expect(await store.role(MEMBER, OWNER, "d1")).toBe("editor");
    expect(await store.role(STRANGER, OWNER, "d1")).toBeNull();
    expect(await store.members(OWNER, "d1")).toEqual([{ id: MEMBER, username: "member" }]);
    expect(await store.usernames([OWNER, MEMBER])).toEqual(
      new Map([
        [OWNER, "owner"],
        [MEMBER, "member"],
      ]),
    );
    expect(await store.size(OWNER, "big")).toBe(2048);
    expect(await store.size(OWNER, "big")).toBe((await row("big"))!.plan_bytes);
    expect(await store.size(OWNER, "gone")).toBeUndefined();
    expect(await store.size(OWNER, "missing")).toBeUndefined();
  });

  it("takes, renews, flushes and releases a lease conditional on its token", async () => {
    expect(await store.lease(OWNER, "d1", "tok-a", until())).toEqual({
      plan: { nodes: [] },
      seq: 7,
    });
    expect(await store.lease(OWNER, "gone", "tok-a", until())).toBeUndefined();
    expect(await store.lease(OWNER, "missing", "tok-a", until())).toBeUndefined();

    expect(await store.renew(OWNER, "d1", "tok-a", until())).toBe("held");
    expect(await store.renew(OWNER, "d1", "tok-other", until())).toBe("lost");
    expect(await store.renew(OWNER, "gone", "tok-a", until())).toBe("gone");
    expect(await store.renew(OWNER, "missing", "tok-a", until())).toBe("gone");

    expect(await store.flush(OWNER, "d1", "tok-a", { nodes: [1] } as never, 8, until())).toBe(
      "held",
    );
    expect(await row("d1")).toMatchObject({ plan: { nodes: [1] }, seq: 8, live_lease_token: "tok-a" });

    // The last flush ends the lease: token and time both cleared.
    expect(await store.flush(OWNER, "d1", "tok-a", { nodes: [2] } as never, 9, null)).toBe("held");
    expect(await row("d1")).toMatchObject({
      plan: { nodes: [2] },
      seq: 9,
      live_lease_until: null,
      live_lease_token: null,
    });
    expect(await store.flush(OWNER, "gone", "tok-a", {} as never, 1, null)).toBe("gone");
  });

  it("loses the lease to another token, and writes nothing after", async () => {
    await store.lease(OWNER, "d1", "tok-old", until());
    await store.lease(OWNER, "d1", "tok-new", until());
    const before = await row("d1");
    expect(await store.flush(OWNER, "d1", "tok-old", { nodes: ["stale"] } as never, 99, until())).toBe(
      "lost",
    );
    expect(await row("d1")).toEqual(before);
    // A release with the old token leaves the new lease alone.
    await store.release(OWNER, "d1", "tok-old");
    expect((await row("d1"))!.live_lease_token).toBe("tok-new");
    await store.release(OWNER, "d1", "tok-new");
    expect(await row("d1")).toMatchObject({ live_lease_until: null, live_lease_token: null });
  });
});
