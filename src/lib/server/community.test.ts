import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeActorKey } from "./auth/keys";

/** A request as the rate limits see it: only the address matters. */
function from(address: string, deviceId?: string): Request {
  return new Request("http://localhost/api/community/images", {
    method: "POST",
    headers: { "x-client-ip": address, ...(deviceId ? { "x-device-id": deviceId } : {}) },
  });
}

beforeAll(() => {
  vi.stubEnv("COMMUNITY_HASH_SALT", "community-test-salt");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("the actor key", () => {
  it("is the address and nothing the client chooses", () => {
    expect(makeActorKey(from("203.0.113.5"))).toBe(makeActorKey(from("203.0.113.5", "another-device")));
    expect(makeActorKey(from("203.0.113.5"))).not.toBe(makeActorKey(from("203.0.113.6")));
    // One argument: a device id has no way in (the old second parameter is gone for good).
    expect(makeActorKey.length).toBe(1);
  });
});
