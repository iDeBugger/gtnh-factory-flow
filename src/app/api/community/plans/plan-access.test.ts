import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FactoryProject } from "@/lib/model/types";
import { takeLpCount } from "@/lib/solver/plan/lp";
import { APP_VERSION } from "@/lib/version";
import { clearDbFault, useTestDb, withDbFault } from "@/test-support/test-db";
import { setDbFaultForTests } from "@/lib/server/db/guard";
import { forgetSessionUsers, makeSessionToken } from "@/lib/server/auth/sessions";
import { json, resetDbBreaker } from "@/lib/server/db";
import { planWithAdditions } from "@/lib/model/__fixtures__/plan-additions";
import { withModAndCommunityOn } from "@/test-support/mod-and-community";
import { pngHeader } from "@/test-support/png";
import { oversizeRequest } from "@/test-support/request-bodies";
import { islandCache } from "@/lib/solver/plan/adapter/engine";
import * as list from "./route";
import * as plan from "./[planId]/route";
import * as preview from "./[planId]/preview/route";
import * as view from "./[planId]/view/route";
import * as vote from "./[planId]/vote/route";
import * as comments from "./[planId]/comments/route";
import * as download from "./[planId]/download/route";
import * as plansRepo from "@/lib/server/repos/plans";
import * as commentsRepo from "@/lib/server/repos/comments";
import * as eventsRepo from "@/lib/server/repos/events";
import * as votesRepo from "@/lib/server/repos/votes";
import * as comment from "./[planId]/comments/[commentId]/route";
import { invalidatePlanListCache } from "@/lib/server/plan-list-cache";
import { getFileStore } from "@/lib/server/file-store";
import * as images from "../images/[month]/[name]/route";

/** The server's time budget for an uploaded plan's stats solve, set per case. */
const statsBudget = vi.hoisted(() => ({ ms: 5_000 }));
// The real solvePlanStats and ensurePlanEngine, with the budget set per case.
vi.mock("@/lib/server/plan-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/plan-engine")>();
  return {
    ...actual,
    solvePlanStats: (project: FactoryProject) => actual.solvePlanStats(project, statsBudget.ms),
  };
});

/**
 * Every key the file store is asked to remove, as asked: a case-insensitive
 * disk (a Mac's) would remove an upper-case key's file too, so the files
 * alone cannot show which spelling was used.
 */
const removedKeys = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/server/file-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/file-store")>();
  return {
    ...actual,
    getFileStore: () => {
      const store = actual.getFileStore();
      return {
        ...store,
        remove: (bucket: Parameters<typeof store.remove>[0], keys: string[]) => {
          removedKeys.push(...keys);
          return store.remove(bucket, keys);
        },
      };
    },
  };
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Who may do what to a community post, against the local database: posting,
 * voting and the board photograph of a post that is not public.
 */

const testDb = useTestDb();
let files: string;
const users: Record<string, { id: string; cookie: string }> = {};
let addresses = 0;

