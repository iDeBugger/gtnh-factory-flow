import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSearchQuery } from "@/lib/search/text-search";
import {
  BUDGET_PER_MINUTE,
  DATASET_BUDGET_REFUSAL,
  datasetBudgetRefusal,
  HEAVY_REQUEST_COST,
  resetDatasetBudget,
  searchRequestCost,
  takeDatasetBudget,
} from "./dataset-rate";

describe("the dataset work budget", () => {
  beforeEach(() => {
    resetDatasetBudget();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses past 1200 units in a minute and forgets after it", () => {
    expect(BUDGET_PER_MINUTE).toBe(1200);
    const now = 1_000_000;
    expect(takeDatasetBudget("a", 1199, now)).toBe(true);
    expect(takeDatasetBudget("a", 1, now)).toBe(true);
    expect(takeDatasetBudget("a", 1, now + 1)).toBe(false);
    expect(takeDatasetBudget("b", 1, now + 1)).toBe(true);
    expect(takeDatasetBudget("a", 1, now + 60_001)).toBe(true);
  });

  it("a heavy request spends ten units", () => {
    expect(HEAVY_REQUEST_COST).toBe(10);
    const now = 1_000_000;
    for (let call = 0; call < 120; call += 1) {
      expect(takeDatasetBudget("a", HEAVY_REQUEST_COST, now)).toBe(true);
    }
    expect(takeDatasetBudget("a", HEAVY_REQUEST_COST, now)).toBe(false);
  });

  it("forgets the oldest address past 10,000", () => {
    const now = 1_000_000;
    expect(takeDatasetBudget("first", 1200, now)).toBe(true);
    for (let key = 0; key < 10_000; key += 1) {
      expect(takeDatasetBudget(`k${key}`, 1, now)).toBe(true);
    }
    // "first" was the oldest and is gone, so its budget is whole again.
    expect(takeDatasetBudget("first", 1, now)).toBe(true);
  });

  it("can be switched off for a profiling run", () => {
    vi.stubEnv("GTNH_DATASET_BUDGET_PER_MINUTE", "0");
    expect(takeDatasetBudget("a", 5000)).toBe(true);
    expect(takeDatasetBudget("a", 5000)).toBe(true);
  });

  it("answers 429 with the retry hint once the budget is spent", async () => {
    const request = new Request("http://localhost/api/datasets/v/recipes", {
      headers: { "x-client-ip": "203.0.113.9" },
    });
    expect(datasetBudgetRefusal(request, 1200)).toBeUndefined();
    const refusal = datasetBudgetRefusal(request, 1);
    expect(refusal?.status).toBe(429);
    expect(refusal?.headers.get("Retry-After")).toBe("10");
    expect(refusal?.headers.get("Cache-Control")).toBe("no-store");
    await expect(refusal?.json()).resolves.toEqual({ error: DATASET_BUDGET_REFUSAL });
    expect(DATASET_BUDGET_REFUSAL).toBe("Too many requests. Wait a moment and try again.");
  });

  it("charges a short or a long query ten units and a narrowed one a unit", () => {
    const cost = (query: string) => searchRequestCost(parseSearchQuery(query).terms);
    expect(cost("")).toBe(1);
    expect(cost("iron")).toBe(1);
    expect(cost("steel plate ingot")).toBe(1);
    expect(cost("zz")).toBe(10);
    expect(cost("lv motor")).toBe(10);
    expect(cost("iron steel plate ingot")).toBe(10);
  });
});
