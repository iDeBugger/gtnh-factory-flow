import { describe, expect, it } from "vitest";
import {
  buildMachineHandlerTemplates,
  machineConfigControlsForOracleRecipe,
} from "./machine-configs.mjs";
import { wikiStatsForMachine } from "./machine-wiki-stats.mjs";
import { getMachineSettingWarning, getMachineStructuralParallels } from "../../../src/lib/solver/machine-effects.ts";

// Catalysts as the real 2.8.1 export lists them (GT5U 5.09.51.476), tooltips trimmed to the stat lines.
const ICO_281 = {
  resource: {
    kind: "item",
    id: "gregtech:gt.blockmachines@791",
    displayName: "Industrial Coke Oven",
    tooltip: [
      "Industrial Coke Oven",
      "Machine Type: Coke Oven, ICO",
      "18 Parallels with Heat Resistant Casings",
      "30 Parallels with Heat Proof Casings",
      "-4% EU Usage per Voltage Tier",
    ],
  },
  sourceClass: "gtPlusPlus.xmod.gregtech.common.tileentities.machines.multi.processing.MTEIndustrialCokeOven",
  multiblock: true,
};
const ICF_281 = {
  resource: {
    kind: "item",
    id: "gregtech:gt.blockmachines@992",
    displayName: "Industrial Cutting Factory",
    tooltip: [
      "Industrial Cutting Factory",
      "Machine Type: Cutting Machine, Slicing Machine, ICF",
      "4 Parallels per Voltage Tier",
      "300% Speed",
      "75% EU Usage",
    ],
  },
  priority: -1,
  sourceClass: "gtPlusPlus.xmod.gregtech.common.tileentities.machines.multi.processing.MTEIndustrialCuttingMachine",
  multiblock: true,
};
const DANGOTE_281 = {
  resource: {
    kind: "item",
    id: "gregtech:gt.blockmachines@31021",
    displayName: "Dangote Distillus",
    tooltip: [
      "Dangote Distillus",
      "Machine Type: Distillery, Distillation Tower",
      "Stats dictated by tower mode",
      "-----------------------------------------",
      "Distillery Mode (requires full height tower)",
      "8 * Voltage Tier Parallels",
      "200% Speed",
      "15% EU Usage",
      "-----------------------------------------",
      "Distillation Tower Mode",
      "12 Parallels",
      "350% Speed",
      "100% EU Usage",
    ],
  },
  sourceClass: "gtPlusPlus.xmod.gregtech.common.tileentities.machines.multi.processing.advanced.MTEAdvDistillationTower",
  multiblock: true,
};
const BASIC_DISTILLERY_281 = {
  resource: {
    kind: "item",
    id: "gregtech:gt.blockmachines@531",
    displayName: "Basic Distillery",
    tooltip: ["Basic Distillery", "Machine Type: Distillery", "Voltage IN: 32 (LV)"],
  },
  sourceClass: "gregtech.api.metatileentity.implementations.MTEBasicMachineWithRecipe",
  multiblock: false,
};
const MDT_281 = {
  resource: {
    kind: "item",
    id: "gregtech:gt.blockmachines@12738",
    displayName: "Mega Distillation Tower",
    tooltip: ["Mega Distillation Tower", "Machine Type: Distillery, MDT", "256 Parallels"],
  },
  priority: -1,
  sourceClass: "bartworks.common.tileentities.multis.mega.MTEMegaDistillTower",
  multiblock: true,
};

const controlIds = (controls) => controls.map((control) => control.id);
const cokeOvenControls = (gtnhVersion) => machineConfigControlsForOracleRecipe("Industrial Coke Oven", 0, [], gtnhVersion);

