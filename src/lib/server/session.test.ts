import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSessionToken, readSessionCookie, verifySessionToken } from "./session";

const userId = "11111111-1111-4111-8111-111111111111";

/** A token signed offline with the development secret, as anyone reading this repository could make. */
function forgedWithDevelopmentSecret(): string {
  const payload = `${userId}.${Date.now() + 60_000}`;
  return `${payload}.${createHmac("sha256", "gtnh-factory-hub").update(payload).digest("hex")}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session tokens", () => {
  it("verify what they sign, and read from a cookie header", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "salt-a");
    const token = makeSessionToken(userId);
    expect(verifySessionToken(token)?.userId).toBe(userId);
    expect(readSessionCookie(`theme=dark; gtnh_session=${token}; other=1`)).toBe(token);
    expect(readSessionCookie("theme=dark")).toBeUndefined();
  });

  it("accept tokens made before the shared module (same format, same secret)", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "salt-a");
    const payload = `${userId}.${Date.now() + 60_000}`;
    const legacy = `${payload}.${createHmac("sha256", "salt-a").update(payload).digest("hex")}`;
    expect(verifySessionToken(legacy)).toEqual({ userId, expires: expect.any(Number), epoch: 0 });
  });

  it("refuse a changed token, another secret's token, and an expired one", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "salt-a");
    const token = makeSessionToken(userId);
    const [, expires, signature] = token.split(".");
    expect(
      verifySessionToken(`22222222-2222-4222-8222-222222222222.${expires}.${signature}`),
    ).toBeUndefined();
    expect(
      verifySessionToken(`${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`),
    ).toBeUndefined();
    expect(verifySessionToken("not-a-token")).toBeUndefined();
    vi.stubEnv("COMMUNITY_HASH_SALT", "salt-b");
    expect(verifySessionToken(token)).toBeUndefined();
    vi.stubEnv("COMMUNITY_HASH_SALT", "salt-a");
    const old = makeSessionToken(userId, 0, Date.now() - 200 * 24 * 60 * 60 * 1000);
    expect(verifySessionToken(old)).toBeUndefined();
  });

  it("carry the account's epoch, and a token from before epochs reads as 0", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "salt-a");
    const token = makeSessionToken(userId, 5);
    expect(token.split(".")).toHaveLength(4);
    expect(verifySessionToken(token)).toEqual({ userId, expires: expect.any(Number), epoch: 5 });
    const [id, expires, , signature] = token.split(".");
    expect(verifySessionToken(`${id}.${expires}.6.${signature}`)).toBeUndefined();
    expect(verifySessionToken(`${id}.${expires}.${signature}`)).toBeUndefined();
    const payload = `${userId}.${Date.now() + 60_000}`;
    const legacy = `${payload}.${createHmac("sha256", "salt-a").update(payload).digest("hex")}`;
    expect(verifySessionToken(legacy)?.epoch).toBe(0);
    expect(verifySessionToken(`${payload}.0.${legacy.split(".")[2]}`)).toBeUndefined();
  });

  it("refuse to sign or verify without a real secret in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const forged = forgedWithDevelopmentSecret();
    for (const salt of [undefined, "", "  ", "gtnh-factory-hub"]) {
      vi.stubEnv("COMMUNITY_HASH_SALT", salt);
      expect(() => makeSessionToken(userId), `salt ${JSON.stringify(salt)}`).toThrow(/Sign-in is not set up/);
      expect(() => verifySessionToken(forged), `salt ${JSON.stringify(salt)}`).toThrow(/Sign-in is not set up/);
    }
    vi.stubEnv("COMMUNITY_HASH_SALT", "a real secret");
    expect(verifySessionToken(forged)).toBeUndefined();
    expect(verifySessionToken(makeSessionToken(userId))?.userId).toBe(userId);
  });

  it("sign with the development secret outside production, so a checkout needs no setup", () => {
    // This is why production must refuse: the development secret is public.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("COMMUNITY_HASH_SALT", undefined);
    expect(verifySessionToken(makeSessionToken(userId))?.userId).toBe(userId);
    expect(verifySessionToken(forgedWithDevelopmentSecret())?.userId).toBe(userId);
  });
});
