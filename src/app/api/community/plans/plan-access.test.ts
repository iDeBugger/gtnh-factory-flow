import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FactoryProject } from "@/lib/model/types";
import { takeLpCount } from "@/lib/solver/plan/lp";
import { APP_VERSION } from "@/lib/version";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { forgetSessionUsers, makeSessionToken } from "@/lib/server/auth/sessions";
import { getCommunityDb, resetDbBreaker } from "@/lib/server/db";
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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Who may do what to a community post, against the local database: posting,
 * voting and the board photograph of a post that is not public.
 */

let local: LocalDatabase;
let files: string;
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
  files = mkdtempSync(path.join(tmpdir(), "plan-access-"));
  vi.stubEnv("FILE_STORE_DIR", files);
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
    expect(await fourth.json()).toEqual({ error: "Too many votes from this network today. Sign in to vote." });
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
    const { data } = await getCommunityDb()
      .from("community_plans")
      .insert({
        user_id: users.photographer!.id,
        author_name: "photographer",
        name: "Reshared",
        plan: { nodes: [] },
        is_public: true,
        uploader_key: "test",
      })
      .select("id")
      .single();
    const planId = (data as { id: string }).id;
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
    expect(plan.planMode).toBe(true);
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
      const { data } = await getCommunityDb()
        .from("community_plans")
        .select("node_count,stats_version")
        .eq("id", id)
        .single();
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
      getCommunityDb()
        .from("community_plans")
        .select("machine_count,stats_version")
        .eq("id", planId)
        .single<{ machine_count: number; stats_version: string }>();
    const solvedCount = (await row()).data!.machine_count;
    // A card from an older release, marked so an overwrite shows.
    const marked = await getCommunityDb()
      .from("community_plans")
      .update({ machine_count: 999, stats_version: "0.0.0" })
      .eq("id", planId);
    expect(marked.error).toBeNull();
    expect((await row()).data).toEqual({ machine_count: 999, stats_version: "0.0.0" });
    const open = () =>
      plan.GET(request("GET", `/api/community/plans/${planId}`, { who: "owner" }), params({ planId }));

    // A fresh process: the plan's islands are not in the solver's cache yet.
    islandCache.clear();
    statsBudget.ms = 0;
    try {
      expect((await open()).status).toBe(200);
      expect((await row()).data).toEqual({ machine_count: 999, stats_version: "0.0.0" });
    } finally {
      statsBudget.ms = 5_000;
    }
    expect((await open()).status).toBe(200);
    expect((await row()).data).toEqual({ machine_count: solvedCount, stats_version: APP_VERSION });
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
