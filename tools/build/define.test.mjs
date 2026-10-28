import { describe, expect, it } from "vitest";
import { clientDefines, CLIENT_ENV_NAMES, serverDefines } from "./define.mjs";

describe("clientDefines / serverDefines", () => {
  it("leaves an unset NEXT_PUBLIC name undefined in the browser and out of the server defines", () => {
    expect(clientDefines({})["process.env.NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL"]).toBe(
      "undefined",
    );
    expect(clientDefines({})["process.env.NEXT_PUBLIC_SITE_URL"]).toBe("undefined");
    expect(clientDefines({})["process.env.NEXT_PUBLIC_LIVE_URL"]).toBe("undefined");
    expect("process.env.NEXT_PUBLIC_SITE_URL" in serverDefines({})).toBe(false);
    expect("process.env.NEXT_PUBLIC_LIVE_URL" in serverDefines({})).toBe(false);
    expect(clientDefines({})["process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY"]).toBe('""');
    expect(serverDefines({})["process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY"]).toBe('""');
  });

  it("inlines a set name as its JSON string, an empty one included", () => {
    const env = { NEXT_PUBLIC_SITE_URL: "https://example.test", NEXT_PUBLIC_LIVE_URL: "" };
    expect(clientDefines(env)["process.env.NEXT_PUBLIC_SITE_URL"]).toBe('"https://example.test"');
    expect(clientDefines(env)["process.env.NEXT_PUBLIC_LIVE_URL"]).toBe('""');
    expect(serverDefines(env)["process.env.NEXT_PUBLIC_SITE_URL"]).toBe('"https://example.test"');
  });

  it("always defines the build id, from GTNH_BUILD_ID when given", () => {
    const env = { GTNH_BUILD_ID: "2.0.0-abcdef12" };
    expect(clientDefines(env)["process.env.NEXT_PUBLIC_GTNH_BUILD_ID"]).toBe('"2.0.0-abcdef12"');
    expect(serverDefines(env)["process.env.NEXT_PUBLIC_GTNH_BUILD_ID"]).toBe('"2.0.0-abcdef12"');
  });

  it("defines NODE_ENV for the browser only, production unless told otherwise", () => {
    expect(clientDefines({})["process.env.NODE_ENV"]).toBe('"production"');
    expect(clientDefines({}, { mode: "development" })["process.env.NODE_ENV"]).toBe(
      '"development"',
    );
    expect("process.env.NODE_ENV" in serverDefines({})).toBe(false);
  });

  it("names exactly the keys clientDefines writes", () => {
    expect(
      Object.keys(clientDefines({}))
        .map((key) => key.slice("process.env.".length))
        .sort(),
    ).toEqual([...CLIENT_ENV_NAMES].sort());
  });
});
