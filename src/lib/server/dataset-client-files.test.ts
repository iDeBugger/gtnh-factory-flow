import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./dataset-query", () => ({
  getServedDatasetVersion: vi.fn(async (id: string) => ({ id, checksumSha256: "abc" })),
  servedDatasetVersionOrder: vi.fn(async () => ["local-2.9.0-rc-2"]),
  prewarmDatasetVersion: vi.fn(async () => undefined),
  getDatasetCatalog: vi.fn(async () => ({ schemaVersion: 1 })),
  listDatasetEecMobs: vi.fn(async () => ({ mobs: [] })),
  listDatasetCropFarmRecipes: vi.fn(async () => ({ crops: [] })),
  getDatasetRecipeIds: vi.fn(async () => ["r1"]),
  getDatasetResourceSearchFile: vi.fn(async () => ({ schemaVersion: 1 })),
}));

let root: string;

beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "client-root-"));
  vi.stubEnv("GTNH_CLIENT_FILES_DIR", root);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("the site's client files at start", () => {
  it("write nothing into a root that holds things not the site's, and leave the answers to the API", async () => {
    await fs.mkdir(path.join(root, "backups"));
    const { writeServedDatasetClientFiles, datasetClientFileListing } =
      await import("./dataset-client-files");
    await writeServedDatasetClientFiles();
    expect(await fs.readdir(root)).toEqual(["backups"]);
    await expect(datasetClientFileListing("local-2.9.0-rc-2")).resolves.toEqual({
      complete: false,
      files: {},
    });
    expect(await fs.readdir(root)).toEqual(["backups"]);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("claim an empty root and write every served version's files into it", async () => {
    const { writeServedDatasetClientFiles } = await import("./dataset-client-files");
    await writeServedDatasetClientFiles();
    expect((await fs.readdir(root)).sort()).toEqual([".gtnh-client-files", "local-2.9.0-rc-2"]);
    expect((await fs.readdir(path.join(root, "local-2.9.0-rc-2"))).length).toBeGreaterThanOrEqual(
      5,
    );
  });
});
