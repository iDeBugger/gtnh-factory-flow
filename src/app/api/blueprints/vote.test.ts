import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { forgetSessionUsers, makeSessionToken } from "@/lib/server/auth/sessions";
import { getCommunityDb, resetDbBreaker } from "@/lib/server/db";
import { withModAndCommunityOn } from "@/test-support/mod-and-community";
import * as vote from "./[blueprintId]/vote/route";

/**
 * Blueprint votes against the local database: an anonymous address gets a
 * few casts a day on one blueprint whatever device ids it sends, as plan
 * votes do; accounts and other addresses are not held by it.
 */

let local: LocalDatabase;
const users: Record<string, { id: string; cookie: string }> = {};

async function makeUser(username: string) {
  const { data, error } = await getCommunityDb()
    .from("community_users")
    .insert({ username, password_hash: "x:y" })
    .select("id")
    .single();
  expect(error).toBeNull();
  const id = (data as { id: string }).id;
  users[username] = { id, cookie: `gtnh_session=${makeSessionToken(id)}` };
}

function castVote(blueprintId: string, body: unknown, options: { who?: string; address: string }) {
  return vote.POST(
    new Request(`http://localhost/api/blueprints/${blueprintId}/vote`, {
      method: "POST",
      headers: {
        "x-client-ip": options.address,
        "content-type": "application/json",
        ...(options.who ? { cookie: users[options.who]!.cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ blueprintId }) },
  );
}

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "blueprint-vote-test-salt");
  local = await openLocalDatabase();
  useInProcessLocalDb(local.handle);
  await makeUser("author");
  await makeUser("reader");
}, 60_000);

afterAll(async () => {
  useInProcessLocalDb(undefined);
  await local?.close();
  vi.unstubAllEnvs();
  resetDbBreaker();
  forgetSessionUsers();
});

describe("voting on a blueprint", () => {
  withModAndCommunityOn();

  it("gives one address three anonymous votes a day on one blueprint, whatever device ids it sends", async () => {
    const { data, error } = await getCommunityDb()
      .from("blueprints")
      .insert({ user_id: users.author!.id, name: "Coke ovens", payload: { nodes: [] }, is_public: true })
      .select("id")
      .single();
    expect(error).toBeNull();
    const blueprintId = (data as { id: string }).id;
    const address = "203.0.113.90";
    for (let i = 0; i < 3; i++) {
      const cast = await castVote(blueprintId, { deviceId: `made-up-${i}`, value: 1 }, { address });
      expect(cast.status, `vote ${i + 1}`).toBe(200);
    }
    const fourth = await castVote(blueprintId, { deviceId: "made-up-3", value: 1 }, { address });
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ error: "Too many votes from this network today. Sign in to vote." });
    // A retraction is free; another address and a signed-in account behind the same one still vote.
    expect((await castVote(blueprintId, { deviceId: "made-up-0", value: 1 }, { address })).status).toBe(200);
    expect((await castVote(blueprintId, { deviceId: "made-up-4", value: 1 }, { address: "203.0.113.91" })).status).toBe(200);
    const signedIn = await castVote(blueprintId, { deviceId: "x", value: 1 }, { address, who: "reader" });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toMatchObject({ upvotes: 4 });
  });
});
