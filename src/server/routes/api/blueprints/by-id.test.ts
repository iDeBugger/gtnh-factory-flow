import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearDbFault, setupTestDb, withDbFault } from "@/test-support/test-db";
import { forgetSessionUsers, makeSessionToken } from "@/lib/server/auth/sessions";
import { json, resetDbBreaker } from "@/lib/server/db";
import * as blueprintsRepo from "@/lib/server/repos/blueprints";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import * as one from "./[blueprintId]/route";

/**
 * A blueprint by id against the test database: its owner's alone to read,
 * edit and delete, published or not and whatever the community switch says.
 */

const testDb = setupTestDb();
const users: Record<string, { id: string; cookie: string }> = {};

async function makeUser(username: string) {
  const { id } = await testDb()
    .db.insertInto("community_users")
    .values({ username, password_hash: "x:y" })
    .returning("id")
    .executeTakeFirstOrThrow();
  users[username] = { id, cookie: `gtnh_session=${makeSessionToken(id)}` };
}

let privateId: string;
let publicId: string;

async function makeBlueprint(name: string, isPublic: boolean): Promise<string> {
  const { id } = await testDb()
    .db.insertInto("blueprints")
    .values({ user_id: users.author!.id, name, payload: json({ nodes: [] }), is_public: isPublic })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
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

beforeAll(async () => {
  vi.stubEnv("COMMUNITY_HASH_SALT", "blueprint-by-id-test-salt");
  await makeUser("author");
  await makeUser("reader");
  privateId = await makeBlueprint("Private furnace", false);
  publicId = await makeBlueprint("Public furnace", true);
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  resetDbBreaker();
  forgetSessionUsers();
});

describe("reading a blueprint by id", () => {
  describe("with the setting on", () => {
    withModAndCommunityOn();

    it("lets nobody but the author read a blueprint, published or not", async () => {
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

  describe("with the setting unset", () => {
    withModAndCommunityUnset();

    it("lets nobody but the author read a blueprint, published or not, with the switch unset too", async () => {
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
    const spies = [blueprintsRepo].flatMap((module) =>
      Object.entries(module)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => vi.spyOn(module as Record<string, (...args: unknown[]) => unknown>, name)),
    );
    try {
      const id = "not-a-uuid";
      const base = `/api/blueprints/${id}`;
      const answers = [
        await one.GET(call("GET", base), params(id)),
        await one.GET(call("GET", base, { who: "author" }), params(id)),
        await one.PUT(call("PUT", base, { who: "author", body: { name: "Renamed" } }), params(id)),
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
      // The spies see the service's reads: a well-formed id is looked up for a signed-in reader, by its owner.
      const missing = randomUUID();
      const unseen = await one.GET(call("GET", `/api/blueprints/${missing}`, { who: "reader" }), params(missing));
      expect(unseen.status).toBe(404);
      expect(vi.mocked(blueprintsRepo.readOwn)).toHaveBeenCalledWith(missing, users.reader!.id);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

describe("a database failure on a blueprint", () => {
  withModAndCommunityOn();

  const DOWN = "The community database is not responding. Try again in a few minutes.";
  const refused = () => Object.assign(new Error("boom"), { code: "XX000", severity: "ERROR" });

  it("answers the route's sentence when a query is refused, and the down line when the database is down", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const [error, words] of [
        [refused(), undefined],
        [undefined, DOWN],
      ] as const) {
        withDbFault(/"blueprints"/, error);
        try {
          const read = await one.GET(call("GET", `/api/blueprints/${publicId}`, { who: "author" }), params(publicId));
          expect(read.status).toBe(500);
          expect(await read.json()).toEqual({ error: words ?? "Blueprint could not be loaded." });
          const renamed = await one.PUT(
            call("PUT", `/api/blueprints/${publicId}`, { who: "author", body: { name: "Renamed" } }),
            params(publicId),
          );
          expect(renamed.status).toBe(500);
          expect(await renamed.json()).toEqual({ error: words ?? "Blueprint could not be updated." });
        } finally {
          clearDbFault();
          resetDbBreaker();
        }
      }
      // A refused query is logged with the route's sentence.
      expect(errors).toHaveBeenCalledWith("Blueprint could not be loaded.", expect.objectContaining({ code: "XX000" }));
    } finally {
      errors.mockRestore();
    }
    // Nothing was renamed, and the blueprint reads again.
    expect(await readsBy(publicId)).toMatchObject({ author: [200, "Public furnace"] });
  });
});