describe("machine-configs.mjs on a 2.8.1 export", () => {
  it("machine-configs.mjs: industrial coke oven coil is not offered on 2.8.1", () => {
    expect(controlIds(cokeOvenControls("2.8.1"))).not.toContain("heatingCoil");
    // 2.9 keeps its coils and slices, and so does an export with no version given.
    expect(controlIds(cokeOvenControls("2.9"))).toEqual(["heatingCoil", "cokeOvenCasing", "cokeOvenSlices"]);
    expect(cokeOvenControls(undefined)).toEqual(cokeOvenControls("2.9"));
  });

  it("machine-configs.mjs: industrial coke oven casing is 18 or 30 on 2.8.1", () => {
    const controls = cokeOvenControls("2.8.1");
    expect(controlIds(controls)).toEqual(["cokeOvenCasing"]);
    const [casing] = controls;
    // The app reads the key as the parallel count (overrides-2.8.1/gtpp-knobs.ts), so the keys are exactly these.
    expect(casing.tiers.map((tier) => tier.key)).toEqual(["18", "30"]);
    expect(casing.tiers.map((tier) => tier.parallelMultiplier)).toEqual([18, 30]);
    expect(casing.tiers.map((tier) => tier.resource.tooltip)).toEqual([
      ["Coke Oven casing tier", "Parallels: 18"],
      ["Coke Oven casing tier", "Parallels: 30"],
    ]);
    expect(casing.tiers.map((tier) => tier.label)).toEqual(["Heat Resistant", "Heat Proof"]);
    expect(casing.minimumKey).toBe("18");
    expect(casing.defaultKey).toBe("18");

    const casing29 = cokeOvenControls("2.9").find((control) => control.id === "cokeOvenCasing");
    expect(casing29.tiers.map((tier) => tier.key)).toEqual(["heat_resistant", "heat_proof"]);
    expect(casing29.tiers.map((tier) => tier.parallelMultiplier)).toEqual([16, 32]);
  });

  it("the app reads the 2.8.1 casing control as 18 and 30 parallels, with no warning", () => {
    const recipe = {
      machineType: "Industrial Coke Oven",
      source: { recipeMap: "Industrial Coke Oven" },
      minimumTier: "LV",
      durationTicks: 1800,
      eut: 0,
      machineConfigControls: cokeOvenControls("2.8.1"),
    };
    const node = (cokeOvenCasing) => ({ overclockTier: "IV", machineConfigTiers: { cokeOvenCasing } });
    expect(getMachineStructuralParallels(recipe, node("18"), "2.8.1")).toBe(18);
    expect(getMachineStructuralParallels(recipe, node("30"), "2.8.1")).toBe(30);
    expect(getMachineSettingWarning(recipe, node("30"), "2.8.1")).toBeUndefined();
  });

  it("the Railcraft brick oven's map stays without knobs on 2.8.1", () => {
    expect(machineConfigControlsForOracleRecipe("Coke Oven", 0, [], "2.8.1") ?? []).toEqual([]);
  });

  it("the 2.8.1 Industrial Coke Oven handler carries no coil or slices from its tooltip", () => {
    const [handler] = buildMachineHandlerTemplates("Industrial Coke Oven", [ICO_281], new Set(), "2.8.1");
    expect(handler.id).toBe("industrial-coke-oven");
    expect(controlIds(handler.machineConfigControls ?? [])).toEqual([]);
  });
});

describe("machine-wiki-stats.mjs on a 2.8.1 export", () => {
  it("machine-wiki-stats.mjs: industrial cutting factory offers no sawblade on 2.8.1", () => {
    expect(wikiStatsForMachine("Industrial Cutting Factory", "Cutting Machine", "2.8.1")).toBeUndefined();
    expect(wikiStatsForMachine("Industrial Cutting Factory", "Cutting Machine", "2.9")?.selector.id).toBe("cuttingSawblade");
    expect(wikiStatsForMachine("Industrial Cutting Factory", "Cutting Machine")?.selector.id).toBe("cuttingSawblade");
  });

  it("the 2.8.1 Industrial Cutting Factory keeps its tooltip stats: 3x speed, 75% EU, 4 per tier", () => {
    const icf = buildMachineHandlerTemplates("Cutting Machine", [ICF_281], new Set(), "2.8.1")[0];
    expect(icf.kind).toBe("multiblock");
    expect(controlIds(icf.machineConfigControls)).toEqual(["voltageParallel"]);
    expect(icf.machineConfigControls[0].tiers[0].parallelPerVoltageTier).toBe(4);
    expect(icf.durationMultiplier).toBeCloseTo(1 / 3);
    expect(icf.eutMultiplier).toBeCloseTo(0.75);

    const icf29 = buildMachineHandlerTemplates("Cutting Machine", [ICF_281], new Set(), "2.9")[0];
    expect(controlIds(icf29.machineConfigControls)).toEqual(["voltageParallel", "cuttingSawblade"]);
  });

  it("other wiki entries stay on 2.8.1", () => {
    expect(wikiStatsForMachine("Dangote Distillus", "Distillery", "2.8.1")).toBe(
      wikiStatsForMachine("Dangote Distillus", "Distillery", "2.9"),
    );
  });
});

describe("the Mega Distillation Tower on a 2.8.1 export", () => {
  // GT5U 5.09.51.476 bartworks/common/tileentities/multis/mega/MTEMegaDistillTower.java:249-250 runs only the
  // distillation tower map, and the 2.8.1 export lists it as a catalyst there and not on the distillery map.
  // Handlers come only from a map's catalysts, so the distillery never offers it.
  it("is no Distillery handler, and stays a Distillation Tower handler", () => {
    const distillery = buildMachineHandlerTemplates("Distillery", [DANGOTE_281, BASIC_DISTILLERY_281], new Set(), "2.8.1");
    expect(distillery.map((template) => template.id).sort()).toEqual(["dangote-distillus", "distillery"]);
    const tower = buildMachineHandlerTemplates("Distillation Tower", [DANGOTE_281, MDT_281], new Set(), "2.8.1");
    expect(tower.map((template) => template.id)).toContain("mega-distillation-tower");
  });
});
