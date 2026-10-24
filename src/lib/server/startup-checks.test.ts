import { afterEach, describe, expect, it, vi } from "vitest";
import { checkServerSetup } from "./startup-checks";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Runs the checks with nothing else that warns, collecting what they say. */
function warnings(): string[] {
  vi.stubEnv("LOCAL_DB", "");
  // A developer's shell may set the old shard limit, which adds its own warning.
  vi.stubEnv("GTNH_MAX_LOADED_RECIPE_SHARDS", "");
  const lines: string[] = [];
  checkServerSetup((message) => lines.push(message));
  return lines;
}

describe("the server's startup checks", () => {
  it("refuse the local database in production", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "set");
    vi.stubEnv("LOCAL_DB", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => checkServerSetup(() => undefined)).toThrow(/LOCAL_DB=1/);
    vi.stubEnv("NODE_ENV", "development");
    expect(() => checkServerSetup(() => undefined)).not.toThrow();
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
    vi.stubEnv("LOCAL_DB", "");
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
});
