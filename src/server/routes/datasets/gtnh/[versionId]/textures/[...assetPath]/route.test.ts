import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/server/dataset-static-file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/dataset-static-file")>();
  return { ...actual, resolveDatasetChildPath: vi.fn(async () => undefined) };
});

function get(assetPath: string[], versionId = "local-2.9.0-rc-2") {
  return GET(new Request(`http://localhost/datasets/gtnh/${versionId}/textures/${assetPath.join("/")}`), {
    params: Promise.resolve({ versionId, assetPath }),
  });
}

describe("the textures route the public handler falls back to", () => {
  it("never lets a miss be cached", async () => {
    const missing = await get(["atlas", "atlas-0000.png"]);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses the content-named roots, which the proxy sends to the dataset-files route, uncached", async () => {
    for (const assetPath of [
      ["rendered", "x-0123456789ab.png"],
      ["icons", "x-0123456789ab.png"],
      ["aspect", "x.png"],
      ["atlas", "x.json"],
    ]) {
      const refused = await get(assetPath);
      expect(refused.status, assetPath.join("/")).toBe(400);
      expect(refused.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
