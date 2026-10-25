import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatasetChildPathIn, serveDatasetFile } from "./dataset-static-file";

const BYTES = "0123456789abcdefghij";
let dir = "";
let filePath = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gtnh-dataset-file-"));
  filePath = path.join(dir, "shard-0000.json.gz");
  await writeFile(filePath, BYTES);
  await utimes(filePath, new Date("2026-01-02T03:04:05Z"), new Date("2026-01-02T03:04:05Z"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const serve = (headers: Record<string, string> = {}) =>
  serveDatasetFile(filePath, {
    cacheControl: "public, max-age=86400",
    contentType: "application/gzip",
    requestHeaders: new Headers(headers),
  });

describe("a served dataset file", () => {
  it("carries its length, a validator and the cache policy", async () => {
    const response = await serve();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("20");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.headers.get("Last-Modified")).toBe("Fri, 02 Jan 2026 03:04:05 GMT");
    expect(await response.text()).toBe(BYTES);
  });

  it("answers 304 to the validator it gave, so a revalidation costs no bytes", async () => {
    const etag = (await serve()).headers.get("ETag") ?? "";
    const fresh = await serve({ "if-none-match": etag });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("ETag")).toBe(etag);
    expect((await serve({ "if-none-match": '"other"' })).status).toBe(200);
    // A list, a weak form and "*" are the same question.
    expect((await serve({ "if-none-match": `"other", ${etag}` })).status).toBe(304);
    expect((await serve({ "if-none-match": `W/${etag}` })).status).toBe(304);
    expect((await serve({ "if-none-match": "*" })).status).toBe(304);
  });

  it("answers 304 to a date no older than the file when no tag is sent", async () => {
    expect((await serve({ "if-modified-since": "Fri, 02 Jan 2026 03:04:05 GMT" })).status).toBe(
      304,
    );
    expect((await serve({ "if-modified-since": "Sat, 03 Jan 2026 00:00:00 GMT" })).status).toBe(
      304,
    );
    expect((await serve({ "if-modified-since": "Fri, 02 Jan 2026 03:04:04 GMT" })).status).toBe(
      200,
    );
    expect((await serve({ "if-modified-since": "not a date" })).status).toBe(200);
    // A tag that does not match wins over a matching date.
    expect(
      (
        await serve({
          "if-none-match": '"other"',
          "if-modified-since": "Sat, 03 Jan 2026 00:00:00 GMT",
        })
      ).status,
    ).toBe(200);
  });

  it("serves one byte range, and the whole file when the range is not for this version", async () => {
    const part = await serve({ range: "bytes=2-5" });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 2-5/20");
    expect(part.headers.get("Content-Length")).toBe("4");
    expect(await part.text()).toBe("2345");

    const tail = await serve({ range: "bytes=-3" });
    expect(tail.status).toBe(206);
    expect(await tail.text()).toBe("hij");

    const open = await serve({ range: "bytes=15-" });
    expect(await open.text()).toBe("fghij");

    const stale = await serve({ range: "bytes=2-5", "if-range": '"other"' });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe(BYTES);

    const beyond = await serve({ range: "bytes=30-40" });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("Content-Range")).toBe("bytes */20");

    expect((await serve({ range: "bytes=1-2,4-5" })).status).toBe(200);
    expect((await serve({ range: "lines=1-2" })).status).toBe(200);
  });
});

describe("a dataset file's path", () => {
  let tree = "";
  let root = "";

  beforeAll(async () => {
    tree = await realpath(await mkdtemp(path.join(os.tmpdir(), "gtnh-dataset-tree-")));
    root = path.join(tree, "root");
    await mkdir(path.join(root, "v1", "shards"), { recursive: true });
    await writeFile(path.join(root, "v1", "a.json"), "{}");
    await writeFile(path.join(root, "v1", "shards", "b.json"), "{}");
    await writeFile(path.join(tree, "outside.json"), "secret");
    await symlink("../../outside.json", path.join(root, "v1", "escape.json"));
    await symlink(path.join(tree, "outside.json"), path.join(root, "v1", "shards", "absolute.json"));
    await symlink("a.json", path.join(root, "v1", "inside.json"));
    // The dataset root itself is a symlink on the droplet.
    await symlink(root, path.join(tree, "linked-root"));
  });

  afterAll(async () => {
    await rm(tree, { recursive: true, force: true });
  });

  it("resolves a file in the version's directory, through a linked root too", async () => {
    expect(await resolveDatasetChildPathIn(root, "v1", "a.json")).toBe(path.join(root, "v1", "a.json"));
    expect(await resolveDatasetChildPathIn(root, "v1", "shards", "b.json")).toBe(
      path.join(root, "v1", "shards", "b.json"),
    );
    expect(await resolveDatasetChildPathIn(path.join(tree, "linked-root"), "v1", "a.json")).toBe(
      path.join(root, "v1", "a.json"),
    );
    expect(await resolveDatasetChildPathIn(root, "v1", "inside.json")).toBe(path.join(root, "v1", "a.json"));
  });

  it("never follows a link out of the version's directory, and a missing file is no path", async () => {
    expect(await resolveDatasetChildPathIn(root, "v1", "escape.json")).toBeUndefined();
    expect(await resolveDatasetChildPathIn(root, "v1", "shards", "absolute.json")).toBeUndefined();
    expect(await resolveDatasetChildPathIn(root, "v1", "..", "..", "outside.json")).toBeUndefined();
    expect(await resolveDatasetChildPathIn(root, "v1", "missing.json")).toBeUndefined();
    expect(await resolveDatasetChildPathIn(root, "v2", "a.json")).toBeUndefined();
  });
});
