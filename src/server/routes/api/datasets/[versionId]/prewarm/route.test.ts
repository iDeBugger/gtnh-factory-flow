import { beforeEach, describe, expect, it, vi } from "vitest";
import { prewarmDatasetVersion } from "@/lib/server/dataset-query";
import { GET } from "./route";

vi.mock("@/lib/server/dataset-query", () => ({
  prewarmDatasetVersion: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/services/resource-popularity", () => ({
  getResourcePopularity: vi.fn(() => undefined),
}));

const params = Promise.resolve({ versionId: "local-2.9.0-rc-2" });

describe("the dataset prewarm route", () => {
  beforeEach(() => {
    vi.mocked(prewarmDatasetVersion).mockClear();
  });

  it("never reads shards for an HTTP caller", async () => {
    const response = await GET(
      new Request("http://localhost/api/datasets/local-2.9.0-rc-2/prewarm?includeShards=1"),
      { params },
    );

    expect(prewarmDatasetVersion).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prewarmDatasetVersion).mock.calls[0]).toEqual(["local-2.9.0-rc-2"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ ok: true, includeShards: false });
  });

  it("is never rate limited", async () => {
    for (let call = 0; call < 1300; call += 1) {
      const response = await GET(
        new Request("http://localhost/api/datasets/local-2.9.0-rc-2/prewarm", {
          headers: { "x-client-ip": "203.0.113.9" },
        }),
        { params },
      );
      expect(response.status).toBe(200);
    }
  });
});
