import { afterEach, describe, expect, it, vi } from "vitest";
import { isDatabaseConfigured } from "./config";

/** The configured check every database route asks first. */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isDatabaseConfigured", () => {
  it("is DATABASE_URL, whatever an earlier client's variables say", () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("LOCAL_DB", "1");
    expect(isDatabaseConfigured()).toBe(false);
    vi.stubEnv("DATABASE_URL", "postgres://gtnh_site:pw@postgres:5432/postgres");
    expect(isDatabaseConfigured()).toBe(true);
  });
});