/** A fresh client address per call: the per-address limits never meet across cases. */
const nextAddress = () => `10.2.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

async function makeUser(username: string) {
  const { id } = await testDb()
    .db.insertInto("community_users")
    .values({ username, password_hash: "x:y" })
    .returning("id")
    .executeTakeFirstOrThrow();
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

/** A query the database refused (not an outage): what a route answers as its own sentence at 500. */
const refused = () => Object.assign(new Error("boom"), { code: "XX000", severity: "ERROR" });

/** Every statement the direct client sends from here on, in order, as compiled. */
function recordSql(): string[] {
  const sent: string[] = [];
  setDbFaultForTests((text) => {
    sent.push(text);
    return undefined;
  });
  return sent;
}

/** The index of the first statement from `from` on that matches `pattern`. */
function at(sent: string[], pattern: RegExp, from = 0): number {
  const index = sent.findIndex((text, i) => i >= from && pattern.test(text));
  expect(index, `${pattern} in\n${sent.join("\n")}`).toBeGreaterThanOrEqual(0);
  return index;
}

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
  const { id } = await testDb()
    .db.insertInto("community_plans")
    .values({
      user_id: users.owner!.id,
      author_name: "owner",
      name,
      plan: json({ nodes: [] }),
      is_public: isPublic,
      uploader_key: "test",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

async function planRow(planId: string): Promise<{ upvotes: number; downvotes: number; views: number }> {
  return testDb()
    .db.selectFrom("community_plans")
    .select(["upvotes", "downvotes", "views"])
    .where("id", "=", planId)
    .executeTakeFirstOrThrow();
}

beforeAll(async () => {
  vi.stubEnv("COMMUNITY_HASH_SALT", "plan-access-test-salt");
  files = mkdtempSync(path.join(tmpdir(), "plan-access-"));
  vi.stubEnv("FILE_STORE_DIR", files);
  for (const name of ["owner", "stranger", "poster"]) {
    await makeUser(name);
  }
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  resetDbBreaker();
  forgetSessionUsers();
  rmSync(files, { recursive: true, force: true });
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

  it("a vote on a post taken down after its access read is not found, and leaves no vote", async () => {
    const planId = randomUUID();
    // The access read still saw the post; it is gone by the time the vote locks it.
    const seen = vi
      .spyOn(plansRepo, "readAccess")
      .mockResolvedValueOnce({ id: planId, user_id: users.owner!.id, is_public: true });
    try {
      const late = await castVote(planId, { deviceId: "device-late", value: 1 }, { who: "stranger" });
      expect(late.status).toBe(404);
      expect(await late.json()).toEqual({ error: "Plan not found." });
      expect(seen).toHaveBeenCalledWith(planId);
    } finally {
      seen.mockRestore();
    }
    const rows = await testDb().db.selectFrom("community_votes").select("voter_key").where("plan_id", "=", planId).execute();
    expect(rows).toEqual([]);
  });

  it("logs a failed access read and answers the fixed sentence", async () => {
    const planId = await makePlan("Unreadable", true);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      withDbFault(/^select "id", "user_id", "is_public" from "community_plans"/, refused());
      const failed = await castVote(planId, { deviceId: "device-fail", value: 1 }, { who: "stranger" });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "Voting failed." });
      expect(failed.headers.get("cache-control")).toBe("no-store");
      expect(errors).toHaveBeenCalledWith("vote failed", expect.objectContaining({ code: "XX000" }));
    } finally {
      clearDbFault();
      errors.mockRestore();
    }
    expect((await planRow(planId)).upvotes).toBe(0);
  });

  it("lets the owner vote on their own unpublished post, and anyone once it is public", async () => {
    const planId = await makePlan("Mine", false);
    const owner = await castVote(planId, { deviceId: "device-owner", value: 1 }, { who: "owner" });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ upvotes: 1, downvotes: 0, myVote: 1 });

    await testDb().db.updateTable("community_plans").set({ is_public: true }).where("id", "=", planId).execute();
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
    expect(await fourth.json()).toEqual({ error: "Too many votes from this network today. Sign in to vote." });
    expect((await planRow(planId)).upvotes).toBe(3);
    // Another address, and a signed-in account behind the same address, still vote.
    expect((await castVote(planId, { deviceId: "made-up-4", value: 1 }, { address: "203.0.113.78" })).status).toBe(200);
    expect((await castVote(planId, { deviceId: "x", value: 1 }, { address, who: "stranger" })).status).toBe(200);
    expect((await planRow(planId)).upvotes).toBe(5);
  });

  /** The post's counters beside a count of its vote rows. */
  const tally = async (planId: string) => {
    const db = testDb().db;
    const row = await db
      .selectFrom("community_plans")
      .select(["upvotes", "downvotes"])
      .where("id", "=", planId)
      .executeTakeFirstOrThrow();
    const rows = await db.selectFrom("community_votes").select("value").where("plan_id", "=", planId).execute();
    return {
      ...row,
      rowsUp: rows.filter((vote) => vote.value === 1).length,
      rowsDown: rows.filter((vote) => vote.value === -1).length,
    };
  };

  it("ten votes at once from ten addresses land ten", async () => {
    const planId = await makePlan("Rushed", true);
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => castVote(planId, { deviceId: `rush-${i}`, value: 1 })),
    );
    expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(200));
    expect(await tally(planId)).toEqual({ upvotes: 10, downvotes: 0, rowsUp: 10, rowsDown: 0 });
  });

  it("a vote and its count move together", async () => {
    const planId = await makePlan("Counted votes", true);
    expect((await castVote(planId, { deviceId: "kept", value: 1 })).status).toBe(200);
    for (const value of [1, -1]) {
      withDbFault(/update "community_plans"/, refused());
      try {
        const failed = await castVote(planId, { deviceId: value === 1 ? "kept" : "lost", value });
        expect(failed.status).toBe(500);
        expect(await failed.json()).toEqual({ error: "Voting failed." });
      } finally {
        clearDbFault();
        resetDbBreaker();
      }
    }
    // Neither the retraction nor the new vote stands without its count.
    expect(await tally(planId)).toEqual({ upvotes: 1, downvotes: 0, rowsUp: 1, rowsDown: 0 });
  });

  it("takes two identical clicks at once as a toggle: cast then retract, retract then cast", async () => {
    const planId = await makePlan("Double clicked", true);
    const click = () => castVote(planId, { deviceId: "double", value: 1 }, { who: "stranger" });
    const [first, second] = await Promise.all([click(), click()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await tally(planId)).toEqual({ upvotes: 0, downvotes: 0, rowsUp: 0, rowsDown: 0 });
    const myVotes = [(await first.json()).myVote, (await second.json()).myVote];
    expect(myVotes.sort()).toEqual([1, undefined]);

    expect((await click()).status).toBe(200);
    const [third, fourth] = await Promise.all([click(), click()]);
    expect([third.status, fourth.status]).toEqual([200, 200]);
    expect(await tally(planId)).toEqual({ upvotes: 1, downvotes: 0, rowsUp: 1, rowsDown: 0 });
  });

  it("writes a vote and its post's counts under the post's lock", async () => {
    const planId = await makePlan("Locked votes", true);
    const LOCK = /^select "id" from "community_plans" where "id" = \$1 for no key update$/;
    const RECOUNT =
      /^update "community_plans" set "upvotes" = \(select count\(\*\) as "n" from "community_votes" where "plan_id" = \$1 and "value" = \$2\), "downvotes" = \(select count\(\*\) as "n" from "community_votes" where "plan_id" = \$3 and "value" = \$4\) where "id" = \$5 returning "upvotes", "downvotes"$/;
    for (const [step, write] of [
      ["cast", /^insert into "community_votes" .* on conflict \("plan_id", "voter_key"\) do update set "value" = \$\d+$/],
      ["retract", /^delete from "community_votes" where "plan_id" = \$1 and "voter_key" = \$2$/],
    ] as const) {
      const sent = recordSql();
      try {
        const answer = await castVote(planId, { deviceId: "locker", value: 1 }, { who: "stranger" });
        expect(answer.status, step).toBe(200);
      } finally {
        clearDbFault();
      }
      const lock = at(sent, LOCK);
      const written = at(sent, write, lock);
      at(sent, RECOUNT, written);
      expect(sent.filter((text) => LOCK.test(text)), step).toHaveLength(1);
    }
    expect(await tally(planId)).toEqual({ upvotes: 0, downvotes: 0, rowsUp: 0, rowsDown: 0 });
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

  const postPreview = (planId: string, bytes: Uint8Array, who: string) => {
    const form = new FormData();
    form.set("image", new Blob([bytes as BlobPart], { type: "image/png" }), "board.png");
    return preview.POST(
      new Request(`http://localhost/api/community/plans/${planId}/preview`, {
        method: "POST",
        headers: { "x-client-ip": nextAddress(), cookie: users[who]!.cookie },
        body: form,
      }),
      params({ planId }),
    );
  };

  it("refuses a PNG whose header claims 60000 by 60000 pixels, and stores a 1600 by 1000 one", async () => {
    const planId = await makePlan("Oversized", false);
    const refused = await postPreview(planId, pngHeader(60000, 60000), "owner");
    expect(refused.status).toBe(415);
    expect(await refused.json()).toEqual({
      error: "The preview must be a PNG of at most 4096 by 4096 pixels.",
    });
    expect((await getPreview(planId, "owner")).status).toBe(404);
    expect((await postPreview(planId, pngHeader(100, 100, "IDAT"), "owner")).status).toBe(415);
    expect((await getPreview(planId, "owner")).status).toBe(404);

    const stored = await postPreview(planId, pngHeader(1600, 1000), "owner");
    expect(stored.status).toBe(200);
    const read = await getPreview(planId, "owner");
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer()).equals(pngHeader(1600, 1000))).toBe(true);
  });

  it("gives an account thirty preview uploads an hour, and stores nothing for the next", async () => {
    await makeUser("photographer");
    const { id: planId } = await testDb()
      .db.insertInto("community_plans")
      .values({
        user_id: users.photographer!.id,
        author_name: "photographer",
        name: "Reshared",
        plan: json({ nodes: [] }),
        is_public: true,
        uploader_key: "test",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (let i = 0; i < 30; i++) {
      const stored = await postPreview(planId, pngHeader(10 + i, 10), "photographer");
      expect(stored.status, `upload ${i + 1}`).toBe(200);
    }
    const refused = await postPreview(planId, pngHeader(999, 10), "photographer");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "Too many preview uploads: try again in a little while.",
    });
    const read = await getPreview(planId);
    expect(Buffer.from(await read.arrayBuffer()).equals(pngHeader(39, 10))).toBe(true);
  });

  it("keeps previews out of every public route", async () => {
    const planId = await makePlan("Hidden picture", false);
    expect((await postPreview(planId, PNG, "owner")).status).toBe(200);
    // The images route serves only board image names, never the preview's key.
    for (const [month, name] of [
      ["..", `plan-previews/${planId}.png`],
      ["plan-previews", `${planId}.png`],
      ["2026-10", `../../plan-previews/${planId}.png`],
    ]) {
      const refused = await images.GET(new Request("http://localhost/api/community/images/x/y"), {
        params: Promise.resolve({ month: month!, name: name! }),
      });
      expect(refused.status).toBe(404);
    }
    expect((await getPreview(planId)).status).toBe(404);
  });

  it("goes with its post when the post is taken down through an upper-case id", async () => {
    vi.stubEnv("COMMUNITY_ADMIN_TOKEN", "plan-access-admin-token");
    for (const who of ["owner", undefined] as const) {
      removedKeys.length = 0;
      const planId = await makePlan("Shouted", true);
      expect((await postPreview(planId, PNG, "owner")).status).toBe(200);
      expect(await getFileStore().get("plan-previews", `${planId}.png`)).toBeDefined();
      const loud = planId.toUpperCase();
      const removed = await plan.DELETE(
        request("DELETE", `/api/community/plans/${loud}`, {
          who,
          headers: who ? {} : { "x-admin-token": "plan-access-admin-token" },
        }),
        params({ planId: loud }),
      );
      expect(removed.status, who ?? "admin header").toBe(200);
      expect(removedKeys, who ?? "admin header").toContain(`${planId}.png`);
      expect(await getFileStore().get("plan-previews", `${planId}.png`), who ?? "admin header").toBeUndefined();
    }
  });

  it("answers a failed account lookup as no preview, not an unhandled error", async () => {
    const planId = await makePlan("Looked up", true);
    expect((await postPreview(planId, PNG, "owner")).status).toBe(200);
    forgetSessionUsers();
    withDbFault(/from "community_users"/, Object.assign(new Error("boom"), { code: "XX000" }));
    try {
      const failed = await getPreview(planId, "stranger");
      expect(failed.status).toBe(404);
      expect(await failed.json()).toEqual({ error: "No preview." });
    } finally {
      clearDbFault();
      resetDbBreaker();
    }
    expect((await getPreview(planId, "stranger")).status).toBe(200);
  });
});

