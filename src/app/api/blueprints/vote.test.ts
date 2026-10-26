import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearDbFault, useTestDb, withDbFault } from "@/test-support/test-db";
import { setDbFaultForTests } from "@/lib/server/db/guard";
import { forgetSessionUsers, makeSessionToken } from "@/lib/server/auth/sessions";
import { getCommunityDb, resetDbBreaker } from "@/lib/server/db";
import * as blueprintsRepo from "@/lib/server/repos/blueprints";
import * as votesRepo from "@/lib/server/repos/votes";
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

const testDb = useTestDb();
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
  vi.stubEnv("COMMUNITY_HASH_SALT", "blueprint-vote-test-salt");
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

  /** The blueprint's counters beside a count of its vote rows. */
  const tally = async (blueprintId: string) => {
    const db = testDb().db;
    const row = await db
      .selectFrom("blueprints")
      .select(["upvotes", "downvotes"])
      .where("id", "=", blueprintId)
      .executeTakeFirstOrThrow();
    const rows = await db
      .selectFrom("blueprint_votes")
      .select("value")
      .where("blueprint_id", "=", blueprintId)
      .execute();
    return {
      ...row,
      rowsUp: rows.filter((vote) => vote.value === 1).length,
      rowsDown: rows.filter((vote) => vote.value === -1).length,
    };
  };

  it("ten votes at once from ten addresses land ten", async () => {
    const blueprintId = await makeBlueprint("Rushed furnace", true);
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        castVote(blueprintId, { deviceId: `rush-${i}`, value: 1 }, { address: `198.51.100.${i + 1}` }),
      ),
    );
    expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(200));
    expect(await tally(blueprintId)).toEqual({ upvotes: 10, downvotes: 0, rowsUp: 10, rowsDown: 0 });
  });

  it("a vote and its count move together", async () => {
    const blueprintId = await makeBlueprint("Counted furnace", true);
    const address = "198.51.100.50";
    expect((await castVote(blueprintId, { deviceId: "kept", value: 1 }, { address })).status).toBe(200);
    for (const value of [1, -1]) {
      withDbFault(/update "blueprints"/, Object.assign(new Error("boom"), { code: "XX000", severity: "ERROR" }));
      try {
        const failed = await castVote(blueprintId, { deviceId: value === 1 ? "kept" : "lost", value }, { address });
        expect(failed.status).toBe(500);
        expect(await failed.json()).toEqual({ error: "Voting failed." });
      } finally {
        clearDbFault();
        resetDbBreaker();
      }
    }
    expect(await tally(blueprintId)).toEqual({ upvotes: 1, downvotes: 0, rowsUp: 1, rowsDown: 0 });
  });

  it("writes a vote and its blueprint's counts under the blueprint's lock", async () => {
    const blueprintId = await makeBlueprint("Locked furnace", true);
    const LOCK = /^select "id" from "blueprints" where "id" = \$1 for no key update$/;
    const RECOUNT =
      /^update "blueprints" set "upvotes" = \(select count\(\*\) as "n" from "blueprint_votes" where "blueprint_id" = \$1 and "value" = \$2\), "downvotes" = \(select count\(\*\) as "n" from "blueprint_votes" where "blueprint_id" = \$3 and "value" = \$4\) where "id" = \$5 returning "upvotes", "downvotes"$/;
    for (const [step, write] of [
      ["cast", /^insert into "blueprint_votes" .* on conflict \("blueprint_id", "voter_key"\) do update set "value" = \$\d+$/],
      ["retract", /^delete from "blueprint_votes" where "blueprint_id" = \$1 and "voter_key" = \$2$/],
    ] as const) {
      const sent: string[] = [];
      setDbFaultForTests((text) => {
        sent.push(text);
        return undefined;
      });
      try {
        const answer = await castVote(blueprintId, { deviceId: "locker", value: 1 }, { address: "198.51.100.60", who: "reader" });
        expect(answer.status, step).toBe(200);
      } finally {
        clearDbFault();
      }
      const lock = sent.findIndex((text) => LOCK.test(text));
      const written = sent.findIndex((text, i) => i > lock && write.test(text));
      const recount = sent.findIndex((text, i) => i > written && RECOUNT.test(text));
      expect([lock, written, recount].every((index) => index >= 0), `${step}:\n${sent.join("\n")}`).toBe(true);
      expect(sent.filter((text) => LOCK.test(text)), step).toHaveLength(1);
    }
    expect(await tally(blueprintId)).toEqual({ upvotes: 0, downvotes: 0, rowsUp: 0, rowsDown: 0 });
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

  it("is not found, not an error, and sends no blueprint or vote query", async () => {
    const spies = [blueprintsRepo, votesRepo].flatMap((module) =>
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
        await publish.POST(call("POST", `${base}/publish`, { who: "author", body: { publish: true } }), params(id)),
        await download.POST(call("POST", `${base}/download`, { who: "reader" }), params(id)),
        await castVote(id, { deviceId: "device-1", value: 1 }, { address: "203.0.113.92" }),
        await castVote(id, { deviceId: "device-1", value: 1 }, { address: "203.0.113.92", who: "reader" }),
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

describe("downloading a blueprint", () => {
  withModAndCommunityOn();

  const placeAs = async (blueprintId: string, who?: string) => {
    const answer = await download.POST(call("POST", `/api/blueprints/${blueprintId}/download`, { who }), params(blueprintId));
    const body = (await answer.json()) as { blueprint?: { downloads: number; payload: unknown }; error?: string };
    return { status: answer.status, downloads: body.blueprint?.downloads, error: body.error };
  };
  const stored = async (blueprintId: string) =>
    (
      await testDb()
        .db.selectFrom("blueprints")
        .select("downloads")
        .where("id", "=", blueprintId)
        .executeTakeFirstOrThrow()
    ).downloads;

  it("counts a reader's and an anonymous download, never the author's own", async () => {
    const blueprintId = await makeBlueprint("Placed furnace", true);
    expect(await placeAs(blueprintId, "author")).toEqual({ status: 200, downloads: 0, error: undefined });
    expect(await stored(blueprintId)).toBe(0);
    expect(await placeAs(blueprintId, "reader")).toEqual({ status: 200, downloads: 1, error: undefined });
    expect(await placeAs(blueprintId)).toEqual({ status: 200, downloads: 2, error: undefined });
    expect(await placeAs(blueprintId, "author")).toEqual({ status: 200, downloads: 2, error: undefined });
    expect(await stored(blueprintId)).toBe(2);
  });

  it("hands out only a public blueprint, its author's unpublished one included", async () => {
    expect(await placeAs(privateId, "author")).toEqual({ status: 404, downloads: undefined, error: "Blueprint not found." });
    const missing = randomUUID();
    expect(await placeAs(missing, "reader")).toEqual({ status: 404, downloads: undefined, error: "Blueprint not found." });
  });

  it("ten downloads at once count ten", async () => {
    const blueprintId = await makeBlueprint("Popular furnace", true);
    const answers = await Promise.all(Array.from({ length: 10 }, () => placeAs(blueprintId)));
    expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(200));
    expect(answers.map((answer) => answer.downloads).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    expect(await stored(blueprintId)).toBe(10);
  });

  it("counts in one statement that carries the public rule and spares the author", async () => {
    const blueprintId = await makeBlueprint("Recorded furnace", true);
    const COUNT = {
      signedIn:
        /^update "blueprints" set "downloads" = case when "user_id" = \$1 then "downloads" else "downloads" \+ \$2 end where \("id" = \$3 and "blueprints"\."is_public" = \$4\) returning "id", .*, "payload"$/,
      anonymous:
        /^update "blueprints" set "downloads" = "downloads" \+ \$1 where \("id" = \$2 and "blueprints"\."is_public" = \$3\) returning "id", .*, "payload"$/,
    };
    for (const [who, pattern] of [
      ["reader", COUNT.signedIn],
      [undefined, COUNT.anonymous],
    ] as const) {
      const sent: Array<{ text: string; parameters: readonly unknown[] }> = [];
      setDbFaultForTests((text, parameters) => {
        sent.push({ text, parameters });
        return undefined;
      });
      try {
        expect((await placeAs(blueprintId, who)).status).toBe(200);
      } finally {
        clearDbFault();
      }
      const touching = sent.filter(({ text }) => text.includes('"blueprints"'));
      expect(touching.map(({ text }) => text), who ?? "anonymous").toHaveLength(1);
      expect(touching[0]!.text).toMatch(pattern);
      expect(touching[0]!.parameters).toEqual(
        who ? [users.reader!.id, 1, blueprintId, true] : [1, blueprintId, true],
      );
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
          const read = await one.GET(call("GET", `/api/blueprints/${publicId}`, { who: "reader" }), params(publicId));
          expect(read.status).toBe(500);
          expect(await read.json()).toEqual({ error: words ?? "Blueprint could not be loaded." });
          const placed = await download.POST(call("POST", `/api/blueprints/${publicId}/download`), params(publicId));
          expect(placed.status).toBe(500);
          expect(await placed.json()).toEqual({ error: words ?? "Blueprint could not be loaded." });
          expect(placed.headers.get("cache-control")).toBe("no-store");
          const renamed = await one.PUT(
            call("PUT", `/api/blueprints/${publicId}`, { who: "author", body: { name: "Renamed" } }),
            params(publicId),
          );
          expect(renamed.status).toBe(500);
          expect(await renamed.json()).toEqual({ error: words ?? "Blueprint could not be updated." });
          const voted = await castVote(publicId, { deviceId: "failing", value: 1 }, { address: "198.51.100.70" });
          expect(voted.status).toBe(500);
          expect(await voted.json()).toEqual({ error: "Voting failed." });
          expect(voted.headers.get("cache-control")).toBe("no-store");
        } finally {
          clearDbFault();
          resetDbBreaker();
        }
      }
      // A refused query is logged with the route's sentence; the vote's access read is logged by its route.
      expect(errors).toHaveBeenCalledWith("Blueprint could not be loaded.", expect.objectContaining({ code: "XX000" }));
      expect(errors).toHaveBeenCalledWith("blueprint vote failed", expect.objectContaining({ code: "XX000" }));
    } finally {
      errors.mockRestore();
    }
    // Nothing was counted or renamed, and the blueprint reads again.
    expect(await readsBy(publicId)).toMatchObject({ reader: [200, "Public furnace"] });
  });
});
