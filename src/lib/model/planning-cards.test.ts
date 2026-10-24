import { describe, expect, test, vi } from "vitest";
import { cropsNhAvailable } from "@/lib/datasets/crops-availability";
import type { DatasetVersion, RecipeSummary } from "@/lib/datasets/types";
import { datasetHasCropsNh, planningCardsFor } from "./planning-cards";

/** One summary as `/api/datasets/local-2.9.0-rc-2/crops` serves it (toRecipeSummary), trimmed to what it names. */
const SERVED_2_9_CROP: Partial<RecipeSummary> = {
  id: "cropsnh:crop:wheat",
  name: "Crop Farm: Wheat",
  kind: "crop_produce",
  category: "cropsnh-crop",
  recipeMap: "Crop Farm",
  machineType: "Crop Farm",
};

describe("planning cards", () => {
  test("crop placeholder absent in 2.8.1 leaves the picker when the dataset has no CropsNH crops", async () => {
    const v281 = { id: "local-2.8.1" } as DatasetVersion;
    const v29 = { id: "local-2.9.0-rc-2" } as DatasetVersion;
    const load = vi.fn(async (_m: string, v: DatasetVersion) => ({
      crops: v.id === "local-2.8.1" ? [] : [{ category: "cropsnh-crop" }],
    }));
    const ids = async (v: DatasetVersion) =>
      planningCardsFor({ datasetHasCropsNh: await cropsNhAvailable("m", v, load) }).map((c) => c.id);
    expect(await ids(v281)).toEqual(["custom-rate", "fluid-tank"]);
    expect(await ids(v29)).toContain("crop-farm");
    await ids(v29);
    expect(load).toHaveBeenCalledTimes(2); // cached per dataset version
  });

  test("crop placeholder absent in 2.8.1 is offered on 2.9 from the served crop shape", () => {
    expect(datasetHasCropsNh([SERVED_2_9_CROP as RecipeSummary])).toBe(true);
    // A Crop Farm map recipe counts even with no category on it.
    expect(datasetHasCropsNh([{ category: undefined, recipeMap: "Crop Farm" }])).toBe(true);
    expect(datasetHasCropsNh([])).toBe(false);
    expect(datasetHasCropsNh([{ category: "ic2-crop", recipeMap: "IC2 Crops" }])).toBe(false);
    expect(planningCardsFor({ datasetHasCropsNh: true }).map((c) => c.id)).toEqual(["custom-rate", "fluid-tank", "crop-farm"]);
  });

  test("crop placeholder absent in 2.8.1 retries a failed crop list instead of caching it", async () => {
    const version = { id: "local-retry" } as DatasetVersion;
    const load = vi
      .fn<(m: string, v: DatasetVersion) => Promise<{ crops: Array<Partial<RecipeSummary>> }>>()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({ crops: [SERVED_2_9_CROP] });
    await expect(cropsNhAvailable("m", version, load)).rejects.toThrow("Failed to fetch");
    expect(await cropsNhAvailable("m", version, load)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
