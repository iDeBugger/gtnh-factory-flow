import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "@/lib/version";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/version", () => {
  it("names the build it was made from", async () => {
    vi.stubEnv("NEXT_PUBLIC_GTNH_BUILD_ID", "4.4.1-5efe0a3c");
    const response = GET();
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({ version: APP_VERSION, build: "4.4.1-5efe0a3c" });
  });

  it("answers an empty build where none was baked in", async () => {
    vi.stubEnv("NEXT_PUBLIC_GTNH_BUILD_ID", undefined);
    expect(await GET().json()).toEqual({ version: APP_VERSION, build: "" });
  });
});