describe("counting views", () => {
  withModAndCommunityOn();

  it("counts a view on its own POST, never on a read", async () => {
    const planId = await makePlan("Watched", true);
    for (let i = 0; i < 2; i++) {
      const read = await plan.GET(request("GET", `/api/community/plans/${planId}`), params({ planId }));
      expect(read.status).toBe(200);
      expect(((await read.json()) as { plan: { views: number } }).plan.views).toBe(0);
    }
    expect((await planRow(planId)).views).toBe(0);

    const counted = await view.POST(request("POST", `/api/community/plans/${planId}/view`), params({ planId }));
    expect(counted.status).toBe(200);
    expect(await counted.json()).toEqual({ views: 1 });
    expect((await planRow(planId)).views).toBe(1);
  });

  it("counts nothing for a stranger on an unpublished post, or for a post that does not exist", async () => {
    const planId = await makePlan("Unseen", false);
    const stranger = await view.POST(request("POST", `/api/community/plans/${planId}/view`), params({ planId }));
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: "Plan not found." });
    expect((await planRow(planId)).views).toBe(0);
    const missing = randomUUID();
    const gone = await view.POST(request("POST", `/api/community/plans/${missing}/view`), params({ planId: missing }));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "Plan not found." });
  });
});

describe("a post's comments", () => {
  withModAndCommunityOn();

  const readComments = (planId: string, options: { who?: string; headers?: Record<string, string> } = {}) =>
    comments.GET(request("GET", `/api/community/plans/${planId}/comments`, options), params({ planId }));

  it("an admin-token request reads an unpublished post's comments", async () => {
    vi.stubEnv("COMMUNITY_ADMIN_TOKEN", "plan-access-admin-token");
    const planId = await makePlan("Private thread", false);
    const posted = await comments.POST(
      request("POST", `/api/community/plans/${planId}/comments`, { who: "owner", body: { body: "Notes" } }),
      params({ planId }),
    );
    expect(posted.status).toBe(200);

    const stranger = await readComments(planId);
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: "Plan not found." });
    const admin = await readComments(planId, { headers: { "x-admin-token": "plan-access-admin-token" } });
    expect(admin.status).toBe(200);
    const thread = (await admin.json()) as { comments: Array<{ body: string; canDelete: boolean }> };
    expect(thread.comments.map((comment) => comment.body)).toEqual(["Notes"]);
    expect(thread.comments[0]!.canDelete).toBe(false);
  });

  it("a database error reading a post's comments answers 500, not 404", async () => {
    const planId = await makePlan("Unreachable thread", true);
    withDbFault(/from "community_plans"/, refused());
    try {
      const failed = await readComments(planId);
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "Comments could not be loaded." });
      expect(failed.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      clearDbFault();
      resetDbBreaker();
    }
    expect((await readComments(planId)).status).toBe(200);
  });

  it("a database error reading the post a comment goes on answers 500, not 404", async () => {
    const planId = await makePlan("Unreachable post", true);
    const postComment = () =>
      comments.POST(
        request("POST", `/api/community/plans/${planId}/comments`, { who: "poster", body: { body: "Hello" } }),
        params({ planId }),
      );
    withDbFault(/from "community_plans"/, refused());
    try {
      const failed = await postComment();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "The comment could not be posted." });
      expect(failed.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      clearDbFault();
      resetDbBreaker();
    }
    expect((await postComment()).status).toBe(200);
  });

  it("deleting a comment under another post's id leaves it in its thread", async () => {
    const planId = await makePlan("Kept thread", true);
    const otherId = await makePlan("Other thread", true);
    const posted = await comments.POST(
      request("POST", `/api/community/plans/${planId}/comments`, { who: "poster", body: { body: "Stays" } }),
      params({ planId }),
    );
    const { comment: written } = (await posted.json()) as { comment: { id: string } };
    await commentsRepo.softDelete(otherId, written.id);
    expect((await commentsRepo.list(planId, 10)).map((row) => row.id)).toEqual([written.id]);
    await commentsRepo.softDelete(planId, written.id);
    expect(await commentsRepo.list(planId, 10)).toEqual([]);
  });

  const commentCount = async (planId: string) =>
    (
      await testDb()
        .db.selectFrom("community_plans")
        .select(["comment_count", "last_comment_at"])
        .where("id", "=", planId)
        .executeTakeFirstOrThrow()
    );

  const postComment = (planId: string, who: string, body: string) =>
    comments.POST(
      request("POST", `/api/community/plans/${planId}/comments`, { who, body: { body } }),
      params({ planId }),
    );

  it("a comment and its count move together", async () => {
    const planId = await makePlan("Counted thread", true);
    expect((await postComment(planId, "poster", "First")).status).toBe(200);
    expect(await commentCount(planId)).toMatchObject({ comment_count: 1 });

    withDbFault(/update "community_plans"/, refused());
    try {
      const failed = await postComment(planId, "poster", "Second");
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "The comment could not be posted." });
    } finally {
      clearDbFault();
      resetDbBreaker();
    }
    expect((await commentsRepo.list(planId, 10)).map((row) => row.body)).toEqual(["First"]);
    expect(await commentCount(planId)).toMatchObject({ comment_count: 1 });

    const [only] = await commentsRepo.list(planId, 10);
    withDbFault(/update "community_plans"/, refused());
    try {
      const failed = await comment.DELETE(
        request("DELETE", `/api/community/plans/${planId}/comments/${only!.id}`, { who: "poster" }),
        params({ planId, commentId: only!.id }),
      );
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "The comment could not be deleted." });
    } finally {
      clearDbFault();
      resetDbBreaker();
    }
    expect((await commentsRepo.list(planId, 10)).map((row) => row.body)).toEqual(["First"]);
    expect(await commentCount(planId)).toMatchObject({ comment_count: 1 });
  });

  it("recounts a post's comments and its last comment as they land and go", async () => {
    const planId = await makePlan("Recounted thread", true);
    const first = (await (await postComment(planId, "poster", "One")).json()) as { comment: { id: string } };
    const second = (await (await postComment(planId, "owner", "Two")).json()) as {
      comment: { id: string; createdAt: string };
    };
    expect(await commentCount(planId)).toEqual({ comment_count: 2, last_comment_at: second.comment.createdAt });
    const removed = await comment.DELETE(
      request("DELETE", `/api/community/plans/${planId}/comments/${second.comment.id}`, { who: "owner" }),
      params({ planId, commentId: second.comment.id }),
    );
    expect(removed.status).toBe(200);
    const [kept] = await commentsRepo.list(planId, 10);
    expect(kept!.id).toBe(first.comment.id);
    expect(await commentCount(planId)).toEqual({ comment_count: 1, last_comment_at: kept!.created_at });
  });

  it("a database error finding a comment to delete answers 500, not 404", async () => {
    const planId = await makePlan("Unreachable comment", true);
    const posted = (await (await postComment(planId, "poster", "Here")).json()) as { comment: { id: string } };
    const commentId = posted.comment.id;
    const deleteIt = () =>
      comment.DELETE(
        request("DELETE", `/api/community/plans/${planId}/comments/${commentId}`, { who: "poster" }),
        params({ planId, commentId }),
      );
    for (const table of [/community_comments/, /community_users/]) {
      forgetSessionUsers();
      withDbFault(table, refused());
      try {
        const failed = await deleteIt();
        expect(failed.status, String(table)).toBe(500);
        expect(await failed.json()).toEqual({ error: "The comment could not be deleted." });
        expect(failed.headers.get("Cache-Control"), String(table)).toBe("no-store");
      } finally {
        clearDbFault();
        resetDbBreaker();
      }
    }
    expect((await commentsRepo.list(planId, 10)).map((row) => row.id)).toEqual([commentId]);
    expect((await deleteIt()).status).toBe(200);
  });

  it("a comment on a post taken down after its access read is not found", async () => {
    const planId = randomUUID();
    // The access read still saw the post; it is gone by the time the comment locks it.
    const seen = vi
      .spyOn(plansRepo, "readAccess")
      .mockResolvedValueOnce({ id: planId, user_id: users.owner!.id, is_public: true });
    try {
      const posted = await postComment(planId, "poster", "Too late");
      expect(posted.status).toBe(404);
      expect(await posted.json()).toEqual({ error: "Plan not found." });
    } finally {
      seen.mockRestore();
    }
    expect(await commentsRepo.list(planId, 10)).toEqual([]);
  });

  it("writes a comment and its post's figures under the post's lock", async () => {
    const planId = await makePlan("Locked thread", true);
    const LOCK = /^select "id" from "community_plans" where "id" = \$1 for no key update$/;
    let sent = recordSql();
    const posted = await postComment(planId, "poster", "Locked");
    expect(posted.status).toBe(200);
    const { comment: written } = (await posted.json()) as { comment: { id: string } };
    let lock = at(sent, LOCK);
    let write = at(sent, /^insert into "community_comments"/, lock);
    at(sent, /^update "community_plans" set "comment_count" = /, write);

    sent = recordSql();
    const removed = await comment.DELETE(
      request("DELETE", `/api/community/plans/${planId}/comments/${written.id}`, { who: "poster" }),
      params({ planId, commentId: written.id }),
    );
    expect(removed.status).toBe(200);
    lock = at(sent, LOCK);
    write = at(sent, /^update "community_comments" set "deleted_at" = /, lock);
    at(sent, /^update "community_plans" set "comment_count" = /, write);
    clearDbFault();
  });
});

