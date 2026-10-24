import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeVoterKey, saltedKey } from "./community";

/**
 * The rate-limit and voter keys are salted with the session secret: one
 * variable, one rule, so a production server without it has no public salt
 * either. No database: a voter key with no cookie never looks a session up.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("salted keys", () => {
  it("hash the text with COMMUNITY_HASH_SALT", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "s");
    expect(saltedKey("x")).toBe(createHash("sha256").update("s:x").digest("hex").slice(0, 32));
  });

  it("key an anonymous vote by the device, through the same hash", async () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "s");
    expect(await makeVoterKey(new Request("http://t/"), "dev-1")).toBe(saltedKey("device:dev-1"));
  });

  it("refuse in production without a real secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COMMUNITY_HASH_SALT", undefined);
    expect(() => saltedKey("x")).toThrow(/Sign-in is not set up/);
  });
});
