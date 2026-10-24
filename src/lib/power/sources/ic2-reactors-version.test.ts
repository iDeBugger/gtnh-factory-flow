import { expect, it } from "vitest";
import type { GameVersion } from "@/lib/model/game-version";
import { getPowerSource } from "../registry";
import { buildPowerSettingsReader, type PowerModel } from "../types";

/**
 * The IC2 reactor cards on 2.8.1 and 2.9. Every input the cards model is
 * byte-identical between the two packs (docs/audits/2-8-1-ic2-reactors.md):
 * IC2 2.2.828a-experimental and 2.2.828-experimental differ only in
 * ic2/lang/en_US.properties, the pack's IC2.ini is the same file, and GT5U
 * 5.09.51.476 and 5.09.54.205 define the same rods and coolant cells in
 * LoaderGTBlockFluid with an unchanged ItemRadioactiveCellIC and
 * ItemCoolantCellIC. So each 2.8.1 number here equals its 2.9 twin.
 */
function compute(sourceId: string, gameVersion: GameVersion, settings: Record<string, string> = {}): PowerModel {
  const source = getPowerSource(sourceId, gameVersion);
  if (!source) {
    throw new Error(`No power source ${sourceId}`);
  }
  return source.compute(buildPowerSettingsReader(source, settings, gameVersion), gameVersion);
}

const flow = (lines: PowerModel["inputs"], name: string) => lines.find((line) => line.name === name)?.perSecond;

// Top-level tests so each name starts with the audit row's Item text.
for (const gameVersion of ["2.8.1", "2.9"] satisfies GameVersion[]) {
  it(`ic2-fluid-reactor ${gameVersion} heats the workbook design rates`, () => {
    for (const [design, rate] of [
      ["design-1", 1150],
      ["design-2", 1380],
      ["design-3", 1340],
    ] as const) {
      const model = compute("ic2-fluid-reactor", gameVersion, { design });
      expect(model.euPerTick).toBe(0);
      expect(flow(model.inputs, "Coolant")).toBe(rate);
      expect(flow(model.outputs, "Hot Coolant")).toBe(rate);
    }
    const custom = compute("ic2-fluid-reactor", gameVersion, { design: "custom", customRate: "2000" });
    expect(flow(custom.outputs, "Hot Coolant")).toBe(2000);
  });

  it(`vacuum-reactor ${gameVersion} burns quad uranium at 43,600 EU/t`, () => {
    // ItemRadioactiveCellIC rodUranium4: 4 cells, 20,000 s, sEnergy 2, sHeat 4;
    // IC2.ini nuclear = 5.0. 3 pulses per cell plus neighbours, 50 EU a pulse.
    const model = compute("vacuum-reactor", gameVersion, { fuel: "uranium-4", coolant: "he-360k", coreTemp: "98" });
    expect(model.euPerTick).toBe(43_600);
    expect(flow(model.inputs, "Quad Fuel Rod (Uranium)")).toBeCloseTo(40 / 20_000, 12);
    expect(flow(model.outputs, "Quad Fuel Rod (Depleted Uranium)")).toBeCloseTo(40 / 20_000, 12);
    // Per rod 8 x (3 + n)(4 + n) heat a second for n rod neighbours: 160, 240, 336. The 14 cells
    // take 4 x 160 + 14 x 240 + 22 x 336 = 11,392, so 813.71 on average; the hottest sits
    // beside four three-neighbour rods, 4 x 336 = 1,344.
    expect(model.stats.find((line) => line.label === "Cell heat")?.value).toBe("813.71/s avg, 1,344/s max");
  });

  it(`vacuum-reactor ${gameVersion} multiplies MOX by 1 + 1.5 x core temp`, () => {
    const model = compute("vacuum-reactor", gameVersion, { fuel: "mox-4", coolant: "he-360k", coreTemp: "98" });
    expect(model.euPerTick).toBeCloseTo(43_600 * (1 + 1.5 * 0.98), 6);
    expect(flow(model.inputs, "Quad Fuel Rod (MOX)")).toBeCloseTo(40 / 10_000, 12);
  });

  it(`vacuum-reactor ${gameVersion} keeps the quad naquadah rod's sHeat of 1`, () => {
    // LoaderGTBlockFluid rodNaquadah4: sHeat 1F where the single and dual say 4F.
    const quad = compute("vacuum-reactor", gameVersion, { fuel: "naquadah-4", coolant: "he-360k" });
    expect(quad.euPerTick).toBe(2 * 43_600);
    expect(quad.stats.find((line) => line.label === "Cell heat")?.value).toContain("336/s max");
  });
}
