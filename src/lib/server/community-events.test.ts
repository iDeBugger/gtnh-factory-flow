import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTestDb } from "@/test-support/test-db";
import {
  EVENTS_KEPT_DAYS,
  forgetEventPrune,
  PRUNE_BATCH_ROWS,
  recordEvents,
} from "./limits/rate-limit";

/**
 * The rate-limit events table against the local database: a record prunes
 * what no window reads any more, once an hour.
 */

const testDb = useTestDb();

async function insertAgedEvent(actorKey: string, daysBack: number): Promise<void> {
  await testDb()
    .db.insertInto("community_events")
    .values({ actor_key: actorKey, action: "probe", created_at: new Date(Date.now() - daysBack * 86_400_000).toISOString() })
    .execute();
}

async function actorsRecorded(): Promise<string[]> {
  const rows = await testDb().db.selectFrom("community_events").select("actor_key").orderBy("actor_key").execute();
  return rows.map((row) => row.actor_key);
}

beforeAll(() => {
  vi.stubEnv("COMMUNITY_HASH_SALT", "events-test-salt");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("recording events", () => {
  it("prunes what no window reads, once an hour", async () => {
    expect(EVENTS_KEPT_DAYS).toBeGreaterThan(30);
    await insertAgedEvent("old", 40);
    await insertAgedEvent("recent", 10);
    await recordEvents([{ actorKey: "now", action: "probe" }]);
    expect(await actorsRecorded()).toEqual(["now", "recent"]);

    // Within the hour nothing is pruned again.
    await insertAgedEvent("old-again", 40);
    await recordEvents([{ actorKey: "later", action: "probe" }]);
    expect(await actorsRecorded()).toEqual(["later", "now", "old-again", "recent"]);
  });

  async function insertBacklog(backlog: number): Promise<void> {
    await testDb().pglite.exec("delete from community_events");
    await testDb()
      .db.insertInto("community_events")
      .values(
        Array.from({ length: backlog }, (_, i) => ({
          actor_key: `stale-${String(i).padStart(5, "0")}`,
          action: "probe",
          created_at: new Date(Date.now() - (60 + backlog - i) * 86_400_000).toISOString(),
        })),
      )
      .execute();
  }

  it("drains a backlog of many batches in one prune while its time lasts", async () => {
    await insertBacklog(PRUNE_BATCH_ROWS * 6 + 7);
    forgetEventPrune();
    await recordEvents([{ actorKey: "now", action: "probe" }]);
    expect(await actorsRecorded()).toEqual(["now"]);
  }, 60_000);

  it("stops at its time budget, the oldest first, and leaves the rest for the next hour", async () => {
    const backlog = PRUNE_BATCH_ROWS * 2 + 7;
    await insertBacklog(backlog);
    // No time at all: one batch, then the budget is spent.
    forgetEventPrune(0);
    await recordEvents([{ actorKey: "now", action: "probe" }]);
    const left = await actorsRecorded();
    expect(left).toHaveLength(backlog - PRUNE_BATCH_ROWS + 1);
    expect(left[0]).toBe("now");
    expect(left[1]).toBe(`stale-${String(PRUNE_BATCH_ROWS).padStart(5, "0")}`);
    forgetEventPrune();
    await recordEvents([{ actorKey: "later", action: "probe" }]);
    expect(await actorsRecorded()).toEqual(["later", "now"]);
  }, 60_000);
});
