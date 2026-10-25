import { describe, expect, it } from "vitest";
import { checkDeployEnv, parseEnvFile } from "./check-env.mjs";
import { signServiceToken } from "./service-token.mjs";

const JWT_SECRET = "f".repeat(64);
const complete = () => ({
  POSTGRES_PASSWORD: "postgres-password-value",
  POSTGREST_AUTHENTICATOR_PASSWORD: "authenticator-password-value",
  POSTGREST_JWT_SECRET: JWT_SECRET,
  POSTGREST_SERVICE_TOKEN: signServiceToken(JWT_SECRET),
  COMMUNITY_HASH_SALT: "0123456789abcdef0123456789abcdef0123456789",
  LIVE_INTERNAL_TOKEN: "internal-token-0123456789abcdef0123456789",
  LIVE_ALLOWED_ORIGINS: "https://stage.gtnhplanner.idebugger.net",
  LIVE_TRUSTED_PROXIES: "172.30.61.1",
  NEXT_PUBLIC_MOD_AND_COMMUNITY: "",
  GTNH_TAG: "4.4.1-5efe0a3c",
});
const stage = { modAndCommunity: "" };

describe("the deploy's env check", () => {
  it("accepts a complete env", () => {
    expect(checkDeployEnv(complete(), stage)).toEqual([]);
  });

  it("names each missing variable", () => {
    const problems = checkDeployEnv({}, stage);
    for (const name of [
      "POSTGRES_PASSWORD",
      "POSTGREST_SERVICE_TOKEN",
      "LIVE_TRUSTED_PROXIES",
      "GTNH_TAG",
    ]) {
      expect(problems).toContain(`${name} is not set.`);
    }
  });

  it("refuses a short salt", () => {
    const problems = checkDeployEnv({ ...complete(), COMMUNITY_HASH_SALT: "short-salt" }, stage);
    expect(problems).toEqual([expect.stringMatching(/^COMMUNITY_HASH_SALT is shorter than 32/)]);
  });

  it("refuses a service token from another secret", () => {
    const problems = checkDeployEnv(
      { ...complete(), POSTGREST_SERVICE_TOKEN: signServiceToken("e".repeat(64)) },
      stage,
    );
    expect(problems).toEqual([
      expect.stringMatching(/^POSTGREST_SERVICE_TOKEN is not a service_role token/),
    ]);
  });

  it("refuses LOCAL_DB", () => {
    expect(checkDeployEnv({ ...complete(), LOCAL_DB: "1" }, stage)).toEqual([
      "LOCAL_DB must not be set on a deployed stack.",
    ]);
    expect(checkDeployEnv({ ...complete(), NODE_ENV: "development" }, stage)).toEqual([
      "NODE_ENV must not be set on a deployed stack.",
    ]);
  });

  it("refuses a switch that differs from the image", () => {
    expect(checkDeployEnv({ ...complete(), NEXT_PUBLIC_MOD_AND_COMMUNITY: "on" }, stage)).toEqual([
      expect.stringMatching(/^NEXT_PUBLIC_MOD_AND_COMMUNITY differs/),
    ]);
    expect(checkDeployEnv(complete(), { modAndCommunity: "on" })).toHaveLength(1);
    expect(
      checkDeployEnv(
        { ...complete(), NEXT_PUBLIC_MOD_AND_COMMUNITY: "on" },
        { modAndCommunity: "on" },
      ),
    ).toEqual([]);
  });

  it("refuses an origin that is not https, unless rehearsing", () => {
    const env = { ...complete(), LIVE_ALLOWED_ORIGINS: "http://127.0.0.1:3300" };
    expect(checkDeployEnv(env, stage)).toEqual([expect.stringMatching(/^LIVE_ALLOWED_ORIGINS/)]);
    expect(checkDeployEnv(env, stage, { rehearsal: true })).toEqual([]);
    expect(
      checkDeployEnv({ ...complete(), LIVE_ALLOWED_ORIGINS: "https://a.example/path" }, stage),
    ).toHaveLength(1);
  });

  it("refuses a trusted subnet wider than /24", () => {
    expect(checkDeployEnv({ ...complete(), LIVE_TRUSTED_PROXIES: "172.30.0.0/16" }, stage)).toEqual(
      [expect.stringMatching(/^LIVE_TRUSTED_PROXIES holds a subnet wider than \/24/)],
    );
    expect(
      checkDeployEnv({ ...complete(), LIVE_TRUSTED_PROXIES: "172.30.61.0/24, ::1" }, stage),
    ).toEqual([]);
    expect(
      checkDeployEnv({ ...complete(), LIVE_TRUSTED_PROXIES: "172.30.61.1,nonsense" }, stage),
    ).toEqual([expect.stringMatching(/^LIVE_TRUSTED_PROXIES holds an entry that is not/)]);
  });

  it("never prints a value", () => {
    const env = {
      ...complete(),
      COMMUNITY_HASH_SALT: "s3cr3t-salt",
      LIVE_INTERNAL_TOKEN: "s3cr3t-token",
      POSTGREST_JWT_SECRET: "s3cr3t-jwt",
      POSTGREST_SERVICE_TOKEN: "s3cr3t.service.token",
      LIVE_ALLOWED_ORIGINS: "s3cr3t-origin",
      LIVE_TRUSTED_PROXIES: "s3cr3t-proxy",
      NEXT_PUBLIC_MOD_AND_COMMUNITY: "s3cr3t-switch",
      LOCAL_DB: "s3cr3t-local",
    };
    const problems = checkDeployEnv(env, stage);
    expect(problems.length).toBeGreaterThan(5);
    for (const problem of problems) {
      expect(problem).not.toMatch(/s3cr3t/);
    }
  });

  it("reads env files as compose does", () => {
    expect(parseEnvFile("# note\nA=1\n\nB=\"two words\"\nC='x=y'\nD=\n")).toEqual({
      A: "1",
      B: "two words",
      C: "x=y",
      D: "",
    });
  });
});
