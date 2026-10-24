import { beforeEach, describe, expect, it, vi } from "vitest";
import { serveDatasetFile } from "@/lib/server/dataset-static-file";
import { GET } from "./route";

vi.mock("@/lib/server/dataset-static-file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/dataset-static-file")>()),
  serveDatasetFile: vi.fn(async () => new Response("")),
}));

function get(assetFile: string) {
  return GET(new Request(`http://localhost/datasets/gtnh/local-2.9.0-rc-2/${assetFile}`), {
    params: Promise.resolve({ versionId: "local-2.9.0-rc-2", assetFile }),
  });
}

describe("the dataset file route", () => {
  beforeEach(() => {
    vi.mocked(serveDatasetFile).mockClear();
  });

  it("serves a gzip for a day, as the public handler does", async () => {
    expect((await get("recipes.json.gz")).status).toBe(200);
    expect(serveDatasetFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(serveDatasetFile).mock.calls[0]?.[1]).toEqual({
      cacheControl: "public, max-age=86400",
      contentType: "application/gzip",
    });
  });

  it("refuses the raw recipes file, as the rewrite delivers it and as named", async () => {
    for (const assetFile of ["recipes.json", "recipes.json.raw"]) {
      const response = await get(assetFile);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid dataset path." });
    }
    expect(serveDatasetFile).not.toHaveBeenCalled();
  });
});
