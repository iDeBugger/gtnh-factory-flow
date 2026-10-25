import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "./sessions";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the session cookie", () => {
  it("is Secure in production, when it stores and when it clears", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieHeader("t")).toBe(
      "gtnh_session=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000; Secure",
    );
    expect(sessionCookieHeader("", true)).toBe("gtnh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  });

  it("is not Secure elsewhere, so a checkout over http://localhost signs in", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(sessionCookieHeader("t")).not.toContain("Secure");
    expect(sessionCookieHeader("", true)).not.toContain("Secure");
    expect(sessionCookieHeader("t")).toBe("gtnh_session=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000");
  });
});
