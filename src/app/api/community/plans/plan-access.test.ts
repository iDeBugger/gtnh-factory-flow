import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { forgetSessionUsers, getCommunityDb, makeSessionToken, resetDbBreaker } from "@/lib/server/community";
import { planWithAdditions } from "@/lib/model/__fixtures__/plan-additions";
import { withModAndCommunityOn } from "@/test-support/mod-and-community";
import * as list from "./route";

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
