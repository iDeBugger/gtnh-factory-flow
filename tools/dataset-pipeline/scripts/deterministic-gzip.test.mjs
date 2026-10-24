import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { computeDatasetChecksum } from "./dataset-checksum.mjs";
import { writeDatasetJson } from "./dataset-json-writer.mjs";
import { gzipDeterministic, gzipFileDeterministic } from "./deterministic-gzip.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const folders = [];
afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deterministic-gzip-"));
  folders.push(dir);
  return dir;
}

function expectPinnedHeader(bytes) {
  expect([...bytes.subarray(0, 4)]).toEqual([0x1f, 0x8b, 8, 0]); // deflate, no name, comment or extra field
  expect([...bytes.subarray(4, 8)]).toEqual([0, 0, 0, 0]); // no mtime
  expect(bytes[8]).toBe(2); // level 9
  expect(bytes[9]).toBe(3); // Unix, on every host
}

describe("deterministic gzip", () => {
  it("writes the same bytes for the same input, with no name, time or host in the header", async () => {
    const json = Buffer.from(JSON.stringify({ recipes: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` })) }));
    const once = gzipDeterministic(json);
    expectPinnedHeader(once);
    expect(gzipDeterministic(json).equals(once)).toBe(true);
    expect(gunzipSync(once).equals(json)).toBe(true);

    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "in.json"), json);
    await gzipFileDeterministic(path.join(dir, "in.json"), path.join(dir, "in.json.gz"));
    expect(fs.readFileSync(path.join(dir, "in.json.gz")).equals(once)).toBe(true);
    expect(fs.existsSync(path.join(dir, "in.json.gz.partial"))).toBe(false);
  });

  it("makes recipes.json.gz in the index step, so two builds of one dataset share a checksum", async () => {
    const dataset = {
      schemaVersion: 1,
      datasetVersionId: "local-test",
      gtnhVersion: "test",
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceInfo: { sourceId: "gtnh-oracle" },
      recipeMaps: [{ id: "gt.recipe.test", name: "Test" }],
      resources: [
        { key: "item:a", kind: "item", id: "a", displayName: "A" },
        { key: "item:b", kind: "item", id: "b", displayName: "B" },
      ],
      recipes: [
        {
          id: "oracle:gregtech:test:1",
          recipeMap: "gt.recipe.test",
          inputs: [{ resourceKey: "item:a", kind: "item", id: "a", amount: 1 }],
          outputs: [{ resourceKey: "item:b", kind: "item", id: "b", amount: 1 }],
          durationTicks: 20,
          eut: 30,
        },
      ],
    };
    const checksums = [];
    for (const run of [1, 2]) {
      const dir = tempDir();
      const recipesPath = path.join(dir, "recipes.json");
      await writeDatasetJson(recipesPath, dataset);
      const env = { ...process.env, NODE_OPTIONS: "" };
      execFileSync(process.execPath, [path.join(scriptsDir, "build-resource-index.mjs"), recipesPath], { env });
      execFileSync(process.execPath, [path.join(scriptsDir, "build-recipe-index.mjs"), recipesPath, dir], { env });
      const gz = fs.readFileSync(path.join(dir, "recipes.json.gz"));
      expectPinnedHeader(gz);
      expect(gunzipSync(gz).equals(fs.readFileSync(recipesPath))).toBe(true);
      for (const name of ["resource-index.json.gz", "recipe-index.json.gz", "recipe-lookup-index.json.gz"]) {
        expectPinnedHeader(fs.readFileSync(path.join(dir, name)));
      }
      if (run === 2) {
        // A second run over an unchanged recipes.json changes nothing either.
        execFileSync(process.execPath, [path.join(scriptsDir, "build-recipe-index.mjs"), recipesPath, dir], { env });
      }
      checksums.push(await computeDatasetChecksum(dir));
    }
    expect(checksums[1]).toBe(checksums[0]);
  });
});
