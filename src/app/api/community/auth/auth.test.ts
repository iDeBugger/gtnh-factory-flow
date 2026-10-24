import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { forgetSessionUsers, resetDbBreaker } from "@/lib/server/community";
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
  useInProcessLocalDb(local.handle);
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