describe("listing posts", () => {
  withModAndCommunityOn();

  /** Posts straight into the table, out of every other case's way by their game version. */
  async function seed(rows: Array<{ name: string; version: string; isPublic: boolean }>) {
    await testDb()
      .db.insertInto("community_plans")
      .values(
        rows.map((row) => ({
          user_id: users.owner!.id,
          author_name: "owner",
          name: row.name,
          game_version: row.version,
          plan: json({ nodes: [] }),
          is_public: row.isPublic,
          uploader_key: "test",
        })),
      )
      .execute();
    invalidatePlanListCache();
  }

  const listPage = async (query: string) => {
    const response = await list.GET(request("GET", `/api/community/plans?${query}`));
    expect(response.status).toBe(200);
    return (await response.json()) as { plans: Array<{ name: string }>; total: number; gameVersions: string[] };
  };

  it("a page past the end still counts every post", async () => {
    await seed([
      { name: "Past one", version: "past-end", isPublic: true },
      { name: "Past two", version: "past-end", isPublic: true },
      { name: "Past three", version: "past-end", isPublic: true },
      { name: "Past hidden", version: "past-end", isPublic: false },
    ]);
    const first = await listPage("gameVersion=past-end&pageSize=2");
    expect(first.plans).toHaveLength(2);
    expect(first.total).toBe(3);
    const beyond = await listPage("gameVersion=past-end&pageSize=2&page=99");
    expect(beyond.plans).toEqual([]);
    expect(beyond.total).toBe(3);
  });

  it("the version filter lists only published posts' versions", async () => {
    await seed([
      { name: "Versioned", version: "7.8-published", isPublic: true },
      { name: "Versioned draft", version: "7.7-unpublished", isPublic: false },
    ]);
    const page = await listPage("sort=new");
    expect(page.gameVersions).toContain("7.8-published");
    expect(page.gameVersions).not.toContain("7.7-unpublished");
  });

  it("a search's pattern characters match nothing wider", async () => {
    await seed([
      { name: "aXb", version: "literal", isPublic: true },
      { name: "abc", version: "literal", isPublic: true },
      { name: "x*y", version: "literal", isPublic: true },
    ]);
    const names = async (search: string) =>
      (await listPage(`gameVersion=literal&search=${encodeURIComponent(search)}`)).plans
        .map((plan) => plan.name)
        .sort();
    const everything = await names("");
    expect(everything).toEqual(["aXb", "abc", "x*y"]);
    // `*` and `_` are no wildcards, and `,` `)` never close the text's filter.
    expect(await names("a*b")).toEqual([]);
    expect(await names("a_c")).toEqual([]);
    expect(await names("a,b)")).toEqual([]);
    expect(await names("x,is_public.eq.false")).toEqual([]);
    // Alone, they are no search at all: nothing past the unsearched list.
    expect(await names("*")).toEqual(everything);
    expect(await names("%")).toEqual(everything);
  });
});

