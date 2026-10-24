import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { EVENTS_KEPT_DAYS, getCommunityDb, recordEvents } from "./community";

/**
 * The rate-limit events table against the local database: a record prunes
 * what no window reads any more, once an hour.
 */

let local: LocalDatabase;

async function insertAgedEvent(actorKey: string, daysBack: number): Promise<void> {
  const { error } = await getCommunityDb()
    .from("community_events")
    .insert({ actor_key: actorKey, action: "probe", created_at: new Date(Date.now() - daysBack * 86_400_000).toISOString() });
  expect(error).toBeNull();
}

async function actorsRecorded(): Promise<string[]> {
  const { data } = await getCommunityDb().from("community_events").select("actor_key").order("actor_key");
  return ((data ?? []) as Array<{ actor_key: string }>).map((row) => row.actor_key);
}

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "events-test-salt");
  local = await openLocalDatabase();
  useInProcessLocalDb(local.handle);
}, 60_000);

afterAll(async () => {
  useInProcessLocalDb(undefined);
  await local?.close();
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
});
