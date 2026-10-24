import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { forgetSessionUsers, getCommunityDb, hashPassword, resetDbBreaker } from "@/lib/server/community";
import { POST } from "./route";

/**
 * Sign-in limits, against the local database: ten failures lock an account
 * from every address for the window, successes never count, a name nobody
 * has is counted the same way, one address has twenty attempts in ten
 * minutes, and a burst is counted one by one.
 */

let local: LocalDatabase;

const LOCKED = { error: "Too many attempts for this account. Try again in 15 minutes." };
const WRONG = { error: "Wrong username or password." };

async function makeUser(username: string, password: string) {
  const { error } = await getCommunityDb()
    .from("community_users")
    .insert({ username, password_hash: await hashPassword(password) });
  expect(error).toBeNull();
}

function signIn(username: string, password: string, address: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/community/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-ip": address },
      body: JSON.stringify({ username, password }),
    }),
  );
}

async function expectAnswer(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
}

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "login-test-salt");
  local = await openLocalDatabase();
  useInProcessLocalDb(local.handle);
  await Promise.all([
    makeUser("ann", "ann-password"),
    makeUser("bob", "bob-password"),
    makeUser("carol", "carol-password"),
    makeUser("dan", "dan-password"),
  ]);
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

describe("the sign-in limits", () => {
  it("lock an account after ten wrong passwords, whatever the address", async () => {
    for (let i = 1; i <= 10; i += 1) {
      await expectAnswer(await signIn("ann", "wrong", `10.0.0.${i}`), 401, WRONG);
    }
    await expectAnswer(await signIn("ann", "wrong", "10.0.0.11"), 429, LOCKED);
    await expectAnswer(await signIn("ann", "ann-password", "10.0.0.12"), 429, LOCKED);
  }, 30_000);

  it("count failures only, and only against that account", async () => {
    const bob = await signIn("bob", "bob-password", "10.0.0.1");
    expect(bob.status).toBe(200);
    expect(await bob.json()).toEqual({ username: "bob", isAdmin: false });
    expect(bob.headers.get("set-cookie")).toMatch(/^gtnh_session=[^;]+; /);
    for (let i = 1; i <= 9; i += 1) {
      await expectAnswer(await signIn("carol", "wrong", `10.0.1.${i}`), 401, WRONG);
    }
    expect((await signIn("carol", "carol-password", "10.0.1.10")).status).toBe(200);
  }, 30_000);

  it("count a name nobody has, so the limit says nothing about which names exist", async () => {
    for (let i = 1; i <= 10; i += 1) {
      await expectAnswer(await signIn("nobody", "wrong", `10.0.2.${i}`), 401, WRONG);
    }
    await expectAnswer(await signIn("nobody", "wrong", "10.0.2.11"), 429, LOCKED);
  }, 30_000);

  it("limit one address to twenty attempts in ten minutes", async () => {
    for (let i = 1; i <= 20; i += 1) {
      await expectAnswer(await signIn(`name-${i}`, "wrong", "10.0.0.50"), 401, WRONG);
    }
    await expectAnswer(await signIn("name-21", "wrong", "10.0.0.50"), 429, {
      error: "Too many attempts. Slow down.",
    });
  }, 30_000);

  it("count a burst from many addresses one by one", async () => {
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, i) => signIn("dan", "wrong", `10.0.3.${i + 1}`)),
    );
    const statuses = answers.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(30);
    await expectAnswer(await signIn("dan", "dan-password", "10.0.3.41"), 429, LOCKED);
  }, 30_000);
});
