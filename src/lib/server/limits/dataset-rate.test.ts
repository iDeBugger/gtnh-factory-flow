import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSearchQuery } from "@/lib/search/text-search";
import { NO_ADDRESS } from "../http/client-address";
import {
  BUDGET_PER_MINUTE,
  DATASET_BUDGET_REFUSAL,
  datasetBudgetAddressCount,
  datasetBudgetRefusal,
  datasetBudgetSpent,
  FREE_MS_PER_REQUEST,
  HEAVY_REQUEST_COST,
  meteredDatasetWork,
  MS_PER_WORK_UNIT,
  resetDatasetBudget,
  searchRequestCost,
  spendDatasetBudget,
  takeDatasetBudget,
} from "./dataset-rate";

const from = (address?: string) =>
  new Request("http://localhost/api/datasets/v/recipes", {
    headers: address ? { "x-client-ip": address } : {},
  });

describe("the dataset work budget", () => {
  beforeEach(() => {
    resetDatasetBudget();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses past 3000 units in a minute and forgets after it", () => {
    expect(BUDGET_PER_MINUTE).toBe(3000);
    const now = 1_000_000;
    expect(takeDatasetBudget("a", 2999, now)).toBe(true);
    expect(takeDatasetBudget("a", 1, now)).toBe(true);
    expect(takeDatasetBudget("a", 1, now + 1)).toBe(false);
    expect(takeDatasetBudget("b", 1, now + 1)).toBe(true);
    expect(takeDatasetBudget("a", 1, now + 60_001)).toBe(true);
  });

  it("a heavy request spends 25 units: 120 a minute", () => {
    expect(HEAVY_REQUEST_COST).toBe(25);
    const now = 1_000_000;
    for (let call = 0; call < 120; call += 1) {
      expect(takeDatasetBudget("a", HEAVY_REQUEST_COST, now)).toBe(true);
    }
    expect(takeDatasetBudget("a", HEAVY_REQUEST_COST, now)).toBe(false);
  });

  it("charges the measured time of an answer on top, one unit per 10 ms past a free 50 ms", async () => {
    expect(MS_PER_WORK_UNIT).toBe(10);
    expect(FREE_MS_PER_REQUEST).toBe(50);
    const now = 1_000_000;
    spendDatasetBudget("a", 2990, now);
    // The measured part is never refused: the work is already done.
    spendDatasetBudget("a", 50, now);
    expect(datasetBudgetSpent("a", now)).toBe(3040);
    expect(takeDatasetBudget("a", 1, now)).toBe(false);

    const request = from("203.0.113.9");
    await expect(
      meteredDatasetWork(
        request,
        () => new Promise((resolve) => setTimeout(() => resolve("x"), 120)),
      ),
    ).resolves.toBe("x");
    expect(datasetBudgetSpent("203.0.113.9")).toBeGreaterThanOrEqual(7);
    expect(datasetBudgetSpent("203.0.113.9")).toBeLessThanOrEqual(30);

    // A quick answer, even one queued a little, costs nothing beyond its base.
    await meteredDatasetWork(
      from("203.0.113.11"),
      () => new Promise((resolve) => setTimeout(() => resolve("x"), 20)),
    );
    expect(datasetBudgetSpent("203.0.113.11")).toBe(0);

    // Charged when the work throws too.
    await expect(
      meteredDatasetWork(from("203.0.113.10"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 90));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(datasetBudgetSpent("203.0.113.10")).toBeGreaterThanOrEqual(4);
  });

  it("forgets the oldest address past 10,000, on refusals too", () => {
    const now = 1_000_000;
    expect(takeDatasetBudget("first", 3000, now)).toBe(true);
    for (let key = 0; key < 10_000; key += 1) {
      expect(takeDatasetBudget(`k${key}`, 1, now)).toBe(true);
    }
    expect(datasetBudgetAddressCount()).toBe(10_000);
    // "first" was the oldest and is gone, so its budget is whole again.
    expect(takeDatasetBudget("first", 1, now)).toBe(true);
    for (let key = 0; key < 500; key += 1) {
      expect(takeDatasetBudget(`refused${key}`, 5000, now)).toBe(false);
    }
    expect(datasetBudgetAddressCount()).toBe(10_000);
  });

  it("can be switched off for a profiling run, and ignores a budget no heavy request fits", () => {
    vi.stubEnv("GTNH_DATASET_BUDGET_PER_MINUTE", "0");
    expect(takeDatasetBudget("a", 5000)).toBe(true);
    expect(takeDatasetBudget("a", 5000)).toBe(true);
    vi.stubEnv("GTNH_DATASET_BUDGET_PER_MINUTE", "5");
    resetDatasetBudget();
    expect(takeDatasetBudget("b", HEAVY_REQUEST_COST)).toBe(true);
    expect(takeDatasetBudget("b", 3000 - HEAVY_REQUEST_COST)).toBe(true);
    expect(takeDatasetBudget("b", 1)).toBe(false);
  });

  it("answers 429 with the retry hint once the budget is spent", async () => {
    const request = from("203.0.113.9");
    expect(datasetBudgetRefusal(request, 3000)).toBeUndefined();
    const refusal = datasetBudgetRefusal(request, 1);
    expect(refusal?.status).toBe(429);
    expect(refusal?.headers.get("Retry-After")).toBe("10");
    expect(refusal?.headers.get("Cache-Control")).toBe("no-store");
    await expect(refusal?.json()).resolves.toEqual({ error: DATASET_BUDGET_REFUSAL });
    expect(DATASET_BUDGET_REFUSAL).toBe("Too many requests. Wait a moment and try again.");
  });

  it("never refuses a request with no trusted address", async () => {
    for (let call = 0; call < 1300; call += 1) {
      expect(datasetBudgetRefusal(from(), HEAVY_REQUEST_COST)).toBeUndefined();
    }
    expect(takeDatasetBudget(NO_ADDRESS, 5000)).toBe(true);
    await meteredDatasetWork(from(), async () => undefined);
    expect(datasetBudgetSpent(NO_ADDRESS)).toBe(0);
    expect(datasetBudgetAddressCount()).toBe(0);
  });

  it("warns once in production when the trusted headers are missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    datasetBudgetRefusal(from(), 1);
    expect(warn).not.toHaveBeenCalled();

    vi.stubEnv("NODE_ENV", "production");
    datasetBudgetRefusal(from(), 1);
    datasetBudgetRefusal(from(), 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("neither X-Client-Ip nor CF-Connecting-IP");
    datasetBudgetRefusal(from("203.0.113.9"), 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("charges a short or a long query 25 units and a narrowed one a unit", () => {
    const cost = (query: string) => searchRequestCost(parseSearchQuery(query).terms);
    expect(cost("")).toBe(1);
    expect(cost("iron")).toBe(1);
    expect(cost("steel plate ingot")).toBe(1);
    expect(cost("zz")).toBe(25);
    expect(cost("lv motor")).toBe(25);
    expect(cost("iron steel plate ingot")).toBe(25);
  });
});
