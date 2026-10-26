import { afterEach, describe, expect, it, vi } from "vitest";
import { checkServerSetup, checkServerSetupOrExit } from "./startup-checks";

afterEach(() => {
  vi.unstubAllEnvs();
});

const UNREAD = [
  "POSTGREST_URL",
  "POSTGREST_SERVICE_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "LOCAL_DB",
];

/** Clears what a developer's shell may set that adds a warning of its own. */
function quiet(): void {
  for (const name of UNREAD) vi.stubEnv(name, "");
  vi.stubEnv("GTNH_MAX_LOADED_RECIPE_SHARDS", "");
  vi.stubEnv("DATABASE_URL", "postgres://gtnh_site:pw@postgres:5432/postgres");
}

/** Runs the checks with nothing else that warns, collecting what they say. */
function warnings(): string[] {
  quiet();
  const lines: string[] = [];
  checkServerSetup((message) => lines.push(message));
  return lines;
}

describe("the server's startup checks", () => {
  it("end the process when one fails, rather than leaving a server that answers 500", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "a real secret of some length");
    quiet();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("a check failed");
    });
    try {
      vi.stubEnv("LOCAL_DB", "1");
      checkServerSetupOrExit();
      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledWith("a check failed");
      vi.stubEnv("LOCAL_DB", "");
      checkServerSetupOrExit();
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("warn, and do not throw, when the secret is missing or blank", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const salt of [undefined, "", "  "]) {
      vi.stubEnv("COMMUNITY_HASH_SALT", salt);
      expect(() => checkServerSetup(() => undefined)).not.toThrow();
      expect(warnings()).toEqual([
        expect.stringMatching(/COMMUNITY_HASH_SALT is not set: sign-in, the library and blueprints are off/),
      ]);
    }
    vi.stubEnv("COMMUNITY_HASH_SALT", "a real secret of some length");
    expect(warnings()).toEqual([]);
  });

  it("warn about a short secret", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "short");
    expect(warnings()).toEqual([expect.stringMatching(/shorter than 16 characters/)]);
    vi.stubEnv("COMMUNITY_HASH_SALT", "0123456789abcdef0123456789abcdef");
    expect(warnings()).toEqual([]);
  });

  it("warn that the old shard count limit is ignored, naming the MB one", () => {
    quiet();
    vi.stubEnv("COMMUNITY_HASH_SALT", "a real secret of some length");
    const warnings: string[] = [];
    vi.stubEnv("GTNH_MAX_LOADED_RECIPE_SHARDS", "8");
    checkServerSetup((message) => warnings.push(message));
    expect(warnings).toEqual([
      expect.stringMatching(/GTNH_MAX_LOADED_RECIPE_SHARDS is ignored.*GTNH_MAX_LOADED_RECIPE_SHARD_MB/),
    ]);
    vi.stubEnv("GTNH_MAX_LOADED_RECIPE_SHARDS", "");
    checkServerSetup((message) => warnings.push(message));
    expect(warnings).toHaveLength(1);
  });

  it("warn in production without DATABASE_URL, and never throw for it", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "a real secret of some length");
    quiet();
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const lines: string[] = [];
    expect(() => checkServerSetup((message) => lines.push(message))).not.toThrow();
    expect(lines).toEqual([
      "[db] DATABASE_URL is not set: accounts, the library and blueprints are off.",
    ]);
    vi.stubEnv("NODE_ENV", "development");
    checkServerSetup((message) => lines.push(message));
    expect(lines).toHaveLength(1);
  });

  it("name DATABASE_URL when a variable of an earlier database client is set", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "a real secret of some length");
    for (const name of UNREAD) {
      quiet();
      vi.stubEnv(name, "1");
      vi.stubEnv("NODE_ENV", "production");
      const lines: string[] = [];
      expect(() => checkServerSetup((message) => lines.push(message))).not.toThrow();
      expect(lines).toEqual([`[db] ${name} is not read: set DATABASE_URL.`]);
    }
  });
});
