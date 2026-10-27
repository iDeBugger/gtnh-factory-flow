import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTestDb } from "@/test-support/test-db";
import { checkRateLimit, serially } from "./limits/rate-limit";

/**
 * The database-backed limits count then record, so requests for one key that
 * arrive together must take turns or they all read a count under the limit.
 */

useTestDb();

beforeAll(() => {
  vi.stubEnv("COMMUNITY_HASH_SALT", "rate-limit-test-salt");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("the rate limit", () => {
  it("lets a burst through one at a time", async () => {
    const answers = await Promise.all(Array.from({ length: 30 }, () => checkRateLimit("k", "probe", 5, 60)));
    expect(answers.filter(Boolean)).toHaveLength(5);
    expect(await checkRateLimit("k", "probe", 5, 60)).toBe(false);
    expect(await checkRateLimit("other", "probe", 5, 60)).toBe(true);
  });
});

describe("serially", () => {
  it("runs work under one key in order, and goes on after a failure", async () => {
    const order: string[] = [];
    const slow = serially("s", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first");
      throw new Error("first failed");
    });
    const next = serially("s", async () => {
      order.push("second");
      return 2;
    });
    const elsewhere = serially("t", async () => {
      order.push("other key");
      return 3;
    });
    await expect(slow).rejects.toThrow("first failed");
    expect(await next).toBe(2);
    expect(await elsewhere).toBe(3);
    expect(order).toEqual(["other key", "first", "second"]);
  });
});
