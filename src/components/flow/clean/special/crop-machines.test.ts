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
const LV_MANAGER = setup(CROP_HARVESTER_MANAGER_ID, 1);
/** 11 x 11 reach, three deep, less the manager's own block. */
const LV = 362;

describe("a crop card's harvesters", () => {
  it("on Any, are the machines the plan's seeds fill: an LV Crop Manager holds 362 sticks", () => {
    const planted: Array<number | undefined> = [];
    const any = cropMachinesSetting(LV_MANAGER, { solved: 400, set: undefined }, (seeds) => planted.push(seeds))!;
    expect([any.id, any.label, any.value, any.text, any.pinDefault]).toEqual([CROP_MACHINES_ID, "Crop Managers", "2", "2", true]);
    expect(cropMachinesNotes(LV_MANAGER, "LV")).toEqual([
      "One LV Crop Manager reaches 11 x 11, 3 layers deep: 362 crop sticks with every block planted.",
      "Set a number to plant that many full machines.",
    ]);
    // Typed or stepped, it plants that many full machines of seeds.
    any.commit("3");
    any.step(1);
    any.step(-1);
    expect(planted).toEqual([3 * LV, 3 * LV, 1 * LV]);
  });

  it("with a count set, reads the seeds set, not what the line lets run, and steps both ways from it", () => {
    // Up to 724 seeds (two managers typed), the line downstream takes only 300 seeds' worth.
    const planted: Array<number | undefined> = [];
    const set = cropMachinesSetting(LV_MANAGER, { solved: 300, set: 2 * LV }, (seeds) => planted.push(seeds))!;
    expect(set.value).toBe("2");
    set.step(1);
    set.step(-1);
    expect(planted).toEqual([3 * LV, 1 * LV]);
  });

  it("clears a set count below one machine, and writes nothing on Any or for text that is not a number", () => {
    const planted: Array<number | undefined> = [];
    const one = cropMachinesSetting(LV_MANAGER, { solved: 10, set: LV }, (seeds) => planted.push(seeds))!;
    one.step(-1);
    one.commit("0");
    one.commit("many");
    expect(planted).toEqual([undefined, undefined]);
    one.commit("1,000");
    expect(planted.at(-1)).toBe(1000 * LV);
    const empty: Array<number | undefined> = [];
    const any = cropMachinesSetting(LV_MANAGER, { solved: 10, set: undefined }, (seeds) => empty.push(seeds))!;
    any.step(-1);
    any.commit("0");
    expect(empty).toEqual([]);
  });

  it("names a seed bed's farms and is gone for a hand-picked crop", () => {
    const farm = cropMachinesSetting(setup(CROP_HARVESTER_INDUSTRIAL_FARM_ID, 1), { solved: 0, set: undefined }, () => undefined)!;
    expect([farm.label, farm.value]).toEqual(["Industrial Farms", "0"]);
    expect(cropMachinesNotes(setup(CROP_HARVESTER_INDUSTRIAL_FARM_ID, 1), "LV")[0]).toBe("One LV seed bed holds 121 seeds.");
    expect(cropMachinesSetting(setup(CROP_HARVESTER_MANAGER_ID, -1), { solved: 10, set: undefined }, () => undefined)).toBeUndefined();
    expect(cropMachinesSetting(undefined, { solved: 10, set: undefined }, () => undefined)).toBeUndefined();
  });
});
