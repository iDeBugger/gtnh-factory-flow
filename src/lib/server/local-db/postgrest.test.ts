import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "./database";

/**
 * The local database answers supabase-js the way PostgREST does, for every
 * query shape the server code sends (each test names the route it mirrors).
 */

let local: LocalDatabase;
let db: SupabaseClient;

beforeAll(async () => {
  local = await openLocalDatabase();
  db = createClient("http://local-db.test", "key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => local.handle(new Request(input, init)) },
  });
}, 60_000);

afterAll(async () => {
  await local?.close();
});

async function makeUser(username: string): Promise<string> {
  const { data, error } = await db
    .from("community_users")
    .insert({ username, password_hash: "salt:hash" })
    .select("id,username")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

describe("the local database's PostgREST stand-in", () => {
  it("inserts, reads one row back, and answers no row as maybeSingle does", async () => {
    const id = await makeUser("alice");
    const { data } = await db
      .from("community_users")
      .select("id,username,is_admin")
      .eq("id", id)
      .single();
    expect(data).toEqual({ id, username: "alice", is_admin: false });
    const missing = await db
      .from("community_users")
      .select("id")
      .eq("id", "00000000-0000-4000-8000-000000000000")
      .maybeSingle();
    expect(missing).toMatchObject({ data: null, error: null });
    const single = await db
      .from("community_users")
      .select("id")
      .eq("id", "00000000-0000-4000-8000-000000000000")
      .single();
    expect(single.error?.code).toBe("PGRST116");
  });

  it("refuses a duplicate with Postgres's code and PostgREST's status", async () => {
    await makeUser("bob");
    const { error, status } = await db
      .from("community_users")
      .insert({ username: "bob", password_hash: "x" });
    expect(status).toBe(409);
    expect(error?.code).toBe("23505");
  });

  it("counts with head and a time window (rate limits)", async () => {
    await db.from("community_events").insert([
      { actor_key: "k", action: "save" },
      { actor_key: "k", action: "save" },
      { actor_key: "k", action: "other" },
    ]);
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count, data } = await db
      .from("community_events")
      .select("id", { count: "exact", head: true })
      .eq("actor_key", "k")
      .eq("action", "save")
      .gte("created_at", since);
    expect(count).toBe(2);
    expect(data).toBeNull();
  });

  it("writes and reads library designs: jsonb, timestamps, update, tombstone filter (library routes)", async () => {
    const userId = await makeUser("carol");
    const plan = { schemaVersion: 1, nodes: [{ id: "n1", gtnhplanner: { v: 1 } }], ratio: 1.5 };
    const stamp = "2026-10-14T12:00:00.000Z";
    const inserted = await db
      .from("library_designs")
      .insert({
        user_id: userId,
        id: "design-1",
        name: "Steel",
        plan,
        created_at: stamp,
        updated_at: stamp,
        plan_updated_at: stamp,
        deleted_at: null,
      })
      .select("id,name,updated_at,deleted_at")
      .single();
    expect(inserted.data).toEqual({
      id: "design-1",
      name: "Steel",
      updated_at: "2026-10-14T12:00:00+00:00",
      deleted_at: null,
    });
    const read = await db
      .from("library_designs")
      .select("id,plan")
      .eq("user_id", userId)
      .eq("id", "design-1")
      .maybeSingle();
    expect((read.data as { plan: unknown }).plan).toEqual(plan);
    const updated = await db
      .from("library_designs")
      .update({ name: "Steel 2", favorite: true })
      .eq("user_id", userId)
      .eq("id", "design-1")
      .select("name,favorite")
      .single();
    expect(updated.data).toEqual({ name: "Steel 2", favorite: true });
    const { count } = await db
      .from("library_designs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("deleted_at", null);
    expect(count).toBe(1);
  });

  it("upserts on a named conflict target (library folders)", async () => {
    const userId = await makeUser("dave");
    const row = { user_id: userId, id: "folder-1", name: "Ores", deleted_at: null };
    await db.from("library_folders").upsert(row, { onConflict: "user_id,id" });
    const again = await db
      .from("library_folders")
      .upsert({ ...row, name: "Ores 2" }, { onConflict: "user_id,id" })
      .select("id,name")
      .single();
    expect(again.data).toEqual({ id: "folder-1", name: "Ores 2" });
  });

  it("searches, filters, orders with nulls last and pages with a total (community list)", async () => {
    const userId = await makeUser("erin");
    // Rows of one insert carry the same keys: a key missing from one is null there, as in PostgREST.
    const base = {
      uploader_key: "u",
      user_id: userId,
      author_name: "erin",
      plan: {},
      description: "",
      tags: [],
      tags_text: "",
      is_public: true,
      last_activity_at: null,
    };
    const inserted = await db.from("community_plans").insert([
      {
        ...base,
        name: "Oil cracking",
        tags: ["oil"],
        tags_text: "oil",
        outputs: [{ kind: "fluid", resourceId: "diesel", rate: 2 }],
        highest_tier_index: 3,
        last_activity_at: "2026-10-01T00:00:00Z",
      },
      {
        ...base,
        name: "Steel line",
        tags_text: "metal",
        outputs: [],
        highest_tier_index: 1,
        is_public: false,
      },
      {
        ...base,
        name: "Diesel power",
        description: "oil to EU",
        outputs: [{ kind: "fluid", resourceId: "diesel", rate: 9 }],
        highest_tier_index: 2,
      },
    ]);
    expect(inserted.error).toBeNull();
    const term = "oil";
    const { data, count } = await db
      .from("community_plans")
      .select("id,name,last_activity_at", { count: "exact" })
      .or(`name.ilike.%${term}%,description.ilike.%${term}%,tags_text.ilike.%${term}%`)
      .lte("highest_tier_index", 3)
      .contains("outputs", JSON.stringify([{ kind: "fluid", resourceId: "diesel" }]))
      .eq("is_public", true)
      .order("last_activity_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .range(0, 0);
    expect(count).toBe(2);
    expect((data as Array<{ name: string }>).map((row) => row.name)).toEqual(["Oil cracking"]);
    const nullable = await db
      .from("community_plans")
      .select("name")
      .or("is_public.eq.true,is_public.is.null")
      .order("name");
    expect((nullable.data as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "Diesel power",
      "Oil cracking",
    ]);
  });

  it("filters with in, deletes, and refuses unknown tables and columns", async () => {
    const userId = await makeUser("frank");
    const { data: plan } = await db
      .from("community_plans")
      .insert({ uploader_key: "u", user_id: userId, name: "Votes", plan: {} })
      .select("id")
      .single();
    const planId = (plan as { id: string }).id;
    await db.from("community_votes").upsert({ plan_id: planId, voter_key: "v1", value: 1 });
    await db.from("community_votes").upsert({ plan_id: planId, voter_key: "v1", value: -1 });
    const votes = await db
      .from("community_votes")
      .select("plan_id,value")
      .eq("voter_key", "v1")
      .in("plan_id", [planId]);
    expect(votes.data).toEqual([{ plan_id: planId, value: -1 }]);
    await db.from("community_votes").delete().eq("plan_id", planId).eq("voter_key", "v1");
    const { count } = await db
      .from("community_votes")
      .select("plan_id", { count: "exact", head: true })
      .eq("plan_id", planId);
    expect(count).toBe(0);
    const table = await db.from("no_such_table").select("id");
    expect(table.error?.code).toBe("PGRST205");
    const column = await db.from("community_plans").select("no_such_column");
    expect(column.error?.code).toBe("42703");
    const insertColumn = await db
      .from("community_events")
      .insert({ actor_key: "k", action: "a", nope: 1 });
    expect(insertColumn.error?.code).toBe("PGRST204");
  });
});
