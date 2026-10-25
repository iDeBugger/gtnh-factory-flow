import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "../local-db/database";
import { useInProcessLocalDb } from "../local-db/client";
import { forgetSessionUsers, makeSessionToken } from "../auth/sessions";
import { readViewer } from "./viewer";

const ADMIN = "00000000-0000-4000-8000-00000000aa01";
const PLAYER = "00000000-0000-4000-8000-00000000bb01";

let local: LocalDatabase;

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "viewer-test-salt");
  local = await openLocalDatabase();
  useInProcessLocalDb(local.handle);
  await local.db.query(
    `insert into community_users (id, username, password_hash, is_admin) values
      ($1, 'admin', 'x:y', true), ($2, 'player', 'x:y', false)`,
    [ADMIN, PLAYER],
  );
}, 60_000);

afterAll(async () => {
  useInProcessLocalDb(undefined);
  forgetSessionUsers();
  await local?.close();
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
    useInProcessLocalDb(async () => Response.json({ message: "boom", code: "XX000" }, { status: 400 }));
    try {
      const cookie = `gtnh_session=${makeSessionToken(PLAYER)}`;
      await expect(readViewer(request({ cookie }))).rejects.toThrow("boom");
    } finally {
      useInProcessLocalDb(local.handle);
      forgetSessionUsers();
    }
  });
});
