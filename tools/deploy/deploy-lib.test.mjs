import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildId,
  datasetIconProblems,
  neiOrderVerdict,
  readAppVersion,
  sameFile,
  waitForBuild,
} from "./deploy-lib.mjs";

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

  it("refuses a dataset that would lose the NEI order the server serves, and warns about one without", () => {
    expect(neiOrderVerdict("v", { local: true, served: true })).toMatchObject({ ok: true });
    expect(neiOrderVerdict("v", { local: false, served: true })).toMatchObject({ ok: false });
    expect(neiOrderVerdict("v", { local: false, served: true, allowLoss: true })).toMatchObject({ ok: true });
    expect(neiOrderVerdict("v", { local: false, served: false }).message).toMatch(/^WARNING: v has NO NEI order/);
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

describe("the publish's icon check", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A built version directory: the index gzips, a shard, and the icon report. */
  function version({ report, slot }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-gate-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "textures", "rendered"), { recursive: true });
    fs.mkdirSync(path.join(dir, "recipes-shards"));
    if (report !== undefined) {
      fs.writeFileSync(path.join(dir, "textures", "icon-report.json"), JSON.stringify(report));
    }
    // Long enough that the gunzip hands it over in several chunks.
    const body = `${"x".repeat(200_000)}{"id":"thaumcraft:aspect:radio","iconPath":"${slot}"}`;
    fs.writeFileSync(path.join(dir, "resource-index.json.gz"), gzipSync("{}"));
    fs.writeFileSync(path.join(dir, "recipes-shards", "shard-0000.json.gz"), gzipSync(body));
    // Never published, so never read: the raw dataset may hold anything.
    fs.writeFileSync(path.join(dir, "recipes.json"), '"asset:x"');
    return dir;
  }

  const resolved = { schemaVersion: 1, textureHints: { hints: 1, resolved: [], unresolved: [] } };
  const served = "/datasets/gtnh/v/textures/rendered/gregtech_radio-0123456789ab.png";

  it("passes a version whose hints were resolved", async () => {
    expect(await datasetIconProblems(version({ report: resolved, slot: served }))).toEqual([]);
  });

  it("refuses a version whose gzips still hold an asset: hint", async () => {
    const problems = await datasetIconProblems(
      version({ report: resolved, slot: "asset:gregtech:textures/aspects/RADIO.png" }),
    );
    expect(problems).toEqual([
      '1 file(s) still hold "asset: icon hints: recipes-shards/shard-0000.json.gz',
    ]);
  });

  it("refuses a version whose icon report says skipped, or that has none", async () => {
    const skipped = await datasetIconProblems(
      version({ report: { skipped: true, reason: "Dataset is too big." }, slot: served }),
    );
    expect(skipped).toEqual(["textures/icon-report.json says skipped: Dataset is too big."]);
    const none = await datasetIconProblems(version({ slot: served }));
    expect(none).toHaveLength(1);
    expect(none[0]).toMatch(/icon-report\.json is missing/);
    const older = await datasetIconProblems(version({ report: { schemaVersion: 1 }, slot: served }));
    expect(older).toEqual([
      "textures/icon-report.json has no textureHints: resolve-icon-hints.mjs did not run.",
    ]);
  });
});
