import { beforeEach, describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

/** Every query call the routes make, as [method, args]. */
const calls: Array<[string, unknown[]]> = [];

/** A stand-in query builder: every call chains, and awaiting it answers no rows. */
function query(): unknown {
  const proxy: unknown = new Proxy(() => undefined, {
    get(_target, name) {
      if (name === "then") {
        return (resolve: (value: unknown) => void) => resolve({ data: [], error: null, count: 0 });
      }
      if (name === "maybeSingle" || name === "single") {
        return () => {
          calls.push([name, []]);
          return Promise.resolve({ data: null, error: null });
        };
      }
      return (...args: unknown[]) => {
        calls.push([String(name), args]);
        return proxy;
      };
    },
  });
  return proxy;
}

const sessionUser = vi.fn<() => { id: string; username: string } | undefined>(() => undefined);
const storage = { configured: true };

vi.mock("@/lib/server/community", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/community")>();
  return {
    ...actual,
    isCommunityConfigured: () => storage.configured,
    getCommunityDb: () => query(),
    getSessionUser: vi.fn(async () => sessionUser()),
    checkRateLimit: vi.fn(async () => true),
    makeVoterKey: vi.fn(async () => "voter"),
    makeActorKey: vi.fn(() => "actor"),
  };
});

import * as list from "./route";
import * as one from "./[blueprintId]/route";
import * as publish from "./[blueprintId]/publish/route";
import * as vote from "./[blueprintId]/vote/route";
import * as download from "./[blueprintId]/download/route";

const context = { params: Promise.resolve({ blueprintId: "bp-1" }) };
const ann = { id: "ann-id", username: "ann" };

function get(url: string): Request {
  return new Request(`http://localhost${url}`);
}
function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  calls.length = 0;
  sessionUser.mockReset();
  sessionUser.mockReturnValue(undefined);
});

describe("blueprints with the setting unset", () => {
  withModAndCommunityUnset();

  it("answers 404 to the public shelf, publishing, voting and placing a public blueprint", async () => {
    sessionUser.mockReturnValue(ann);
    const answers = [
      await list.GET(get("/api/blueprints?scope=public")),
      await publish.POST(post("/api/blueprints/bp-1/publish", { publish: true }), context),
      await vote.POST(post("/api/blueprints/bp-1/vote", { deviceId: "d", value: 1 }), context),
      await download.POST(post("/api/blueprints/bp-1/download", {}), context),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: "Not found" });
    }
    expect(calls).toEqual([]);
  });

  it("answers the public shelf as absent on a server with no storage, not 503", async () => {
    storage.configured = false;
    try {
      const shelf = await list.GET(get("/api/blueprints?scope=public"));
      expect(shelf.status).toBe(404);
      expect(await shelf.json()).toEqual({ error: "Not found" });
      expect((await list.GET(get("/api/blueprints"))).status).toBe(503);
    } finally {
      storage.configured = true;
    }
  });

  it("still lists the account's own blueprints", async () => {
    sessionUser.mockReturnValue(ann);
    const response = await list.GET(get("/api/blueprints"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ blueprints: [] });
    expect(calls).toContainEqual(["eq", ["user_id", ann.id]]);
  });

  it("finds only the reader's own blueprint by id, never someone else's published one", async () => {
    sessionUser.mockReturnValue(ann);
    await one.GET(get("/api/blueprints/bp-1"), context);
    expect(calls).toContainEqual(["or", [`user_id.eq.${ann.id}`]]);

    calls.length = 0;
    sessionUser.mockReturnValue(undefined);
    const stranger = await one.GET(get("/api/blueprints/bp-1"), context);
    expect(stranger.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("blueprints with the setting on", () => {
  withModAndCommunityOn();

  it("serves the public shelf and lets a public blueprint be read by id", async () => {
    const shelf = await list.GET(get("/api/blueprints?scope=public"));
    expect(shelf.status).toBe(200);
    expect(calls).toContainEqual(["eq", ["is_public", true]]);

    calls.length = 0;
    sessionUser.mockReturnValue(ann);
    await one.GET(get("/api/blueprints/bp-1"), context);
    expect(calls).toContainEqual(["or", [`is_public.eq.true,user_id.eq.${ann.id}`]]);
  });

  it("reaches publishing, voting and placing", async () => {
    sessionUser.mockReturnValue(ann);
    const answers = [
      await publish.POST(post("/api/blueprints/bp-1/publish", { publish: true }), context),
      await vote.POST(post("/api/blueprints/bp-1/vote", { deviceId: "d", value: 1 }), context),
      await download.POST(post("/api/blueprints/bp-1/download", {}), context),
    ];
    for (const answer of answers) {
      expect(await answer.json()).not.toEqual({ error: "Not found" });
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});
