import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import {
  bumpSessionEpoch,
  checkPassword,
  forgetSessionUsers,
  getCommunityDb,
  hashPassword,
  resetDbBreaker,
} from "@/lib/server/community";
import * as login from "./login/route";
import * as logout from "./logout/route";
import * as me from "./me/route";
import * as register from "./register/route";

/**
 * Accounts over REST, against the local database: sign-up rules, sign-in,
 * the session cookie, and signing out.
 */

let local: LocalDatabase;
let addresses = 0;
/** When set, the answer of every account row read waits on it (a slow database); the read itself happens at once. */
let holdAccountReads: Promise<void> | undefined;
let heldAccountReads = 0;

/** A fresh client address per call: the per-address limits never meet across cases. */
const nextAddress = () => `10.1.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

function post(
  route: { POST: (request: Request) => Promise<Response> },
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return route.POST(
    new Request(`http://localhost/api/community/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-ip": nextAddress(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** The session cookie a sign-in answer sets, as a Cookie header value. */
function cookieOf(response: Response): string {
  const line = response.headers.get("set-cookie") ?? "";
  const match = /gtnh_session=([^;]*)/.exec(line);
  expect(match, line).not.toBeNull();
  return `gtnh_session=${match![1]}`;
}

async function whoAmI(cookie: string): Promise<unknown> {
  const response = await me.GET(new Request("http://localhost/api/community/auth/me", { headers: { cookie } }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { user: unknown }).user;
}

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "auth-test-salt");
  local = await openLocalDatabase();
  useInProcessLocalDb(async (request) => {
    const response = await local.handle(request);
    if (
      holdAccountReads &&
      request.method === "GET" &&
      request.url.includes("community_users") &&
      request.url.includes("session_epoch")
    ) {
      heldAccountReads += 1;
      await holdAccountReads;
    }
    return response;
  });
}, 60_000);

afterEach(() => {
  resetDbBreaker();
  forgetSessionUsers();
});

afterAll(async () => {
  useInProcessLocalDb(undefined);
  await local?.close();
  vi.unstubAllEnvs();
});

describe("signing up", () => {
  it("needs a password of at least 8 characters", async () => {
    const short = await post(register, "register", { username: "short_pw", password: "1234567" });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "Password must be at least 8 characters." });
    const made = await post(register, "register", { username: "short_pw", password: "12345678" });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ username: "short_pw", isAdmin: false });
    expect(await whoAmI(cookieOf(made))).toEqual({ username: "short_pw", isAdmin: false });
  });
});

describe("signing in", () => {
  it("takes an account's password whatever its length, and refuses a wrong one", async () => {
    await post(register, "register", { username: "ann_in", password: "ann-password" });
    const wrong = await post(login, "login", { username: "ann_in", password: "not-it-at-all" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "Wrong username or password." });
    const right = await post(login, "login", { username: "ann_in", password: "ann-password" });
    expect(right.status).toBe(200);
    expect(await whoAmI(cookieOf(right))).toEqual({ username: "ann_in", isAdmin: false });
  });
});

describe("signing out", () => {
  it("clears the cookie and, without more, changes nothing server-side", async () => {
    const made = await post(register, "register", { username: "ann_out", password: "ann-password" });
    const cookie = cookieOf(made);
    const out = await post(logout, "logout", undefined, { cookie });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    expect(out.headers.get("set-cookie")).toMatch(/^gtnh_session=; .*Max-Age=0/);
    // The token itself is still good: only its browser forgot it.
    expect(await whoAmI(cookie)).toEqual({ username: "ann_out", isAdmin: false });
  });
});

describe("password checks", () => {
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const timed = async (work: () => Promise<unknown>) => {
    const start = performance.now();
    await work();
    return performance.now() - start;
  };

  it("cost the same for an unknown name as for a wrong password", async () => {
    const stored = await hashPassword("y");
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      known.push(await timed(() => checkPassword("x", stored)));
      unknown.push(await timed(() => checkPassword("x", undefined)));
    }
    // scrypt takes tens of milliseconds; the bounds are loose on purpose.
    expect(median(unknown)).toBeGreaterThanOrEqual(10);
    expect(median(unknown)).toBeLessThanOrEqual(3 * median(known));
    expect(await checkPassword("x", undefined)).toBe(false);
    expect(await checkPassword("not-a-password", undefined)).toBe(false);
    expect(await checkPassword("y", stored)).toBe(true);
    expect(await checkPassword("x", stored)).toBe(false);
  }, 20_000);

  it("do not hold the event loop", async () => {
    const stored = await hashPassword("y");
    let ticks = 0;
    const interval = setInterval(() => (ticks += 1), 5);
    try {
      await Promise.all(Array.from({ length: 20 }, () => checkPassword("x", stored)));
    } finally {
      clearInterval(interval);
    }
    // Synchronous scrypt lets the interval fire once or twice while 20 derivations run.
    expect(ticks).toBeGreaterThanOrEqual(20);
  }, 20_000);
});

