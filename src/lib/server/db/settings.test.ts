import { describe, expect, it } from "vitest";
import { dbSettings } from "./settings";

describe("the pool settings", () => {
  const env = { DATABASE_URL: "postgres://gtnh_site:pw@postgres:5432/postgres" };

  it("size each process's pool, overridable", () => {
    expect(dbSettings("site", env).max).toBe(10);
    expect(dbSettings("live", env).max).toBe(6);
    expect(dbSettings("site", { ...env, DATABASE_POOL_MAX: "3" }).max).toBe(3);
    expect(dbSettings("live", { ...env, DATABASE_POOL_MAX: "x" }).max).toBe(6);
    expect(dbSettings("site", { ...env, DATABASE_POOL_IDLE_MS: "1000" }).idleTimeoutMillis).toBe(
      1000,
    );
    expect(dbSettings("site", env).idleTimeoutMillis).toBe(30_000);
  });

  it("bound every wait, run the session in UTC and name the process", () => {
    const site = dbSettings("site", env);
    expect(site.connectionString).toBe(env.DATABASE_URL);
    expect(site.options).toBe(
      "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=10000 -c lock_timeout=5000 -c TimeZone=UTC",
    );
    expect(site.query_timeout).toBe(20_000);
    expect(site.connectionTimeoutMillis).toBe(5_000);
    expect(site.application_name).toBe("gtnh-site");
    expect(dbSettings("live", env).application_name).toBe("gtnh-live");
  });
});
