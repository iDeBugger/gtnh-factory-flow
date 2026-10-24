import { afterEach, describe, expect, it, vi } from "vitest";
import { checkServerSetup } from "./startup-checks";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the server's startup checks", () => {
  it("refuse the local database in production", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "set");
    vi.stubEnv("LOCAL_DB", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => checkServerSetup(() => undefined)).toThrow(/LOCAL_DB=1/);
    vi.stubEnv("NODE_ENV", "development");
    expect(() => checkServerSetup(() => undefined)).not.toThrow();
  });

  it("warn when sessions would be signed with the fallback secret", () => {
    vi.stubEnv("LOCAL_DB", "");
    const warnings: string[] = [];
    vi.stubEnv("COMMUNITY_HASH_SALT", "");
    // A developer's shell may set the old shard limit, which adds its own warning.
    vi.stubEnv("GTNH_MAX_LOADED_RECIPE_SHARDS", "");
    checkServerSetup((message) => warnings.push(message));
    expect(warnings).toEqual([expect.stringMatching(/COMMUNITY_HASH_SALT is not set/)]);
    vi.stubEnv("COMMUNITY_HASH_SALT", "a real secret");
    checkServerSetup((message) => warnings.push(message));
    expect(warnings).toHaveLength(1);
  });

  it("warn that the old shard count limit is ignored, naming the MB one", () => {
    vi.stubEnv("LOCAL_DB", "");
    vi.stubEnv("COMMUNITY_HASH_SALT", "a real secret");
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
