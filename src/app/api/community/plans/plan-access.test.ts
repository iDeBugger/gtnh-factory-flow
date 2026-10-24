import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { forgetSessionUsers, getCommunityDb, makeSessionToken, resetDbBreaker } from "@/lib/server/community";
import { planWithAdditions } from "@/lib/model/__fixtures__/plan-additions";
import { withModAndCommunityOn } from "@/test-support/mod-and-community";
import * as list from "./route";
import * as plan from "./[planId]/route";
import * as preview from "./[planId]/preview/route";
import * as vote from "./[planId]/vote/route";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Who may do what to a community post, against the local database: posting,
 * voting and the board photograph of a post that is not public.
 */

let local: LocalDatabase;
const users: Record<string, { id: string; cookie: string }> = {};
let addresses = 0;

/** A fresh client address per call: the per-address limits never meet across cases. */
const nextAddress = () => `10.2.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

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

function request(
  method: string,
  path: string,
  options: { who?: string; body?: unknown; address?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "x-client-ip": options.address ?? nextAddress(),
      ...(options.who ? { cookie: users[options.who]!.cookie } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });

/** The smallest post the route takes: a plan with cards. */
function postBody(deviceId: string) {
  return {
    name: "Biodiesel",
    description: "",
    gameVersion: "2.9",
    datasetVersionId: "",
    deviceId,
    plan: planWithAdditions(),
  };
}

/** A post of the owner's, public or not, with a plan nothing here reads. */
async function makePlan(name: string, isPublic: boolean): Promise<string> {
  const { data, error } = await getCommunityDb()
    .from("community_plans")
    .insert({
      user_id: users.owner!.id,
      author_name: "owner",
      name,
      plan: { nodes: [] },
      is_public: isPublic,
      uploader_key: "test",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

async function planRow(planId: string): Promise<{ upvotes: number; downvotes: number; views: number }> {
  const { data } = await getCommunityDb()
    .from("community_plans")
    .select("upvotes,downvotes,views")
    .eq("id", planId)
    .single();
  return data as { upvotes: number; downvotes: number; views: number };
}

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "plan-access-test-salt");
  local = await openLocalDatabase();
  useInProcessLocalDb(local.handle);
  for (const name of ["owner", "stranger", "poster"]) {
    await makeUser(name);
  }
}, 60_000);

afterAll(async () => {
  useInProcessLocalDb(undefined);
  await local?.close();
  vi.unstubAllEnvs();
  resetDbBreaker();
  forgetSessionUsers();
});

describe("voting on a post", () => {
  withModAndCommunityOn();

  const castVote = (planId: string, body: unknown, options: { who?: string; address?: string } = {}) =>
    vote.POST(request("POST", `/api/community/plans/${planId}/vote`, { body, ...options }), params({ planId }));

  it("refuses a stranger's vote on an unpublished plan, as for a plan that does not exist", async () => {
    const planId = await makePlan("Private", false);
    const anonymous = await castVote(planId, { deviceId: "device-1", value: -1 });
    expect(anonymous.status).toBe(404);
    expect(await anonymous.json()).toEqual({ error: "Plan not found." });
    const signedIn = await castVote(planId, { deviceId: "device-1", value: -1 }, { who: "stranger" });
    expect(signedIn.status).toBe(404);
    expect((await planRow(planId)).downvotes).toBe(0);

    const missing = await castVote(randomUUID(), { deviceId: "device-1", value: 1 });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Plan not found." });
  });

  it("lets the owner vote on their own unpublished post, and anyone once it is public", async () => {
    const planId = await makePlan("Mine", false);
    const owner = await castVote(planId, { deviceId: "device-owner", value: 1 }, { who: "owner" });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ upvotes: 1, downvotes: 0, myVote: 1 });

    await getCommunityDb().from("community_plans").update({ is_public: true }).eq("id", planId);
    const anyone = await castVote(planId, { deviceId: "device-2", value: -1 });
    expect(anyone.status).toBe(200);
    expect(await anyone.json()).toMatchObject({ upvotes: 1, downvotes: 1, score: 0, myVote: -1 });
  });

  it("gives one address three anonymous votes a day on one post, whatever device ids it sends", async () => {
    const planId = await makePlan("Popular", true);
    const address = "203.0.113.77";
    for (let i = 0; i < 3; i++) {
      const cast = await castVote(planId, { deviceId: `made-up-${i}`, value: 1 }, { address });
      expect(cast.status, `vote ${i + 1}`).toBe(200);
    }
    const fourth = await castVote(planId, { deviceId: "made-up-3", value: 1 }, { address });
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ error: "Voting too fast. Slow down." });
    expect((await planRow(planId)).upvotes).toBe(3);
    // Another address, and a signed-in account behind the same address, still vote.
    expect((await castVote(planId, { deviceId: "made-up-4", value: 1 }, { address: "203.0.113.78" })).status).toBe(200);
    expect((await castVote(planId, { deviceId: "x", value: 1 }, { address, who: "stranger" })).status).toBe(200);
    expect((await planRow(planId)).upvotes).toBe(5);
  });
});

describe("a post's board photograph", () => {
  withModAndCommunityOn();

  const getPreview = (planId: string, who?: string) =>
    preview.GET(request("GET", `/api/community/plans/${planId}/preview`, { who }), params({ planId }));

  it("shows an unpublished post's picture to its owner only, and to anyone once the post is public", async () => {
    const planId = await makePlan("Photographed", false);
    const form = new FormData();
    form.set("image", new Blob([PNG as BlobPart], { type: "image/png" }), "board.png");
    const stored = await preview.POST(
      new Request(`http://localhost/api/community/plans/${planId}/preview`, {
        method: "POST",
        headers: { "x-client-ip": nextAddress(), cookie: users.owner!.cookie },
        body: form,
      }),
      params({ planId }),
    );
    expect(stored.status).toBe(200);

    const anonymous = await getPreview(planId);
    expect(anonymous.status).toBe(404);
    expect(await anonymous.json()).toEqual({ error: "No preview." });
    expect((await getPreview(planId, "stranger")).status).toBe(404);
    const owner = await getPreview(planId, "owner");
    expect(owner.status).toBe(200);
    expect(owner.headers.get("content-type")).toBe("image/png");
    expect(owner.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await owner.arrayBuffer()).equals(PNG)).toBe(true);

    const published = await plan.PUT(
      request("PUT", `/api/community/plans/${planId}`, { who: "owner", body: { isPublic: true } }),
      params({ planId }),
    );
    expect(published.status).toBe(200);
    const anyone = await getPreview(planId);
    expect(anyone.status).toBe(200);
    expect(anyone.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("creates the preview bucket private", async () => {
    const { rows } = await local.db.query<{ public: boolean }>(
      "select public from local_storage.buckets where id = 'plan-previews'",
    );
    expect(rows).toEqual([{ public: false }]);
  });
});

describe("posting to the community", () => {
  withModAndCommunityOn();

  it("holds one account to ten posts an hour whatever device id it sends", async () => {
    for (let i = 0; i < 10; i++) {
      const response = await list.POST(
        request("POST", "/api/community/plans", { who: "poster", body: postBody(`device-${i}`) }),
      );
      expect(response.status, `post ${i + 1}`).toBe(201);
    }
    const refused = await list.POST(
      request("POST", "/api/community/plans", { who: "poster", body: postBody("device-fresh") }),
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Upload rate limit reached. Try again later." });
  }, 120_000);
});
