import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDb, withDbFault } from "@/test-support/test-db";
import { forgetSessionUsers, makeSessionToken } from "../auth/sessions";
import { readViewer } from "./viewer";

const ADMIN = "00000000-0000-4000-8000-00000000aa01";
const PLAYER = "00000000-0000-4000-8000-00000000bb01";

const testDb = setupTestDb();

beforeAll(async () => {
  vi.stubEnv("COMMUNITY_HASH_SALT", "viewer-test-salt");
  await testDb().pglite.query(
    `insert into community_users (id, username, password_hash, is_admin) values
      ($1, 'admin', 'x:y', true), ($2, 'player', 'x:y', false)`,
    [ADMIN, PLAYER],
  );
}, 60_000);

afterAll(async () => {
  forgetSessionUsers();
  vi.unstubAllEnvs();
});

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/anything", { headers });
}

describe("readViewer", () => {
  it("reads no cookie as nobody, and no admin", async () => {
    expect(await readViewer(request())).toEqual({ isAdmin: false, adminToken: false });
  });

  it("counts the admin header only when it matches COMMUNITY_ADMIN_TOKEN", async () => {
    vi.stubEnv("COMMUNITY_ADMIN_TOKEN", "admin-secret");
    try {
      expect(await readViewer(request({ "x-admin-token": "admin-secret" }))).toEqual({
        isAdmin: false,
        adminToken: true,
      });
      expect(await readViewer(request({ "x-admin-token": "wrong" }))).toEqual({
        isAdmin: false,
        adminToken: false,
      });
    } finally {
      vi.stubEnv("COMMUNITY_ADMIN_TOKEN", "");
    }
  });

  it("reads an admin account's cookie as that account, admin by its flag", async () => {
    const cookie = `gtnh_session=${makeSessionToken(ADMIN)}`;
    expect(await readViewer(request({ cookie }))).toEqual({
      userId: ADMIN,
      username: "admin",
      isAdmin: true,
      adminToken: false,
    });
  });

  it("reads a player's cookie as a player", async () => {
    const cookie = `gtnh_session=${makeSessionToken(PLAYER)}`;
    expect(await readViewer(request({ cookie }))).toEqual({
      userId: PLAYER,
      username: "player",
      isAdmin: false,
      adminToken: false,
    });
  });

  it("throws when the account cannot be read, never reading the player as signed out", async () => {
    forgetSessionUsers();
    withDbFault(/"community_users"/, Object.assign(new Error("boom"), { code: "XX000" }));
    const cookie = `gtnh_session=${makeSessionToken(PLAYER)}`;
    await expect(readViewer(request({ cookie }))).rejects.toThrow("boom");
  });
});
