import { afterEach, describe, expect, it, vi } from "vitest";
import { isDatabaseConfigured } from "./config";

/** The configured check every database route asks first. */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isDatabaseConfigured", () => {
  it("needs DATABASE_URL as well as the PostgREST settings", () => {
    vi.stubEnv("LOCAL_DB", "");
    vi.stubEnv("POSTGREST_URL", "http://postgrest:3000");
    vi.stubEnv("POSTGREST_SERVICE_TOKEN", "token");
    vi.stubEnv("DATABASE_URL", "");
    expect(isDatabaseConfigured()).toBe(false);
    vi.stubEnv("DATABASE_URL", "postgres://gtnh_site:pw@postgres:5432/postgres");
    expect(isDatabaseConfigured()).toBe(true);
    vi.stubEnv("POSTGREST_URL", "");
    expect(isDatabaseConfigured()).toBe(false);
  });

  it("needs DATABASE_URL beside the local database too", () => {
    vi.stubEnv("LOCAL_DB", "1");
    vi.stubEnv("DATABASE_URL", "");
    expect(isDatabaseConfigured()).toBe(false);
    vi.stubEnv("DATABASE_URL", "postgres://postgres@127.0.0.1:54330/postgres");
    expect(isDatabaseConfigured()).toBe(true);
  });
});
