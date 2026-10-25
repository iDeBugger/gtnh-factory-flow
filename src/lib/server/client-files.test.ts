import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_FILE_NAME,
  clientFileDirectory,
  clientFilesRoot,
  CLIENT_FILES_ROOT_MARKER,
  claimClientFilesRoot,
  removeUnservedClientFileDirectories,
  resolveClientFilePath,
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
  { kind: "catalog", brotli: { quality: 11, window: 22 }, produce: async () => catalog },
  { kind: "recipe-ids", produce: async () => ({ recipeIds: ["r1", "r2"] }) },
];

describe("where the client files live", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the site's own cache directory, never the dataset tree", () => {
    vi.stubEnv("GTNH_CLIENT_FILES_DIR", "");
    expect(clientFilesRoot()).toBe(path.join(process.cwd(), ".cache", "client-files"));
    vi.stubEnv("GTNH_CLIENT_FILES_DIR", "/data/client-files");
    expect(clientFileDirectory("local-2.9.0-rc-2")).toBe("/data/client-files/local-2.9.0-rc-2");
    expect(resolveClientFilePath("local-2.9.0-rc-2", "catalog.0123456789abcdef0123.json.br")).toBe(
      "/data/client-files/local-2.9.0-rc-2/catalog.0123456789abcdef0123.json.br",
    );
    expect(clientFilesRoot()).not.toContain(path.join("public", "datasets"));
  });

  it("refuses a version or file name that is not a plain name", () => {
    expect(clientFileDirectory("..")).toBeUndefined();
    expect(clientFileDirectory("a/b")).toBeUndefined();
    expect(resolveClientFilePath("v", "../x.gz")).toBeUndefined();
  });
});

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

describe("the client files of a version no longer served", () => {
  const file = "catalog.00000000000000000000.json";
  async function version(name: string, entries: string[]) {
    await fs.mkdir(path.join(directory, name));
    for (const entry of entries) {
      await fs.writeFile(path.join(directory, name, entry), "x");
    }
  }
  const contents = async () => (await fs.readdir(directory)).sort();

  it("are removed at start, and nothing else in the root is touched", async () => {
    expect(await claimClientFilesRoot(directory)).toBe(true);
    await version("local-2.9.0-rc-2", [`${file}.gz`]);
    await version("local-2.8.1", [`${file}.gz`]);
    await version("local-2.9.0-beta-2", [`${file}.gz`, `${file}.br`, `${file}.br.123.tmp`]);
    await fs.writeFile(path.join(directory, "note.txt"), "x");
    const removed = await removeUnservedClientFileDirectories(directory, [
      "local-2.9.0-rc-2",
      "local-2.8.1",
    ]);
    expect(removed).toEqual(["local-2.9.0-beta-2"]);
    expect(await contents()).toEqual(
      [CLIENT_FILES_ROOT_MARKER, "local-2.8.1", "local-2.9.0-rc-2", "note.txt"].sort(),
    );
  });

  it("never delete a foreign directory, an empty one, or one holding anything the site does not write", async () => {
    await claimClientFilesRoot(directory);
    await version("postgres", ["PG_VERSION"]);
    await version("old-build", [`${file}.gz`, "readme.md"]);
    await version("nested", [`${file}.gz`]);
    await fs.mkdir(path.join(directory, "nested", "inner"));
    await version("backups", []);
    const removed = await removeUnservedClientFileDirectories(directory, ["local-2.9.0-rc-2"]);
    expect(removed).toEqual([]);
    expect(await contents()).toEqual(
      [CLIENT_FILES_ROOT_MARKER, "backups", "nested", "old-build", "postgres"].sort(),
    );
  });

  it("leave links alone, in the root and in a version directory, and never reach their targets", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "client-files-outside-"));
    try {
      await fs.writeFile(path.join(outside, `${file}.gz`), "target");
      await claimClientFilesRoot(directory);
      await fs.symlink(outside, path.join(directory, "linked-version"));
      await version("local-2.9.0-beta-2", [`${file}.gz`]);
      await fs.symlink(
        path.join(outside, `${file}.gz`),
        path.join(directory, "local-2.9.0-beta-2", `${file}.br`),
      );
      expect(await removeUnservedClientFileDirectories(directory, ["local-2.9.0-rc-2"])).toEqual(
        [],
      );
      expect(await contents()).toEqual(
        [CLIENT_FILES_ROOT_MARKER, "linked-version", "local-2.9.0-beta-2"].sort(),
      );
      expect(await fs.readFile(path.join(outside, `${file}.gz`), "utf8")).toBe("target");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("go on past a directory they cannot remove, and the writes after them go on too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await claimClientFilesRoot(directory);
    await version("local-2.9.0-beta-1", [`${file}.gz`]);
    await version("local-2.9.0-beta-2", [`${file}.gz`]);
    // Without write permission its files cannot be unlinked, so it cannot be removed.
    await fs.chmod(path.join(directory, "local-2.9.0-beta-1"), 0o500);
    try {
      const removed = await removeUnservedClientFileDirectories(directory, ["local-2.9.0-rc-2"]);
      expect(removed).toEqual(["local-2.9.0-beta-2"]);
      expect(await contents()).toContain("local-2.9.0-beta-1");
      await writeClientFiles(path.join(directory, "local-2.9.0-rc-2"), specs, () => {});
      expect(await fs.readdir(path.join(directory, "local-2.9.0-rc-2"))).toHaveLength(3);
    } finally {
      await fs.chmod(path.join(directory, "local-2.9.0-beta-1"), 0o700);
    }
  });

  it("touch nothing in a root without the site's marker, or when no version is served", async () => {
    await version("local-2.9.0-beta-2", [`${file}.gz`]);
    expect(await removeUnservedClientFileDirectories(directory, ["local-2.9.0-rc-2"])).toEqual([]);
    await fs.writeFile(path.join(directory, CLIENT_FILES_ROOT_MARKER), "");
    expect(await removeUnservedClientFileDirectories(directory, [])).toEqual([]);
    expect(await contents()).toContain("local-2.9.0-beta-2");
    await expect(
      removeUnservedClientFileDirectories(path.join(directory, "missing"), ["v"]),
    ).resolves.toEqual([]);
  });
});

describe("whose root the client files go into", () => {
  it("is claimed when created or found empty, and a non-empty root that is not the site's stays untouched over two starts", async () => {
    const fresh = path.join(directory, "fresh");
    expect(await claimClientFilesRoot(fresh)).toBe(true);
    expect(await fs.readdir(fresh)).toEqual([CLIENT_FILES_ROOT_MARKER]);
    expect(await claimClientFilesRoot(fresh)).toBe(true);

    const shared = path.join(directory, "data");
    await fs.mkdir(path.join(shared, "backups"), { recursive: true });
    await fs.mkdir(path.join(shared, "old-version"));
    await fs.writeFile(
      path.join(shared, "old-version", "catalog.00000000000000000000.json.gz"),
      "x",
    );
    for (let start = 0; start < 2; start += 1) {
      expect(await claimClientFilesRoot(shared)).toBe(false);
      expect(await removeUnservedClientFileDirectories(shared, ["local-2.9.0-rc-2"])).toEqual([]);
    }
    expect((await fs.readdir(shared)).sort()).toEqual(["backups", "old-version"]);
  });
});
