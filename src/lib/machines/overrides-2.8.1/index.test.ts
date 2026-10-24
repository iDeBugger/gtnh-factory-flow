import { describe, expect, test } from "vitest";
import {
  getMachineBehaviour,
  getMachineHiddenControlIds,
  getMachineTableControls,
  machineTableNames,
  machineTableSeedsFromBase,
} from "../machine-table";
import { fdiv, floatBonus, fmul, speedFromBonus } from "../java-float";
import { MACHINE_OVERRIDES_2_8_1, mergeOverrideGroups } from ".";
import { coefficients, ctx } from "./test-helpers";

describe("2.8.1 machine overrides", () => {
  test("machine-table.ts 2.8.1 override keys are table names", () => {
    for (const name of Object.keys(MACHINE_OVERRIDES_2_8_1)) expect(machineTableNames()).toContain(name);
  });

  test("machine-table.ts 2.8.1 override groups never share a machine", () => {
    expect(() => mergeOverrideGroups({ a: { Volcanus: {} }, b: { Volcanus: {} } })).toThrow(
      "Volcanus is overridden in both a and b",
    );
  });

  test("machine-table.ts 2.8.1 overrides apply through aliases", () => {
    const o = { "2.8.1": { "Multiblock Electrolyzer": { parallels: 7 } } };
    expect(getMachineBehaviour("Industrial Electrolyzer", "2.8.1", o)?.parallels).toBe(7);
    expect(getMachineBehaviour("Industrial Electrolyzer", "2.9", o)?.parallels).toBe(
      getMachineBehaviour("Industrial Electrolyzer", "2.9")?.parallels,
    );
  });

  test("machine-table.ts 2.8.1 lookups never leak into 2.9", () => {
    const o = { "2.8.1": { Volcanus: { parallels: 99 } } };
    getMachineBehaviour("Volcanus", "2.8.1", o);
    expect(getMachineBehaviour("Volcanus", "2.9", o)?.parallels).toBe(8);
  });

  test("machine-table.ts 2.8.1 control overrides reach the wrappers", () => {
    const o = {
      "2.8.1": {
        "Industrial Mixing Machine": {
          controls: [],
          hidesControls: ["pipeCasing", "itemPipeCasing"],
          speed: 1,
          power: 1,
        },
      },
    };
    expect(getMachineTableControls("Industrial Mixing Machine", undefined, "2.8.1", o)).toEqual([]);
    expect(getMachineHiddenControlIds("Industrial Mixing Machine", "2.8.1", o)).toContain("itemPipeCasing");
    expect(machineTableSeedsFromBase("Industrial Mixing Machine", "2.8.1", o)).toBe(true);
    expect(getMachineTableControls("Industrial Mixing Machine", undefined, "2.9", o).map((c) => c.id)).toEqual([
      "itemPipeCasing",
    ]);
    expect(getMachineHiddenControlIds("Industrial Mixing Machine", "2.9", o)).toEqual(
      getMachineHiddenControlIds("Industrial Mixing Machine", "2.9"),
    );
  });

  test("java float bonus round-trips through speed", () => {
    expect(1 / speedFromBonus(floatBonus(2.2))).toBe(Math.fround(1 / Math.fround(2.2)));
    expect(Math.floor(22 * floatBonus(2.2))).toBe(9);
    for (const divisor of [1.5, 2.2, 2.25, 2.5, 2.8, 3, 3.5, 5, 6]) {
      const bonus = floatBonus(divisor);
      expect(1 / speedFromBonus(bonus)).toBe(bonus);
    }
  });

  test("machine-table.ts 2.8.1 test helpers read the version's table", () => {
    expect(ctx("2.8.1").gameVersion).toBe("2.8.1");
    expect(ctx("2.9", { voltageTier: 3 }).voltageTier).toBe(3);
    const volcanus = coefficients("Volcanus", "2.9");
    expect(volcanus.parallels).toBe(8);
    expect(volcanus.durationMultiplier).toBe(1 / volcanus.speed);
  });
});

test("java float multiply and divide round each step", () => {
  expect(fmul(22, 0.45)).toBe(Math.fround(22 * Math.fround(0.45)));
  expect(fdiv(1, 2.2)).toBe(floatBonus(2.2));
});

describe("speed and durationMultiplier through a version merge", () => {
  test("machine-table.ts no merged entry in either version states both speed and durationMultiplier", () => {
    // durationMultiplier wins over speed, so an entry carrying both would silently ignore whichever an override set.
    for (const gameVersion of ["2.9", "2.8.1"] as const) {
      for (const name of machineTableNames()) {
        const behaviour = getMachineBehaviour(name, gameVersion);
        if (!behaviour) continue;
        expect(
          behaviour.speed !== undefined && behaviour.durationMultiplier !== undefined,
          `${name} on ${gameVersion}`,
        ).toBe(false);
      }
    }
  });

  test("machine-table.ts an override that states only speed replaces the base's durationMultiplier", () => {
    const o = { "2.8.1": { "Mega Alloy Blast Smelter": { speed: 4 } } };
    const merged = getMachineBehaviour("Mega Alloy Blast Smelter", "2.8.1", o);
    expect(merged?.speed).toBe(4);
    expect(merged?.durationMultiplier).toBeUndefined();
  });

  test("machine-table.ts an override that states only durationMultiplier replaces the base's speed", () => {
    const o = { "2.8.1": { "Large Fluid Extractor": { durationMultiplier: 0.5 } } };
    const merged = getMachineBehaviour("Large Fluid Extractor", "2.8.1", o);
    expect(merged?.durationMultiplier).toBe(0.5);
    expect(merged?.speed).toBeUndefined();
  });
});
