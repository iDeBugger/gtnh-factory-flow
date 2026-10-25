import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_FILE_NAME,
  clientFileListing,
  clientFileName,
  ensureClientFiles,
  resetClientFileStateForTests,
  STALE_CLIENT_FILE_MS,
  writeClientFiles,
  type ClientFileSpec,
} from "./client-files";

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "client-files-"));
  resetClientFileStateForTests();
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const catalog = { schemaVersion: 1, resourceIndex: [{ id: "a" }] };
const specs: ClientFileSpec[] = [
  { kind: "catalog", brotliQuality: 11, produce: async () => catalog },
  { kind: "recipe-ids", produce: async () => ({ recipeIds: ["r1", "r2"] }) },
];

describe("the server's content-addressed dataset answers", () => {
  it("names each file by the hash of the JSON the API sends, within the gate's characters", async () => {
    const written: Record<string, string> = {};
    await writeClientFiles(directory, specs, (kind, name) => {
      written[kind] = name;
    });
    const catalogName = clientFileName("catalog", Buffer.from(JSON.stringify(catalog)));
    expect(written.catalog).toBe(catalogName);
    expect(written.catalog).toMatch(CLIENT_FILE_NAME);
    expect(written["recipe-ids"]).toMatch(/^recipe-ids\.[0-9a-f]{20}\.json$/);
    expect((await fs.readdir(directory)).sort()).toEqual(
      [`${catalogName}.br`, `${catalogName}.gz`, `${written["recipe-ids"]}.gz`].sort(),
    );
    const gz = await fs.readFile(path.join(directory, `${catalogName}.gz`));
    const br = await fs.readFile(path.join(directory, `${catalogName}.br`));
    expect(gunzipSync(gz).toString()).toBe(JSON.stringify(catalog));
    expect(brotliDecompressSync(br).toString()).toBe(JSON.stringify(catalog));
  });

  it("changes the name when the answer changes, and never rewrites a file already there", async () => {
    await writeClientFiles(directory, specs, () => {});
    const name = clientFileName("catalog", Buffer.from(JSON.stringify(catalog)));
    const before = await fs.readFile(path.join(directory, `${name}.gz`));
    const writeFile = vi.spyOn(fs, "writeFile");
    await writeClientFiles(directory, specs, () => {});
    expect(writeFile).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, `${name}.gz`))).toEqual(before);

    const changed = clientFileName("catalog", Buffer.from(JSON.stringify({ ...catalog, x: 1 })));
    expect(changed).not.toBe(name);
  });

  it("keeps a file no start names for a month, then removes it", async () => {
    const old = "catalog.00000000000000000000.json.gz";
    await fs.writeFile(path.join(directory, old), "x");
    const now = Date.now();
    await writeClientFiles(directory, specs, () => {}, now);
    expect(await fs.readdir(directory)).toContain(old);

    const stamp = new Date(now - STALE_CLIENT_FILE_MS - 1000);
    await fs.utimes(path.join(directory, old), stamp, stamp);
    await writeClientFiles(directory, specs, () => {}, now);
    expect(await fs.readdir(directory)).not.toContain(old);
    expect(await fs.readdir(directory)).toHaveLength(3);
  });

  it("lists each file once it is on disk, and the listing is complete only when all are", async () => {
    let release: () => void = () => {};
    const slow: ClientFileSpec = {
      kind: "crops",
      produce: () => new Promise((resolve) => (release = () => resolve({ crops: [] }))),
    };
    const all = [specs[0]!, slow];
    const first = clientFileListing("v:hash", "v", directory, all);
    expect(first).toEqual({ complete: false, files: {} });
    await vi.waitFor(async () => {
      expect(clientFileListing("v:hash", "v", directory, all).files.catalog).toBeDefined();
    });
    const partial = clientFileListing("v:hash", "v", directory, all);
    expect(partial.complete).toBe(false);
    expect(partial.files.catalog).toMatch(
      /^\/datasets\/gtnh\/v\/client\/catalog\.[0-9a-f]{20}\.json$/,
    );
    release();
    await ensureClientFiles("v:hash", "v", directory, all);
    expect(clientFileListing("v:hash", "v", directory, all).complete).toBe(true);
  });

  it("logs a failed write and stays incomplete, so the client keeps the API", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: ClientFileSpec[] = [
      { kind: "catalog", produce: async () => Promise.reject(new Error("no")) },
    ];
    await ensureClientFiles("w:hash", "w", directory, failing);
    expect(clientFileListing("w:hash", "w", directory, failing)).toEqual({
      complete: false,
      files: {},
    });
    expect(error).toHaveBeenCalledTimes(1);
  });
});
