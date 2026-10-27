import { afterEach, describe, expect, it, vi } from "vitest";
import { isAdminRequest } from "./admin";
import { sameSecret } from "./secret";

afterEach(() => {
  vi.unstubAllEnvs();
});

const withAdminHeader = (value?: string) =>
  new Request("http://t/", { headers: value === undefined ? {} : { "x-admin-token": value } });

describe("shared secrets", () => {
  it("match only the whole configured value, and nothing when none is configured", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("ab", "abc")).toBe(false);
    expect(sameSecret("abcd", "abc")).toBe(false);
    expect(sameSecret("", "abc")).toBe(false);
    expect(sameSecret(null, "abc")).toBe(false);
    expect(sameSecret("abc", undefined)).toBe(false);
    expect(sameSecret("", "")).toBe(false);
  });

  it("the admin header is checked in constant time and only when a token is set", () => {
    vi.stubEnv("COMMUNITY_ADMIN_TOKEN", "abc");
    expect(isAdminRequest(withAdminHeader("abc"))).toBe(true);
    expect(isAdminRequest(withAdminHeader("ab"))).toBe(false);
    expect(isAdminRequest(withAdminHeader("abcd"))).toBe(false);
    expect(isAdminRequest(withAdminHeader(""))).toBe(false);
    expect(isAdminRequest(withAdminHeader())).toBe(false);
    vi.stubEnv("COMMUNITY_ADMIN_TOKEN", undefined);
    expect(isAdminRequest(withAdminHeader("abc"))).toBe(false);
    expect(isAdminRequest(withAdminHeader(""))).toBe(false);
    vi.stubEnv("COMMUNITY_ADMIN_TOKEN", "");
    expect(isAdminRequest(withAdminHeader(""))).toBe(false);
  });
});
