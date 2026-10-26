import { describe, expect, it, vi } from "vitest";
import {
  BUDGET_PER_MINUTE,
  DATASET_BUDGET_REFUSAL,
  resetDatasetBudget,
  spendDatasetBudget,
} from "@/lib/server/dataset-rate";
import { getResourcePopularity } from "@/lib/server/resource-popularity";
import { GET } from "./route";

vi.mock("@/lib/server/resource-popularity", () => ({
  getResourcePopularity: vi.fn(() => new Map<string, number>()),
}));

describe("the popularity map the browser's item search orders by", () => {
  it("is never stored while empty, and kept half an hour once a sweep has landed", async () => {
    const empty = await GET(new Request("http://localhost/api/resource-popularity"));
    expect(empty.headers.get("Cache-Control")).toBe("no-store");
    await expect(empty.json()).resolves.toEqual({ entries: [] });

    vi.mocked(getResourcePopularity).mockReturnValueOnce(new Map([["fluid:water", 40]]));
    const landed = await GET(new Request("http://localhost/api/resource-popularity"));
    expect(landed.headers.get("Cache-Control")).toBe("public, max-age=1800");
    await expect(landed.json()).resolves.toEqual({ entries: [["fluid:water", 40]] });
  });

  it("answers only its size when asked for the count, under the same cache policy", async () => {
    const empty = await GET(new Request("http://localhost/api/resource-popularity?count=1"));
    expect(empty.headers.get("Cache-Control")).toBe("no-store");
    await expect(empty.json()).resolves.toEqual({ count: 0 });

    vi.mocked(getResourcePopularity).mockReturnValueOnce(
      new Map([
        ["fluid:water", 40],
        ["item:minecraft:glass", 30],
      ]),
    );
    const landed = await GET(new Request("http://localhost/api/resource-popularity?count=1"));
    expect(landed.headers.get("Cache-Control")).toBe("public, max-age=1800");
    await expect(landed.json()).resolves.toEqual({ count: 2 });
  });

  it("spends the dataset budget like the routes it serves, and is refused past it", async () => {
    resetDatasetBudget();
    spendDatasetBudget("203.0.113.5", BUDGET_PER_MINUTE);
    const refused = await GET(
      new Request("http://localhost/api/resource-popularity", {
        headers: { "x-client-ip": "203.0.113.5" },
      }),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("10");
    await expect(refused.json()).resolves.toEqual({ error: DATASET_BUDGET_REFUSAL });
    expect(getResourcePopularity).toHaveBeenCalledTimes(4);
    resetDatasetBudget();
  });
});
