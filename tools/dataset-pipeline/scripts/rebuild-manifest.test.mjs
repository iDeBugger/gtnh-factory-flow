import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = path.join(import.meta.dirname, "rebuild-manifest.mjs");
const roots = [];

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-manifest-"));
  roots.push(root);
  return root;
}

function addDataset(root, id, gtnhVersion, generatedAt) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const recipes = [
    "{",
    `  "datasetVersionId": ${JSON.stringify(id)},`,
    `  "gtnhVersion": ${JSON.stringify(gtnhVersion)},`,
    `  "generatedAt": ${JSON.stringify(generatedAt)},`,
    `  "sourceInfo": {"sourceId": "gtnh-oracle"},`,
    `  "recipes": []`,
    "}",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "recipes.json.gz"), gzipSync(recipes));
  for (const name of ["resource-index.json.gz", "recipe-index.json.gz", "recipe-lookup-index.json.gz"]) {
    fs.writeFileSync(path.join(dir, name), gzipSync("{}"));
  }
}

function writeManifest(root, manifest) {
  fs.writeFileSync(path.join(root, "datasets.manifest.json"), JSON.stringify(manifest));
}

async function rebuild(root, env = {}) {
  const childEnv = { ...process.env, GTNH_DATASETS_ROOT: root, ...env };
  if (!("GTNH_LATEST_STABLE_VERSION" in env)) delete childEnv.GTNH_LATEST_STABLE_VERSION;
  await run(process.execPath, [script], { env: childEnv });
  return JSON.parse(fs.readFileSync(path.join(root, "datasets.manifest.json"), "utf8"));
}

function bothVersions() {
  const root = makeRoot();
  addDataset(root, "local-2.9.0-rc-2", "2.9.0-RC-2", "2026-10-23T14:41:27.913Z");
  // Published after 2.9: the default must not follow the newest publish.
  addDataset(root, "local-2.8.1", "2.8.1", "2026-10-23T16:18:51.237Z");
  return root;
}

describe("rebuild-manifest's default version", () => {
  it("keeps the previous manifest's default, with 2.8.1 beside it", async () => {
    const root = bothVersions();
    writeManifest(root, { schemaVersion: 1, latestStableVersion: "local-2.9.0-rc-2", versions: [] });

    const manifest = await rebuild(root);

    expect(manifest.latestStableVersion).toBe("local-2.9.0-rc-2");
    expect(manifest.versions.map((version) => version.id)).toEqual(["local-2.9.0-rc-2", "local-2.8.1"]);
  });

  it("takes GTNH_LATEST_STABLE_VERSION over the previous manifest", async () => {
    const root = bothVersions();
    writeManifest(root, { schemaVersion: 1, latestStableVersion: "local-2.9.0-rc-2", versions: [] });

    const manifest = await rebuild(root, { GTNH_LATEST_STABLE_VERSION: "local-2.8.1" });

    expect(manifest.latestStableVersion).toBe("local-2.8.1");
  });

  it("refuses a GTNH_LATEST_STABLE_VERSION that names no dataset", async () => {
    const root = bothVersions();

    await expect(rebuild(root, { GTNH_LATEST_STABLE_VERSION: "local-2.10" })).rejects.toThrow(
      /names no dataset/,
    );
  });

  it("drops a previous default whose dataset is gone", async () => {
    const root = bothVersions();
    writeManifest(root, { schemaVersion: 1, latestStableVersion: "local-2.8.4", versions: [] });

    const manifest = await rebuild(root);

    expect(manifest.latestStableVersion).toBeUndefined();
  });

  it("falls back to the newest stable-channel build with no previous manifest", async () => {
    const root = bothVersions();
    addDataset(root, "stable-2.8.0", "2.8.0", "2026-01-01T00:00:00.000Z");

    const manifest = await rebuild(root);

    expect(manifest.latestStableVersion).toBe("stable-2.8.0");
  });
});
