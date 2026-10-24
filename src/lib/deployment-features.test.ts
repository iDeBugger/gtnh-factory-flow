import { afterEach, describe, expect, test, vi } from "vitest";
import nextConfig from "../../next.config";
import { isModAndCommunityOn } from "./deployment-features";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("unset", () => {
  withModAndCommunityUnset();
  test("unset means off", () => {
    expect(process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY).toBeUndefined();
    expect(isModAndCommunityOn()).toBe(false);
  });
});

test("any value but on is off", () => {
  for (const value of ["yes", "true", "1", "", "off", "onn"]) {
    vi.stubEnv("NEXT_PUBLIC_MOD_AND_COMMUNITY", value);
    expect(isModAndCommunityOn()).toBe(false);
  }
});

test("on turns them on", () => {
  vi.stubEnv("NEXT_PUBLIC_MOD_AND_COMMUNITY", "on");
  expect(isModAndCommunityOn()).toBe(true);
  vi.stubEnv("NEXT_PUBLIC_MOD_AND_COMMUNITY", " ON ");
  expect(isModAndCommunityOn()).toBe(true);
});

test("it is read at each call, not cached", () => {
  vi.stubEnv("NEXT_PUBLIC_MOD_AND_COMMUNITY", "on");
  expect(isModAndCommunityOn()).toBe(true);
  vi.stubEnv("NEXT_PUBLIC_MOD_AND_COMMUNITY", "off");
  expect(isModAndCommunityOn()).toBe(false);
});

describe("the on helper", () => {
  withModAndCommunityOn();
  test("turns them on for each test", () => {
    expect(isModAndCommunityOn()).toBe(true);
  });
});

test("next.config always defines the setting, so a build inlines its value in both bundles", () => {
  // An undefined variable is left as a run-time read by the bundler, and the server's build-and-process check
  // would then read the process twice.
  expect(typeof nextConfig.env?.NEXT_PUBLIC_MOD_AND_COMMUNITY).toBe("string");
});
