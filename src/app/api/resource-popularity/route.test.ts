import { describe, expect, it, vi } from "vitest";
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
});
