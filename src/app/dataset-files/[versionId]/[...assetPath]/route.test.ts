import { beforeEach, describe, expect, it, vi } from "vitest";
import { serveDatasetFile } from "@/lib/server/dataset-static-file";
import { GET } from "./route";

// The files need not exist here: the resolver is the real one with the
// version root as its own fake tree (dataset-static-file.test.ts covers links).
vi.mock("@/lib/server/dataset-static-file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/dataset-static-file")>();
  const path = await import("node:path");
  return {
    ...actual,
    resolveDatasetChildPath: vi.fn(async (versionId: string, ...segments: string[]) => {
      const versionRoot = path.resolve(actual.datasetRoot, versionId);
      const filePath = path.resolve(versionRoot, ...segments);
      return filePath.startsWith(`${versionRoot}${path.sep}`) ? filePath : undefined;
    }),
    serveDatasetFile: vi.fn(async () => new Response("")),
  };
});

function get(assetPath: string[], versionId = "local-2.9.0-rc-2") {
  return GET(new Request(`http://localhost/dataset-files/${versionId}/${assetPath.join("/")}`), {
    params: Promise.resolve({ versionId, assetPath }),
  });
}

const served = () =>
  vi
    .mocked(serveDatasetFile)
    .mock.calls.map(([filePath, options]) => [
      filePath.split("/").slice(-3).join("/"),
      options.cacheControl,
    ]);

describe("the dataset file route", () => {
  beforeEach(() => {
    vi.mocked(serveDatasetFile).mockClear();
  });

  it("serves an index gzip and a shard for a day, never immutable", async () => {
    expect((await get(["recipes.json.gz"])).status).toBe(200);
    expect((await get(["recipe-lookup-index.json.gz"])).status).toBe(200);
    expect((await get(["recipes-shards", "shard-0136.json.gz"])).status).toBe(200);
    expect(served()).toEqual([
      ["gtnh/local-2.9.0-rc-2/recipes.json.gz", "public, max-age=86400"],
      ["gtnh/local-2.9.0-rc-2/recipe-lookup-index.json.gz", "public, max-age=86400"],
      ["local-2.9.0-rc-2/recipes-shards/shard-0136.json.gz", "public, max-age=86400"],
    ]);
    // The request's headers reach the file, for ETag and Range.
    expect(vi.mocked(serveDatasetFile).mock.calls[0]?.[1].requestHeaders).toBeInstanceOf(Headers);
  });

  it("refuses the raw recipes file and every other name, uncached", async () => {
    for (const assetPath of [
      ["recipes.json"],
      ["oracle", "oracle-report.json"],
      ["recipes-shards", "evil.json.gz"],
      ["recipes-shards", "shard-0000.json.gz", "more"],
      ["textures", "rendered", "x.png"],
    ]) {
      const response = await get(assetPath);
      expect(response.status, assetPath.join("/")).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "Invalid dataset path." });
    }
    expect((await get(["recipes.json.gz"], "..")).status).toBe(400);
    expect(serveDatasetFile).not.toHaveBeenCalled();
  });

  it("never lets a miss be cached for the day a file gets", async () => {
    // A file missing for a moment during an in-place publish, or a version
    // that is not installed, must not sit as a 404 at the edge for a day.
    vi.mocked(serveDatasetFile).mockRejectedValueOnce(new Error("ENOENT"));
    const response = await get(["recipe-index.json.gz"], "local-2.8.4");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
