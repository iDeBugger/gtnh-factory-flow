import { describe, expect, it } from "vitest";
import {
  steamMultiblocksWithoutFluidInput,
  steamMultiblocksWithoutFluidOutput,
  withoutSteamHandlersLackingFluidHatches,
} from "./steam-fluid-hatches.mjs";

const handler = (label, kind = "multiblock") => ({ id: label.toLowerCase().replace(/ /g, "-"), label, kind });
const presser = [handler("Forge Hammer", "single"), handler("Steam Presser"), handler("Industrial Sledgehammer")];
const fluidIn = [{ kind: "item", id: "ingot" }, { kind: "fluid", id: "lubricant" }];
const itemIn = [{ kind: "item", id: "ingot" }];
const itemOut = [{ kind: "item", id: "plate" }];
const fluidOut = [{ kind: "item", id: "plate" }, { kind: "fluid", id: "molten" }];

describe("steam multiblocks without a fluid input hatch", () => {
  it("leave a recipe with a fluid input on 2.8.1, where the Presser and Squasher have none", () => {
    expect(withoutSteamHandlersLackingFluidHatches(presser, fluidIn, itemOut, "2.8.1").map((entry) => entry.label)).toEqual([
      "Forge Hammer",
      "Industrial Sledgehammer",
    ]);
    expect(steamMultiblocksWithoutFluidInput("2.8.1").has("Steam Squasher")).toBe(true);
  });

  it("keep it on 2.9, where the Presser takes an input hatch", () => {
    expect(withoutSteamHandlersLackingFluidHatches(presser, fluidIn, itemOut, "2.9.0-RC-2")).toBe(presser);
  });

  it("leave the Separator off a fluid recipe on both packs, and keep it on an item-only one", () => {
    const centrifuge = [handler("Centrifuge", "single"), handler("Steam Separator")];
    for (const pack of ["2.8.1", "2.9.0-RC-2"]) {
      expect(withoutSteamHandlersLackingFluidHatches(centrifuge, fluidIn, itemOut, pack).map((entry) => entry.label)).toEqual([
        "Centrifuge",
      ]);
      expect(withoutSteamHandlersLackingFluidHatches(centrifuge, [{ kind: "item", id: "dust" }], itemOut, pack)).toBe(centrifuge);
    }
  });

  it("never touch a steam singleblock or a missing list", () => {
    const single = [handler("Steam Separator", "single")];
    expect(withoutSteamHandlersLackingFluidHatches(single, fluidIn, itemOut, "2.8.1")).toBe(single);
    expect(withoutSteamHandlersLackingFluidHatches(undefined, fluidIn, itemOut, "2.8.1")).toBeUndefined();
  });

  it("leave a recipe with a fluid output on both packs, except the Separator and Blender", () => {
    // Void protection is on by default (VOID_NONE), so no output hatch means no room for the fluid.
    for (const pack of ["2.8.1", "2.9.0-RC-2"]) {
      expect(withoutSteamHandlersLackingFluidHatches(presser, itemIn, fluidOut, pack).map((entry) => entry.label)).toEqual([
        "Forge Hammer",
        "Industrial Sledgehammer",
      ]);
      const blender = [handler("Mixer", "single"), handler("Steam Blender")];
      expect(withoutSteamHandlersLackingFluidHatches(blender, itemIn, fluidOut, pack)).toBe(blender);
      expect(steamMultiblocksWithoutFluidOutput(pack).has("Steam Separator")).toBe(false);
    }
    expect(withoutSteamHandlersLackingFluidHatches(presser, itemIn, itemOut, "2.8.1")).toBe(presser);
  });
});
