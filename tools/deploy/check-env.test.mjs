import { describe, expect, it } from "vitest";
import { checkDeployEnv, parseEnvFile } from "./check-env.mjs";

const complete = () => ({
  POSTGRES_PASSWORD: "postgres-password-value",
  GTNH_SITE_DB_PASSWORD: "a".repeat(64),
  GTNH_LIVE_DB_PASSWORD: "b".repeat(64),
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
      "GTNH_SITE_DB_PASSWORD",
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

  it("needs no PostgREST variable, and refuses each one still present, by name", () => {
    const problems = checkDeployEnv({}, stage);
    expect(problems.filter((problem) => problem.includes("POSTGREST"))).toEqual([]);
    const leftover = {
      ...complete(),
      POSTGREST_SERVICE_TOKEN: "s3cr3t.service.token",
      POSTGREST_AUTHENTICATOR_PASSWORD: "s3cr3t-authenticator",
      POSTGREST_JWT_SECRET: "",
      POSTGREST_URL: "http://postgrest:3000",
    };
    const refused = checkDeployEnv(leftover, stage);
    expect(refused).toEqual([
      "POSTGREST_AUTHENTICATOR_PASSWORD belongs to PostgREST, which this stack no longer runs: remove it.",
      "POSTGREST_JWT_SECRET belongs to PostgREST, which this stack no longer runs: remove it.",
      "POSTGREST_SERVICE_TOKEN belongs to PostgREST, which this stack no longer runs: remove it.",
      "POSTGREST_URL belongs to PostgREST, which this stack no longer runs: remove it.",
    ]);
    for (const problem of refused) {
      expect(problem).not.toMatch(/s3cr3t/);
    }
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

  it("refuses a password a connection URI would break on", () => {
    for (const bad of ["pa/ss", "p@ss", "pa:ss", "pa?ss", "pa#ss", "pa+ss="]) {
      expect(checkDeployEnv({ ...complete(), POSTGRES_PASSWORD: bad }, stage)).toEqual([
        expect.stringMatching(/^POSTGRES_PASSWORD holds characters/),
      ]);
    }
  });

  it("refuses an app role password that is missing, short or not URI-safe, by name", () => {
    for (const name of ["GTNH_SITE_DB_PASSWORD", "GTNH_LIVE_DB_PASSWORD"]) {
      const missing = complete();
      delete missing[name];
      expect(checkDeployEnv(missing, stage)).toEqual([`${name} is not set.`]);
      expect(checkDeployEnv({ ...complete(), [name]: "" }, stage)).toEqual([`${name} is not set.`]);
      const short = "s3cr3t".repeat(5);
      const shortProblems = checkDeployEnv({ ...complete(), [name]: short }, stage);
      expect(shortProblems).toEqual([
        `${name} is shorter than 32 characters: use openssl rand -hex 32.`,
      ]);
      const unsafe = `s3cr3t/${"c".repeat(40)}`;
      const unsafeProblems = checkDeployEnv({ ...complete(), [name]: unsafe }, stage);
      expect(unsafeProblems).toEqual([
        `${name} holds characters a connection URI breaks on: use openssl rand -hex 32.`,
      ]);
      for (const problem of [...shortProblems, ...unsafeProblems]) {
        expect(problem).not.toMatch(/s3cr3t/);
      }
    }
  });

  it("refuses an IPv4-mapped trusted proxy, which no peer would match", () => {
    expect(
      checkDeployEnv({ ...complete(), LIVE_TRUSTED_PROXIES: "::ffff:172.30.61.1" }, stage),
    ).toEqual([expect.stringMatching(/IPv4-mapped/)]);
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
    expect(
      parseEnvFile('# note\nA=1\n\nB="two words"\nC=\'x=y\'\nD=\nE=value # a note\nF="a # kept"\n'),
    ).toEqual({
      A: "1",
      B: "two words",
      C: "x=y",
      D: "",
      E: "value",
      F: "a # kept",
    });
  });
});
