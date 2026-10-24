import { describe, expect, test } from "vitest";
import { getMachineBehaviour } from "../machine-table";
import { ABSENT_OVERRIDES } from "./absent";

const ABSENT_MACHINES = [
  "Exothermic Hearth",
  "Industrial Arc Furnace",
  "Endothermic Fridge",
  "Steam Hearth",
  "Spinmatron-2737",
  "Industrial Chemical Bath",
  "Industrial Bending Machine",
  "Mass Solidifier",
  "L.A.T.E.X.",
];

describe("machines absent in 2.8.1", () => {
  test.each(ABSENT_MACHINES)("%s absent in 2.8.1 has no table entry there", (name) => {
    expect(ABSENT_OVERRIDES[name]).toBeNull();
    expect(getMachineBehaviour(name, "2.8.1")).toBeUndefined();
    expect(getMachineBehaviour(name, "2.9")).toBeDefined();
  });

  test("Industrial Arc Furnace absent in 2.8.1 leaves GT++'s High Current Industrial Arc Furnace off the kubatech entry", () => {
    expect(getMachineBehaviour("High Current Industrial Arc Furnace", "2.8.1")).toBeUndefined();
    expect(getMachineBehaviour("High Current Industrial Arc Furnace", "2.9")).toBeUndefined();
  });

  test("Exothermic Hearth absent in 2.8.1 lists exactly the absent machines", () => {
    expect(Object.keys(ABSENT_OVERRIDES).sort()).toEqual([...ABSENT_MACHINES].sort());
  });
});
