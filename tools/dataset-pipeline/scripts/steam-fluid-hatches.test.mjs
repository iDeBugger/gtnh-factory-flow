import { describe, expect, it } from "vitest";
import { steamMultiblocksWithoutFluidInput, withoutSteamHandlersLackingFluidInput } from "./steam-fluid-hatches.mjs";

const handler = (label, kind = "multiblock") => ({ id: label.toLowerCase().replace(/ /g, "-"), label, kind });
const presser = [handler("Forge Hammer", "single"), handler("Steam Presser"), handler("Industrial Sledgehammer")];
const fluidIn = [{ kind: "item", id: "ingot" }, { kind: "fluid", id: "lubricant" }];

describe("steam multiblocks without a fluid input hatch", () => {
  it("leave a recipe with a fluid input on 2.8.1, where the Presser and Squasher have none", () => {
    expect(withoutSteamHandlersLackingFluidInput(presser, fluidIn, "2.8.1").map((entry) => entry.label)).toEqual([
      "Forge Hammer",
      "Industrial Sledgehammer",
    ]);
    expect(steamMultiblocksWithoutFluidInput("2.8.1").has("Steam Squasher")).toBe(true);
  });

  it("keep it on 2.9, where the Presser takes an input hatch", () => {
    expect(withoutSteamHandlersLackingFluidInput(presser, fluidIn, "2.9.0-RC-2")).toBe(presser);
  });

  it("leave the Separator off a fluid recipe on both packs, and keep it on an item-only one", () => {
    const centrifuge = [handler("Centrifuge", "single"), handler("Steam Separator")];
    for (const pack of ["2.8.1", "2.9.0-RC-2"]) {
      expect(withoutSteamHandlersLackingFluidInput(centrifuge, fluidIn, pack).map((entry) => entry.label)).toEqual([
        "Centrifuge",
      ]);
      expect(withoutSteamHandlersLackingFluidInput(centrifuge, [{ kind: "item", id: "dust" }], pack)).toBe(centrifuge);
    }
  });

  it("never touch a steam singleblock or a missing list", () => {
    const single = [handler("Steam Separator", "single")];
    expect(withoutSteamHandlersLackingFluidInput(single, fluidIn, "2.8.1")).toBe(single);
    expect(withoutSteamHandlersLackingFluidInput(undefined, fluidIn, "2.8.1")).toBeUndefined();
  });
});
