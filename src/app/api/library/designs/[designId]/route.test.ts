import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { planWithAdditions } from "@/lib/model/__fixtures__/plan-additions";
import type { FactoryProject } from "@/lib/model/types";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { getCommunityDb } from "@/lib/server/db";
import { makeSessionToken } from "@/lib/server/auth/sessions";
import { oversizeRequest } from "@/test-support/request-bodies";
import { GET, PUT } from "./route";

/**
 * The library PUT keeps a plan's cloud and live additions: what the game wrote
 * on each thing, the view it opens on and its task board reach the database
 * and come back from the GET as sent (the local database: real Postgres
 * jsonb in between).
 */

let local: LocalDatabase;
let cookie = "";

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "library-put-test-salt");
  local = await openLocalDatabase();
  useInProcessLocalDb(local.handle);
  const { data } = await getCommunityDb()
    .from("community_users")
    .insert({ username: "ann", password_hash: "x:y" })
    .select("id")
    .single();
  cookie = `gtnh_session=${makeSessionToken((data as { id: string }).id)}`;
}, 60_000);

afterAll(async () => {
  useInProcessLocalDb(undefined);
  await local?.close();
  vi.unstubAllEnvs();
});

describe("the library design PUT", () => {
  it("stores the plan's game data, game version, view and tasks as sent", async () => {
    const plan = { ...planWithAdditions(), gameVersion: "2.8.1" };
    const stamp = "2026-10-14T12:00:00.000Z";
    const context = { params: Promise.resolve({ designId: "design-additions" }) };
    const response = await PUT(
      new Request("http://localhost/api/library/designs/design-additions", {
        method: "PUT",
        headers: { cookie },
        body: JSON.stringify({
          name: "Biodiesel",
          icon: null,
          folderId: null,
          closed: false,
          favorite: false,
          order: null,
          communityPlanId: null,
          createdAt: stamp,
          updatedAt: stamp,
          planUpdatedAt: stamp,
          plan,
        }),
      }),
      context,
    );
    expect(response.status).toBe(200);
    const read = await GET(
      new Request("http://localhost/api/library/designs/design-additions", { headers: { cookie } }),
      context,
    );
    const stored = (await read.json()).plan as FactoryProject;
    expect(stored.gtnhplanner).toEqual(plan.gtnhplanner);
    expect(stored.primaryView).toBe("tasks");
    expect(stored.gameVersion).toBe("2.8.1");
    expect(stored.nodes[0]!.gtnhplanner).toEqual(plan.nodes[0]!.gtnhplanner);
    expect(stored.storages?.[0]?.gtnhplanner).toEqual(plan.storages?.[0]?.gtnhplanner);
    expect(stored.edges[0]!.gtnhplanner).toEqual(plan.edges[0]!.gtnhplanner);
    expect(stored.annotations?.[0]?.gtnhplanner).toEqual(plan.annotations?.[0]?.gtnhplanner);
    expect(stored.tasks).toEqual(plan.tasks);
    expect(stored.taskItems).toEqual(plan.taskItems);
    expect(stored.taskComments).toEqual(plan.taskComments);
  });

  it("refuses a save whose declared length is over the cap without reading it", async () => {
    const { request, counts } = oversizeRequest(
      "http://localhost/api/library/designs/design-big",
      "PUT",
      5 * 1024 * 1024,
      { cookie },
    );
    const response = await PUT(request, { params: Promise.resolve({ designId: "design-big" }) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "This design is too large to sync." });
    expect(counts.pulls).toBe(0);
  });
});
