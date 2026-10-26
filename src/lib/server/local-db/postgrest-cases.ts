import { expect } from "vitest";
import type { DbClient } from "../community";

/**
 * The query shapes the server sends, each named after the route it mirrors,
 * with what PostgREST answers. One list for two exams: `postgrest.test.ts`
 * runs it against the local stand-in, `postgrest-real.local.test.ts` against a
 * real PostgREST (the Docker stack), so the stand-in and the real service are
 * held to the same answers. The cases write rows: run them on an empty
 * database.
 */
export function postgrestCases(
  getDb: () => DbClient,
): Array<{ name: string; run(): Promise<void> }> {
  async function makeUser(username: string): Promise<string> {
    const { data, error } = await getDb()
      .from("community_users")
      .insert({ username, password_hash: "salt:hash" })
      .select("id,username")
      .single();
    expect(error).toBeNull();
    return (data as { id: string }).id;
  }

  return [
    {
      name: "inserts, reads one row back, and answers no row as maybeSingle does",
      async run() {
        const id = await makeUser("alice");
        const { data } = await getDb()
          .from("community_users")
          .select("id,username,is_admin")
          .eq("id", id)
          .single();
        expect(data).toEqual({ id, username: "alice", is_admin: false });
        const missing = await getDb()
          .from("community_users")
          .select("id")
          .eq("id", "00000000-0000-4000-8000-000000000000")
          .maybeSingle();
        expect(missing).toMatchObject({ data: null, error: null });
        const single = await getDb()
          .from("community_users")
          .select("id")
          .eq("id", "00000000-0000-4000-8000-000000000000")
          .single();
        expect(single.error?.code).toBe("PGRST116");
      },
    },
    {
      name: "refuses a duplicate with Postgres's code and PostgREST's status",
      async run() {
        await makeUser("bob");
        const { error, status } = await getDb()
          .from("community_users")
          .insert({ username: "bob", password_hash: "x" });
        expect(status).toBe(409);
        expect(error?.code).toBe("23505");
      },
    },
    {
      name: "counts with head and a time window (rate limits)",
      async run() {
        await getDb()
          .from("community_events")
          .insert([
            { actor_key: "k", action: "save" },
            { actor_key: "k", action: "save" },
            { actor_key: "k", action: "other" },
          ]);
        const since = new Date(Date.now() - 60_000).toISOString();
        const { count, data } = await getDb()
          .from("community_events")
          .select("id", { count: "exact", head: true })
          .eq("actor_key", "k")
          .eq("action", "save")
          .gte("created_at", since);
        expect(count).toBe(2);
        expect(data).toBeNull();
      },
    },
    {
      name: "writes and reads library designs: jsonb, timestamps, update, tombstone filter (library routes)",
      async run() {
        const userId = await makeUser("carol");
        const plan = { schemaVersion: 1, nodes: [{ id: "n1", gtnhplanner: { v: 1 } }], ratio: 1.5 };
        const stamp = "2026-10-14T12:00:00.000Z";
        const inserted = await getDb()
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
        const read = await getDb()
          .from("library_designs")
          .select("id,plan")
          .eq("user_id", userId)
          .eq("id", "design-1")
          .maybeSingle();
        expect((read.data as { plan: unknown }).plan).toEqual(plan);
        const updated = await getDb()
          .from("library_designs")
          .update({ name: "Steel 2", favorite: true })
          .eq("user_id", userId)
          .eq("id", "design-1")
          .select("name,favorite")
          .single();
        expect(updated.data).toEqual({ name: "Steel 2", favorite: true });
        const { count } = await getDb()
          .from("library_designs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .is("deleted_at", null);
        expect(count).toBe(1);
      },
    },
    {
      name: "upserts on a named conflict target (library folders)",
      async run() {
        const userId = await makeUser("dave");
        const row = { user_id: userId, id: "folder-1", name: "Ores", deleted_at: null };
        await getDb().from("library_folders").upsert(row, { onConflict: "user_id,id" });
        const again = await getDb()
          .from("library_folders")
          .upsert({ ...row, name: "Ores 2" }, { onConflict: "user_id,id" })
          .select("id,name")
          .single();
        expect(again.data).toEqual({ id: "folder-1", name: "Ores 2" });
      },
    },
    {
      name: "searches, filters, orders with nulls last and pages with a total (community list)",
      async run() {
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
        const inserted = await getDb()
          .from("community_plans")
          .insert([
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
        const { data, count } = await getDb()
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
        const nullable = await getDb()
          .from("community_plans")
          .select("name")
          .or("is_public.eq.true,is_public.is.null")
          .order("name");
        expect((nullable.data as Array<{ name: string }>).map((row) => row.name)).toEqual([
          "Diesel power",
          "Oil cracking",
        ]);
      },
    },
    {
      name: "filters with in, deletes, and refuses unknown tables and columns",
      async run() {
        const userId = await makeUser("frank");
        const { data: plan } = await getDb()
          .from("community_plans")
          .insert({ uploader_key: "u", user_id: userId, name: "Votes", plan: {} })
          .select("id")
          .single();
        const planId = (plan as { id: string }).id;
        await getDb()
          .from("community_votes")
          .upsert({ plan_id: planId, voter_key: "v1", value: 1 });
        await getDb()
          .from("community_votes")
          .upsert({ plan_id: planId, voter_key: "v1", value: -1 });
        const votes = await getDb()
          .from("community_votes")
          .select("plan_id,value")
          .eq("voter_key", "v1")
          .in("plan_id", [planId]);
        expect(votes.data).toEqual([{ plan_id: planId, value: -1 }]);
        await getDb().from("community_votes").delete().eq("plan_id", planId).eq("voter_key", "v1");
        const { count } = await getDb()
          .from("community_votes")
          .select("plan_id", { count: "exact", head: true })
          .eq("plan_id", planId);
        expect(count).toBe(0);
        const table = await getDb().from("no_such_table").select("id");
        expect(table.error?.code).toBe("PGRST205");
        const column = await getDb().from("community_plans").select("no_such_column");
        expect(column.error?.code).toBe("42703");
        const insertColumn = await getDb()
          .from("community_events")
          .insert({ actor_key: "k", action: "a", nope: 1 });
        expect(insertColumn.error?.code).toBe("PGRST204");
      },
    },
  ];
}