describe("signing out everywhere", () => {
  it("ends every session of the account, and a fresh sign-in works again", async () => {
    const made = await post(register, "register", { username: "ann_all", password: "ann-password" });
    const a = cookieOf(made);
    const b = cookieOf(await post(login, "login", { username: "ann_all", password: "ann-password" }));
    const out = await post(logout, "logout", { everywhere: true }, { cookie: a });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    expect(out.headers.get("set-cookie")).toMatch(/^gtnh_session=; .*Max-Age=0/);
    expect(await whoAmI(a)).toBeNull();
    expect(await whoAmI(b)).toBeNull();
    const c = cookieOf(await post(login, "login", { username: "ann_all", password: "ann-password" }));
    expect(await whoAmI(c)).toEqual({ username: "ann_all", isAdmin: false });
    expect(await whoAmI(a)).toBeNull();
  });

  it("stops a token minted before epochs existed, which works until then", async () => {
    const made = await post(register, "register", { username: "ann_old", password: "ann-password" });
    const { data } = await getCommunityDb().from("community_users").select("id").eq("username", "ann_old").single();
    const { id } = data as { id: string };
    const payload = `${id}.${Date.now() + 60_000}`;
    const legacy = `gtnh_session=${payload}.${createHmac("sha256", "auth-test-salt").update(payload).digest("hex")}`;
    expect(await whoAmI(legacy)).toEqual({ username: "ann_old", isAdmin: false });
    await post(logout, "logout", { everywhere: true }, { cookie: cookieOf(made) });
    expect(await whoAmI(legacy)).toBeNull();
  });

  it("stops a token whose account read was in flight when the sign-out landed", async () => {
    const made = await post(register, "register", { username: "ann_race", password: "ann-password" });
    const cookie = cookieOf(made);
    const { data } = await getCommunityDb().from("community_users").select("id").eq("username", "ann_race").single();
    forgetSessionUsers();
    // A request with the token starts its row read and stalls in the database.
    let release!: () => void;
    holdAccountReads = new Promise<void>((resolve) => (release = resolve));
    const inFlight = whoAmI(cookie);
    await vi.waitFor(() => expect(heldAccountReads).toBe(1));
    holdAccountReads = undefined;
    // Sign out everywhere lands meanwhile: the row's epoch moves, the cache forgets the account.
    expect(await bumpSessionEpoch((data as { id: string }).id)).toBeGreaterThan(0);
    // The stalled read answers with the pre-bump row: fine for the request that started before.
    release();
    expect(await inFlight).toEqual({ username: "ann_race", isAdmin: false });
    // Nothing wrote that row back: the next request reads the moved epoch.
    expect(await whoAmI(cookie)).toBeNull();
  });

  it("with no valid session has nothing to revoke, and still clears the cookie", async () => {
    const out = await post(logout, "logout", { everywhere: true });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("tells the live service, which closes the account's sockets", async () => {
    const heard: unknown[] = [];
    const server = createServer((req, res) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        heard.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(text) });
        res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("LIVE_INTERNAL_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    vi.stubEnv("LIVE_INTERNAL_TOKEN", "internal-secret");
    try {
      const made = await post(register, "register", { username: "ann_live", password: "ann-password" });
      await post(logout, "logout", { everywhere: true }, { cookie: cookieOf(made) });
      await expect.poll(() => heard.length).toBe(1);
      expect(heard[0]).toEqual({
        path: "/internal/signed-out",
        auth: "Bearer internal-secret",
        body: { userId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      });
    } finally {
      server.close();
      vi.stubEnv("LIVE_INTERNAL_URL", undefined);
      vi.stubEnv("LIVE_INTERNAL_TOKEN", undefined);
    }
  });
});