describe("filtering and sorting the list", () => {
  withModAndCommunityOn();

  const steel = { kind: "item", resourceId: "gregtech:steel", rate: 2 };
  const oil = { kind: "fluid", resourceId: "oil", rate: 100 };
  const power = { kind: "item", resourceId: "ic2:coal", rate: 1 };

  /** Posts straight into the table, every column a case reads set, kept apart by their game version. */
  async function seed(
    version: string,
    rows: Array<{
      name: string;
      isPublic?: boolean;
      tags?: string[];
      author?: string;
      description?: string;
      outputs?: unknown[];
      needs?: unknown[];
      tier?: number;
      euT?: number;
      views?: number;
      lastActivity?: string | null;
      createdAt: string;
    }>,
  ) {
    for (const row of rows) {
      await testDb().pglite.query(
        `insert into community_plans (user_id, author_name, name, description, game_version, plan, is_public,
           uploader_key, tags, tags_text, outputs, needs, highest_tier_index, total_eu_t, views,
           last_activity_at, created_at)
         values ($1, $2, $3, $4, $5, '{"nodes":[]}', $6, 'test', $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          users.owner!.id,
          row.author ?? "owner",
          row.name,
          row.description ?? "",
          version,
          row.isPublic ?? true,
          JSON.stringify(row.tags ?? []),
          (row.tags ?? []).join(" "),
          JSON.stringify(row.outputs ?? []),
          JSON.stringify(row.needs ?? []),
          row.tier ?? -1,
          row.euT ?? 0,
          row.views ?? 0,
          row.lastActivity ?? null,
          row.createdAt,
        ],
      );
    }
    invalidatePlanListCache();
  }

  const names = async (query: string, who?: string) => {
    const response = await list.GET(request("GET", `/api/community/plans?${query}`, { who }));
    expect(response.status).toBe(200);
    return ((await response.json()) as { plans: Array<{ name: string }> }).plans.map((plan) => plan.name);
  };

  it("narrows by what a post makes and takes, tier, power, tag, author and text, as the shelf did", async () => {
    await seed("filters", [
      { name: "Steel mill", outputs: [steel], needs: [power], tags: ["early game"], tier: 2, euT: 30, createdAt: "2026-10-01 10:00:00+00" },
      { name: "Refinery", outputs: [oil], needs: [power], tags: ["oil"], tier: 3, euT: 500, createdAt: "2026-10-02 10:00:00+00" },
      { name: "Both", outputs: [steel, oil], needs: [], tags: ["oil", "steel"], author: "b_rkge", tier: 4, euT: 2000, description: "big refinery", createdAt: "2026-10-03 10:00:00+00" },
      { name: "Hidden steel", isPublic: false, outputs: [steel], createdAt: "2026-10-04 10:00:00+00" },
    ]);
    const v = "gameVersion=filters";
    expect(await names(v)).toEqual(["Both", "Refinery", "Steel mill"]);
    expect(await names(`${v}&makes=${encodeURIComponent("item:gregtech:steel")}`)).toEqual(["Both", "Steel mill"]);
    expect(await names(`${v}&makes=${encodeURIComponent("item:gregtech:steel,fluid:oil")}`)).toEqual(["Both"]);
    expect(await names(`${v}&takes=${encodeURIComponent("item:ic2:coal")}`)).toEqual(["Refinery", "Steel mill"]);
    expect(await names(`${v}&maxTierIndex=3`)).toEqual(["Refinery", "Steel mill"]);
    expect(await names(`${v}&maxEuT=500`)).toEqual(["Refinery", "Steel mill"]);
    const search = (text: string) => names(`${v}&search=${encodeURIComponent(text)}`);
    expect(await search("#oil")).toEqual(["Both", "Refinery"]);
    expect(await search("#oil #steel")).toEqual(["Both"]);
    expect(await search("#early_game")).toEqual(["Steel mill"]);
    expect(await search("@b_rkge")).toEqual(["Both"]);
    expect(await search("@brkge")).toEqual([]);
    expect(await search("@")).toEqual([]);
    expect(await search("refinery")).toEqual(["Both", "Refinery"]);
    expect(await search("MILL")).toEqual(["Steel mill"]);
    expect(await names(`${v}&mine=1`, "owner")).toContain("Hidden steel");
  });

  it("sorts by the chosen column, ties and nulls as the shelf did", async () => {
    await seed("sorting", [
      { name: "Old busy", views: 5, lastActivity: "2026-10-05 10:00:00+00", createdAt: "2026-10-01 10:00:00+00" },
      { name: "New busy", views: 5, lastActivity: null, createdAt: "2026-10-03 10:00:00+00" },
      { name: "Quiet", views: 1, lastActivity: "2026-10-04 10:00:00+00", createdAt: "2026-10-02 10:00:00+00" },
    ]);
    const v = "gameVersion=sorting";
    expect(await names(`${v}&sort=new`)).toEqual(["New busy", "Quiet", "Old busy"]);
    // Equal views: newest first.
    expect(await names(`${v}&sort=views`)).toEqual(["New busy", "Old busy", "Quiet"]);
    // No activity sorts last, whichever way the column is read.
    expect(await names(`${v}&sort=active`)).toEqual(["Old busy", "Quiet", "New busy"]);
    expect(await names(`${v}&sort=nonsense`)).toEqual(["New busy", "Quiet", "Old busy"]);
    // An inherited key is no column either: it sorts as an unknown one.
    for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(await names(`${v}&sort=${inherited}`), inherited).toEqual(["New busy", "Quiet", "Old busy"]);
    }
    expect(await names(`${v}&sort=views&pageSize=1&page=2`)).toEqual(["Old busy"]);
  });

  it("matches `%`, `_` and a backslash in a tag or the text as themselves", async () => {
    await seed("like-escape", [
      { name: "a_c", tags: ["t_g"], createdAt: "2026-10-01 10:00:00+00" },
      { name: "abc", tags: ["tag"], createdAt: "2026-10-01 10:00:01+00" },
      { name: "a%c", tags: ["t%g"], createdAt: "2026-10-01 10:00:02+00" },
      { name: "a\\c", tags: ["t\\g"], createdAt: "2026-10-01 10:00:03+00" },
    ]);
    // The search box scrubs these characters out; a search built past it
    // still matches only what it names.
    const found = async (search: { tags?: string[]; text?: string }) =>
      (
        await plansRepo.list({
          search: { tags: search.tags ?? [], author: "", bareAuthor: false, text: search.text ?? "" },
          gameVersion: "like-escape",
          makes: [],
          takes: [],
          shelf: { kind: "public" },
          sort: { column: "created_at", ascending: true, nullsLast: false },
          offset: 0,
          limit: 10,
        })
      ).rows.map((row) => row.name);
    expect(await found({})).toEqual(["a_c", "abc", "a%c", "a\\c"]);
    expect(await found({ text: "a_c" })).toEqual(["a_c"]);
    expect(await found({ text: "a%c" })).toEqual(["a%c"]);
    expect(await found({ text: "a\\c" })).toEqual(["a\\c"]);
    expect(await found({ text: "%" })).toEqual(["a%c"]);
    expect(await found({ tags: ["t_g"] })).toEqual(["a_c"]);
    expect(await found({ tags: ["t%g"] })).toEqual(["a%c"]);
    expect(await found({ tags: ["t\\g"] })).toEqual(["a\\c"]);
  });

  it("reads a page's rows and its count on one read-only snapshot", async () => {
    await seed("snapshot", [{ name: "Snap", createdAt: "2026-10-01 10:00:00+00" }]);
    const sent = recordSql();
    try {
      const response = await list.GET(request("GET", "/api/community/plans?gameVersion=snapshot"));
      expect(((await response.json()) as { total: number }).total).toBe(1);
    } finally {
      clearDbFault();
    }
    const begin = at(sent, /^set transaction isolation level repeatable read, read only$/);
    const rows = at(sent, /^select "id", .* from "community_plans" where .* order by .* limit \$\d+ offset \$\d+$/, begin);
    const count = at(sent, /^select count\(\*\) as "count" from "community_plans" where /, begin);
    expect(sent.slice(begin + 1, begin + 3).sort()).toEqual([sent[rows], sent[count]].sort());
    // The two statements filter alike.
    const where = (text: string) => text.slice(text.indexOf(" where "), text.indexOf(" order by ") > 0 ? text.indexOf(" order by ") : undefined);
    expect(where(sent[rows]!)).toBe(where(sent[count]!));
  });
});

describe("counting views and downloads", () => {
  withModAndCommunityOn();

  const counts = async (planId: string) =>
    testDb()
      .db.selectFrom("community_plans")
      .select(["views", "downloads"])
      .where("id", "=", planId)
      .executeTakeFirstOrThrow();

  it("counts each in one statement that carries the viewer's access rule", async () => {
    const planId = await makePlan("Counted once", false);
    const sent = recordSql();
    try {
      const viewed = await view.POST(request("POST", `/api/community/plans/${planId}/view`, { who: "owner" }), params({ planId }));
      expect(await viewed.json()).toEqual({ views: 1 });
      const downloaded = await download.POST(
        request("POST", `/api/community/plans/${planId}/download`, { who: "owner" }),
        params({ planId }),
      );
      expect(downloaded.status).toBe(200);
      expect(await downloaded.json()).toEqual({ name: "Counted once", plan: { nodes: [] } });
    } finally {
      clearDbFault();
    }
    const plans = sent.filter((text) => /"community_plans"/.test(text));
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatch(/^update "community_plans" set "views" = "views" \+ \$1 where \("id" = \$2 and \("community_plans"\."is_public" = \$3 or "community_plans"\."user_id" = \$4\)\) returning "views"$/);
    expect(plans[1]).toMatch(/^update "community_plans" set "downloads" = "downloads" \+ \$1 where \("id" = \$2 and \("community_plans"\."is_public" = \$3 or "community_plans"\."user_id" = \$4\)\) returning "plan", "name"$/);
    expect(await counts(planId)).toEqual({ views: 1, downloads: 1 });

    const stranger = await download.POST(
      request("POST", `/api/community/plans/${planId}/download`, { who: "stranger" }),
      params({ planId }),
    );
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: "Plan not found." });
    const strangerView = await view.POST(request("POST", `/api/community/plans/${planId}/view`, { who: "stranger" }), params({ planId }));
    expect(strangerView.status).toBe(404);
    expect(await counts(planId)).toEqual({ views: 1, downloads: 1 });
  });
});

describe("a database outage reading a post", () => {
  withModAndCommunityOn();

  const DOWN = { error: "The community database is not responding. Try again in a few minutes." };

  /** The answer while every statement matching `match` finds the database down. */
  async function whileDown(match: RegExp, send: () => Promise<Response>) {
    withDbFault(match);
    try {
      const answer = await send();
      return { status: answer.status, body: await answer.json() };
    } finally {
      clearDbFault();
      resetDbBreaker();
    }
  }

  it("answers the database-down line, never Plan not found.", async () => {
    const planId = await makePlan("Unreachable", true);
    const base = `/api/community/plans/${planId}`;
    const ownersPost = { planId };
    const down = { status: 500, body: DOWN };

    invalidatePlanListCache();
    expect(await whileDown(/from "community_plans"/, () => list.GET(request("GET", "/api/community/plans")))).toEqual(down);
    expect(await whileDown(/from "community_plans"/, () => plan.GET(request("GET", base), params(ownersPost)))).toEqual(down);
    expect(
      await whileDown(/from "community_plans"/, () =>
        plan.PUT(request("PUT", base, { who: "owner", body: { name: "Renamed" } }), params(ownersPost)),
      ),
    ).toEqual(down);
    expect(
      await whileDown(/from "community_plans"/, () => plan.DELETE(request("DELETE", base, { who: "owner" }), params(ownersPost))),
    ).toEqual(down);
    expect(
      await whileDown(/^update "community_plans" set "downloads"/, () =>
        download.POST(request("POST", `${base}/download`), params(ownersPost)),
      ),
    ).toEqual(down);
    const form = new FormData();
    form.set("image", new Blob([PNG as BlobPart], { type: "image/png" }), "board.png");
    expect(
      await whileDown(/from "community_plans"/, () =>
        preview.POST(
          new Request(`http://localhost${base}/preview`, {
            method: "POST",
            headers: { "x-client-ip": nextAddress(), cookie: users.owner!.cookie },
            body: form,
          }),
          params(ownersPost),
        ),
      ),
    ).toEqual(down);

    // The post is untouched and answers again once the database does.
    const back = await plan.GET(request("GET", base), params(ownersPost));
    expect(back.status).toBe(200);
    expect(((await back.json()) as { plan: { name: string } }).plan.name).toBe("Unreachable");
  });

  it("answers a vote, a view and a preview with the down line too", async () => {
    const planId = await makePlan("Unreachable counters", true);
    const base = `/api/community/plans/${planId}`;
    const down = { status: 500, body: DOWN };
    expect(
      await whileDown(/from "community_plans"/, () =>
        vote.POST(
          request("POST", `${base}/vote`, { body: { deviceId: "d", value: 1 } }),
          params({ planId }),
        ),
      ),
    ).toEqual(down);
    expect(
      await whileDown(/"community_plans"/, () =>
        view.POST(request("POST", `${base}/view`), params({ planId })),
      ),
    ).toEqual(down);
    expect(
      await whileDown(/from "community_plans"/, () =>
        preview.GET(request("GET", `${base}/preview`), params({ planId })),
      ),
    ).toEqual(down);
    forgetSessionUsers();
    expect(
      await whileDown(/from "community_users"/, () =>
        preview.GET(request("GET", `${base}/preview`, { who: "stranger" }), params({ planId })),
      ),
    ).toEqual(down);
  });

  it("lists the posts without versions when only the version list fails, and keeps none of that answer", async () => {
    const planId = await makePlan("Versioned", true);
    await testDb().db.updateTable("community_plans").set({ game_version: "2.9.0-versioned" }).where("id", "=", planId).execute();
    invalidatePlanListCache();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let answer;
    try {
      answer = await whileDown(/^select distinct "game_version"/, () => list.GET(request("GET", "/api/community/plans")));
      expect(errors).toHaveBeenCalledWith("Listing the game versions failed.", expect.anything());
    } finally {
      errors.mockRestore();
    }
    expect(answer.status).toBe(200);
    const body = answer.body as { plans: Array<{ id: string }>; gameVersions: string[] };
    expect(body.plans.map((post) => post.id)).toContain(planId);
    expect(body.gameVersions).toEqual([]);
    // Nothing of the failed answer was kept: the next list asks again and has the versions.
    const again = await list.GET(request("GET", "/api/community/plans"));
    expect(((await again.json()) as { gameVersions: string[] }).gameVersions).toContain("2.9.0-versioned");
  });

  it("keeps the saved stat card when the database fails while a stale one is refreshed", async () => {
    const planId = await makePlan("Stale card", true);
    await testDb().db.updateTable("community_plans").set({ stats_version: "0" }).where("id", "=", planId).execute();
    for (const match of [/^select "stats_version"/, /^select "plan" from "community_plans"/]) {
      const answer = await whileDown(match, () => plan.GET(request("GET", `/api/community/plans/${planId}`), params({ planId })));
      expect(answer.status, String(match)).toBe(200);
      expect((answer.body as { plan: { name: string } }).plan.name).toBe("Stale card");
    }
  });

  it("throws from each reader, so no caller can read an outage as a missing post", async () => {
    const planId = await makePlan("Thrown", true);
    const owner = { userId: users.owner!.id, isAdmin: false, adminToken: false };
    const readers: Array<[string, () => Promise<unknown>]> = [
      ["distinctGameVersions", () => plansRepo.distinctGameVersions()],
      ["readSummary", () => plansRepo.readSummary(planId)],
      ["readOwner", () => plansRepo.readOwner(planId)],
      ["readStatsVersion", () => plansRepo.readStatsVersion(planId)],
      ["readPlanJson", () => plansRepo.readPlanJson(planId)],
      ["takeDownload", () => plansRepo.takeDownload(planId, owner)],
    ];
    for (const [name, read] of readers) {
      withDbFault(/"community_plans"/);
      try {
        await expect(read(), name).rejects.toThrow(DOWN.error);
      } finally {
        clearDbFault();
        resetDbBreaker();
      }
    }
  });
});

