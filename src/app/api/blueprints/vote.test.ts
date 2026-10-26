import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { forgetSessionUsers, makeSessionToken } from "@/lib/server/auth/sessions";
import { getCommunityDb, resetDbBreaker } from "@/lib/server/db";
import * as blueprintsRepo from "@/lib/server/repos/blueprints";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import * as one from "./[blueprintId]/route";
import * as download from "./[blueprintId]/download/route";
import * as publish from "./[blueprintId]/publish/route";
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

let privateId: string;
let publicId: string;

async function makeBlueprint(name: string, isPublic: boolean): Promise<string> {
  const { data, error } = await getCommunityDb()
    .from("blueprints")
    .insert({ user_id: users.author!.id, name, payload: { nodes: [] }, is_public: isPublic })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

function call(method: string, url: string, options: { who?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      "x-client-ip": "203.0.113.50",
      "content-type": "application/json",
      ...(options.who ? { cookie: users[options.who]!.cookie } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const params = (blueprintId: string) => ({ params: Promise.resolve({ blueprintId }) });

/** Each viewer's answer to GET /api/blueprints/<id>: the status and the blueprint's name, if any. */
async function readsBy(blueprintId: string) {
  const answers: Record<string, [number, string | undefined]> = {};
  for (const who of ["author", "reader", undefined]) {
    const answer = await one.GET(call("GET", `/api/blueprints/${blueprintId}`, { who }), params(blueprintId));
    const body = (await answer.json()) as { blueprint?: { name: string }; error?: string };
    answers[who ?? "anonymous"] = [answer.status, body.blueprint?.name ?? body.error];
  }
  return answers;
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
  privateId = await makeBlueprint("Private furnace", false);
  publicId = await makeBlueprint("Public furnace", true);
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

describe("reading a blueprint by id", () => {
  describe("with the setting on", () => {
    withModAndCommunityOn();

    it("lets a stranger read a public blueprint but never a private one", async () => {
      expect(await readsBy(privateId)).toEqual({
        author: [200, "Private furnace"],
        reader: [404, "Blueprint not found."],
        anonymous: [404, "Blueprint not found."],
      });
      expect(await readsBy(publicId)).toEqual({
        author: [200, "Public furnace"],
        reader: [200, "Public furnace"],
        anonymous: [200, "Public furnace"],
      });
      const placed = await download.POST(call("POST", `/api/blueprints/${privateId}/download`, { who: "reader" }), params(privateId));
      expect(placed.status).toBe(404);
      expect(await placed.json()).toEqual({ error: "Blueprint not found." });
    });
  });

  describe("with the setting unset", () => {
    withModAndCommunityUnset();

    it("lets nobody but the author read a blueprint, public or not", async () => {
      for (const [id, name] of [
        [privateId, "Private furnace"],
        [publicId, "Public furnace"],
      ] as const) {
        expect(await readsBy(id)).toEqual({
          author: [200, name],
          reader: [404, "Blueprint not found."],
          anonymous: [404, "Blueprint not found."],
        });
      }
    });
  });
});

describe("a malformed blueprint id", () => {
  withModAndCommunityOn();

  it("is not found, not an error, and sends no blueprint query", async () => {
    const spies = Object.entries(blueprintsRepo)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => vi.spyOn(blueprintsRepo as Record<string, (...args: unknown[]) => unknown>, name));
    try {
      const id = "not-a-uuid";
      const base = `/api/blueprints/${id}`;
      const answers = [
        await one.GET(call("GET", base), params(id)),
        await one.GET(call("GET", base, { who: "author" }), params(id)),
        await one.PUT(call("PUT", base, { who: "author", body: { name: "Renamed" } }), params(id)),
        await publish.POST(call("POST", `${base}/publish`, { who: "author", body: { publish: true } }), params(id)),
        await download.POST(call("POST", `${base}/download`, { who: "reader" }), params(id)),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(404);
        expect(await answer.json()).toEqual({ error: "Blueprint not found." });
      }
      // Deleting it deletes nothing, as for any blueprint that is not there.
      const gone = await one.DELETE(call("DELETE", base, { who: "author" }), params(id));
      expect(gone.status).toBe(200);
      expect(await gone.json()).toEqual({ ok: true });
      for (const spy of spies) {
        expect(spy, spy.getMockName()).not.toHaveBeenCalled();
      }
      // The spies see the service's reads: a well-formed id is looked up.
      const missing = randomUUID();
      const unseen = await one.GET(call("GET", `/api/blueprints/${missing}`), params(missing));
      expect(unseen.status).toBe(404);
      expect(vi.mocked(blueprintsRepo.readReadable)).toHaveBeenCalledWith(missing, expect.anything(), true);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
