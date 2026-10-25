import { afterEach, describe, expect, it, vi } from "vitest";
import { siteHost, siteUrl } from "./site-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("siteUrl", () => {
  it("uses the configured origin without a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stage.gtnhplanner.idebugger.net/");
    expect(siteUrl()).toBe("https://stage.gtnhplanner.idebugger.net");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stage.gtnhplanner.idebugger.net");
    expect(siteUrl()).toBe("https://stage.gtnhplanner.idebugger.net");
  });

  it("falls back to localhost when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    expect(siteUrl()).toBe("http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "  ");
    expect(siteUrl()).toBe("http://localhost:3000");
  });
});

describe("siteHost", () => {
  it("is the configured origin's host, port included", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stage.gtnhplanner.idebugger.net/");
    expect(siteHost()).toBe("stage.gtnhplanner.idebugger.net");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3560");
    expect(siteHost()).toBe("localhost:3560");
  });

  it("is nothing when unset, blank or not a URL: never a fallback host", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    expect(siteHost()).toBeUndefined();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "  ");
    expect(siteHost()).toBeUndefined();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url");
    expect(siteHost()).toBeUndefined();
  });
});