describe("a malformed post id", () => {
  withModAndCommunityOn();

  it("is not found, not an error, and sends no query", async () => {
    vi.stubEnv("COMMUNITY_ADMIN_TOKEN", "plan-access-admin-token");
    const spyOnAll = (module: object) =>
      Object.entries(module)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => vi.spyOn(module as Record<string, (...args: unknown[]) => unknown>, name));
    const querySpies = [plansRepo, commentsRepo, votesRepo].flatMap(spyOnAll);
    // The rate-limit reads too: view, comment and vote check the id before their pace.
    const spies = [...querySpies, ...spyOnAll(eventsRepo)];
    try {
      const planId = "not-a-uuid";
      const base = `/api/community/plans/${planId}`;
      const form = new FormData();
      form.set("image", new Blob([PNG as BlobPart], { type: "image/png" }), "board.png");
      const planAnswers = await Promise.all([
        plan.GET(request("GET", base), params({ planId })),
        plan.PUT(request("PUT", base, { who: "owner", body: { isPublic: true } }), params({ planId })),
        plan.DELETE(request("DELETE", base, { who: "owner" }), params({ planId })),
        plan.DELETE(
          request("DELETE", base, { headers: { "x-admin-token": "plan-access-admin-token" } }),
          params({ planId }),
        ),
        view.POST(request("POST", `${base}/view`), params({ planId })),
        download.POST(request("POST", `${base}/download`), params({ planId })),
        preview.POST(
          new Request(`http://localhost${base}/preview`, {
            method: "POST",
            headers: { "x-client-ip": nextAddress(), cookie: users.owner!.cookie },
            body: form,
          }),
          params({ planId }),
        ),
        comments.GET(request("GET", `${base}/comments`), params({ planId })),
        comments.POST(request("POST", `${base}/comments`, { who: "poster", body: { body: "Hi" } }), params({ planId })),
        vote.POST(request("POST", `${base}/vote`, { body: { deviceId: "device-1", value: 1 } }), params({ planId })),
      ]);
      for (const answer of planAnswers) {
        expect(answer.status).toBe(404);
        expect(await answer.json()).toEqual({ error: "Plan not found." });
      }
      const pictures = await preview.GET(request("GET", `${base}/preview`), params({ planId }));
      expect(pictures.status).toBe(404);
      expect(await pictures.json()).toEqual({ error: "No preview." });
      const commentId = randomUUID();
      for (const ids of [
        { planId, commentId },
        { planId: randomUUID(), commentId: "not-a-uuid" },
      ]) {
        const gone = await comment.DELETE(
          request("DELETE", `/api/community/plans/${ids.planId}/comments/${ids.commentId}`, { who: "poster" }),
          params(ids),
        );
        expect(gone.status).toBe(404);
        expect(await gone.json()).toEqual({ error: "Comment not found." });
      }
      for (const spy of spies) {
        expect(spy, spy.getMockName()).not.toHaveBeenCalled();
      }
      // The spies see the service's reads: a well-formed id is looked up, and
      // its view spends a share of the pace.
      const missing = randomUUID();
      const gone = await plan.GET(request("GET", `/api/community/plans/${missing}`), params({ planId: missing }));
      expect(gone.status).toBe(404);
      expect(vi.mocked(plansRepo.readSummary)).toHaveBeenCalledWith(missing);
      const unseen = await view.POST(request("POST", `/api/community/plans/${missing}/view`), params({ planId: missing }));
      expect(unseen.status).toBe(404);
      expect(vi.mocked(eventsRepo.countSince)).toHaveBeenCalled();
      vi.mocked(eventsRepo.countSince).mockClear();
      const unvoted = await vote.POST(
        request("POST", `/api/community/plans/${missing}/vote`, { body: { deviceId: "device-1", value: 1 } }),
        params({ planId: missing }),
      );
      expect(unvoted.status).toBe(404);
      expect(await unvoted.json()).toEqual({ error: "Plan not found." });
      expect(vi.mocked(eventsRepo.countSince)).toHaveBeenCalled();
      expect(vi.mocked(plansRepo.readAccess)).toHaveBeenCalledWith(missing);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

describe("posting to the community", () => {
  withModAndCommunityOn();

  it("refuses a post whose declared length is over the cap without reading it", async () => {
    const { request, counts } = oversizeRequest(
      "http://localhost/api/community/plans",
      "POST",
      5 * 1024 * 1024,
      { "x-client-ip": nextAddress(), cookie: users.poster!.cookie },
    );
    const response = await list.POST(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Upload too large." });
    expect(counts.pulls).toBe(0);
  });

  it("stores a plan-mode post whose stats solve ran out of time, with the failed plan's stats", async () => {
    const plan = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "src/components/flow/__fixtures__/up-to-silicon-line.json"),
        "utf8",
      ),
    ) as FactoryProject;
    statsBudget.ms = 0;
    try {
      takeLpCount();
      const response = await list.POST(
        request("POST", "/api/community/plans", {
          who: "owner",
          body: { ...postBody("device-plan"), name: "Silicon", plan },
        }),
      );
      expect(response.status).toBe(201);
      expect(takeLpCount()).toBe(0);
      const { id } = (await response.json()) as { id: string };
      const data = await testDb()
        .db.selectFrom("community_plans")
        .select(["node_count", "stats_version"])
        .where("id", "=", id)
        .executeTakeFirst();
      expect(data).toEqual({ node_count: plan.nodes.length, stats_version: APP_VERSION });
    } finally {
      statsBudget.ms = 5_000;
    }
  });

  it("keeps a stored post's stats when a refresh of them runs out of time", async () => {
    const silicon = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "src/components/flow/__fixtures__/up-to-silicon-line.json"),
        "utf8",
      ),
    ) as FactoryProject;
    const posted = await list.POST(
      request("POST", "/api/community/plans", {
        who: "owner",
        body: { ...postBody("device-refresh"), name: "Silicon refresh", plan: silicon },
      }),
    );
    expect(posted.status).toBe(201);
    const { id: planId } = (await posted.json()) as { id: string };
    const row = () =>
      testDb()
        .db.selectFrom("community_plans")
        .select(["machine_count", "stats_version"])
        .where("id", "=", planId)
        .executeTakeFirstOrThrow();
    const solvedCount = (await row()).machine_count;
    // A card from an older release, marked so an overwrite shows.
    await testDb()
      .db.updateTable("community_plans")
      .set({ machine_count: 999, stats_version: "0.0.0" })
      .where("id", "=", planId)
      .execute();
    expect(await row()).toEqual({ machine_count: 999, stats_version: "0.0.0" });
    const open = () =>
      plan.GET(request("GET", `/api/community/plans/${planId}`, { who: "owner" }), params({ planId }));

    // A fresh process: the plan's islands are not in the solver's cache yet.
    islandCache.clear();
    statsBudget.ms = 0;
    try {
      expect((await open()).status).toBe(200);
      expect(await row()).toEqual({ machine_count: 999, stats_version: "0.0.0" });
    } finally {
      statsBudget.ms = 5_000;
    }
    expect((await open()).status).toBe(200);
    expect(await row()).toEqual({ machine_count: solvedCount, stats_version: APP_VERSION });
  });

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
