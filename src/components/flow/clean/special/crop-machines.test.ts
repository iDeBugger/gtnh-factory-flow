import { describe, expect, it } from "vitest";
import {
  CROP_HARVESTER_INDUSTRIAL_FARM_ID,
  CROP_HARVESTER_MANAGER_ID,
  type CropHarvesterSetup,
} from "@/lib/model/passive-production";
import { CROP_MACHINES_ID } from "../menus/settings-model";
import { cropMachinesNotes, cropMachinesSetting } from "./use-special";

const setup = (id: CropHarvesterSetup["id"], tierIndex: number, subSoil = false): CropHarvesterSetup => ({
  id,
  tierIndex,
  growthUnits: 0,
  fertilizerUnits: 0,
  harvestUnits: 0,
  environmentUnits: 0,
  overclocks: 0,
  fertilized: false,
  subSoil,
});

describe("a crop card's harvesters", () => {
  it("are the machines its seeds fill: an LV Crop Manager holds its 11 x 11 reach, three deep, less its own block", () => {
    const planted: number[] = [];
    const lv = cropMachinesSetting(setup(CROP_HARVESTER_MANAGER_ID, 1), 400, (seeds) => planted.push(seeds))!;
    // 11 x 11 x 3 - 1 = 362 sticks a manager: 400 seeds fill two.
    expect([lv.id, lv.label, lv.value, lv.text, lv.pinDefault]).toEqual([CROP_MACHINES_ID, "Crop Managers", "2", "2", true]);
    expect(cropMachinesNotes(setup(CROP_HARVESTER_MANAGER_ID, 1), "LV")).toEqual([
      "One LV Crop Manager reaches 11 x 11, 3 layers deep: 362 crop sticks with every block planted.",
      "Set a number to plant that many full machines.",
    ]);
    // Typed or stepped, it plants that many full machines of seeds.
    lv.commit("3");
    lv.step(1);
    lv.step(-1);
    expect(planted).toEqual([3 * 362, 3 * 362, 1 * 362]);
  });

  it("writes nothing below one machine, and nothing that is not a number", () => {
    const planted: number[] = [];
    const one = cropMachinesSetting(setup(CROP_HARVESTER_MANAGER_ID, 1), 10, (seeds) => planted.push(seeds))!;
    one.step(-1);
    one.commit("0");
    one.commit("many");
    expect(planted).toEqual([]);
    one.commit("1,000");
    expect(planted).toEqual([362_000]);
  });

  it("names a seed bed's farms and is gone for a hand-picked crop", () => {
    const farm = cropMachinesSetting(setup(CROP_HARVESTER_INDUSTRIAL_FARM_ID, 1), 0, () => undefined)!;
    expect([farm.label, farm.value]).toEqual(["Industrial Farms", "0"]);
    expect(cropMachinesNotes(setup(CROP_HARVESTER_INDUSTRIAL_FARM_ID, 1), "LV")[0]).toBe("One LV seed bed holds 121 seeds.");
    expect(cropMachinesSetting(setup(CROP_HARVESTER_MANAGER_ID, -1), 10, () => undefined)).toBeUndefined();
    expect(cropMachinesSetting(undefined, 10, () => undefined)).toBeUndefined();
  });
});
