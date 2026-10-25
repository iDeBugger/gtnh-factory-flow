import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildId, readAppVersion, sameFile, waitForBuild } from "./deploy-lib.mjs";

/** A fetch that answers each body in turn, then the last one for ever. */
function answering(...bodies) {
  let calls = 0;
  const fetch = async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)];
    calls += 1;
    return Response.json(body);
  };
  return { fetch, calls: () => calls };
}

describe("the deploy's checks", () => {
  it("reads APP_VERSION from version.ts", () => {
    const source = readFileSync(new URL("../../src/lib/version.ts", import.meta.url), "utf8");
    expect(readAppVersion(source)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readAppVersion('export const APP_VERSION = "4.4.1";')).toBe("4.4.1");
    expect(() => readAppVersion("nothing here")).toThrow();
  });

  it("builds the id from the version and the commit", () => {
    expect(buildId("4.4.1", "5efe0a3c1234")).toBe("4.4.1-5efe0a3c");
    expect(() => buildId("4.4.1", "not-a-sha")).toThrow();
  });

  it("waits until the server names this build", async () => {
    const old = { version: "4.4.1", build: "4.4.1-00000000" };
    const fresh = { version: "4.4.1", build: "4.4.1-5efe0a3c" };
    const server = answering(old, old, fresh);
    await waitForBuild("https://site/api/version", fresh, {
      timeoutMs: 5000,
      intervalMs: 1,
      fetch: server.fetch,
    });
    expect(server.calls()).toBe(3);
  });

  it("fails when the old build stays", async () => {
    const server = answering({ version: "4.4.0", build: "4.4.0-11111111" });
    await expect(
      waitForBuild(
        "https://site/api/version",
        { version: "4.4.1", build: "4.4.1-5efe0a3c" },
        { timeoutMs: 30, intervalMs: 5, fetch: server.fetch },
      ),
    ).rejects.toThrow(/4\.4\.0-11111111/);
  });

  it("fails when the version matches but the build does not", async () => {
    const server = answering({ version: "4.4.1", build: "4.4.1-11111111" });
    await expect(
      waitForBuild(
        "https://site/api/version",
        { version: "4.4.1", build: "4.4.1-5efe0a3c" },
        { timeoutMs: 30, intervalMs: 5, fetch: server.fetch },
      ),
    ).rejects.toThrow(/never named build 4\.4\.1-5efe0a3c.*build 4\.4\.1-11111111/);
  });

  it("keeps waiting through errors and names the last one", async () => {
    const fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(
      waitForBuild(
        "https://site/api/version",
        { version: "1", build: "1-x" },
        { timeoutMs: 20, intervalMs: 5, fetch },
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("tells two compose files apart", () => {
    expect(sameFile("name: gtnh\n", "name: gtnh\n")).toBe(true);
    expect(sameFile("name: gtnh\n", "name: gtnh\n\n")).toBe(false);
    expect(sameFile(Buffer.from("a"), Buffer.from("a"))).toBe(true);
  });
});
