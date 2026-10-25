import { describe, expect, it } from "vitest";
import { applyIcon, clearUnresolvedIconPathTextureHint, resourceKey } from "./icon-hints.mjs";

describe("unresolved asset hints", () => {
  it("leave a resource whose hint matched no texture with no iconPath, on every copy", () => {
    const icons = new Map();
    const catalog = { kind: "aspect", id: "thaumcraft:aspect:radio", iconPath: "asset:gregtech:textures/aspects/RADIO.png" };
    const slot = { ...catalog, amount: 2 };
    applyIcon(catalog, icons);
    applyIcon(slot, icons);
    expect("iconPath" in catalog).toBe(false);
    expect("iconPath" in slot).toBe(false);
  });

  it("never let a hint block the icon the key resolved to", () => {
    const icons = new Map([["item:gregtech:x", "/datasets/gtnh/v/textures/item/x-0123456789ab.png"]]);
    const slot = { kind: "item", id: "gregtech:x", iconPath: "asset:gregtech:textures/items/x.png" };
    applyIcon(slot, icons);
    expect(slot.iconPath).toBe("/datasets/gtnh/v/textures/item/x-0123456789ab.png");
  });

  it("keep a rendered icon and give an iconless resource the one its key resolved to", () => {
    const icons = new Map([["item:minecraft:glass", "/datasets/gtnh/v/textures/item/glass-0123456789ab.png"]]);
    const rendered = { kind: "item", id: "minecraft:glass", iconPath: "/datasets/gtnh/v/textures/rendered/glass-aaaaaaaaaaaa.png" };
    const bare = { kind: "item", id: "minecraft:glass" };
    const unknown = { kind: "item", id: "minecraft:stone" };
    applyIcon(rendered, icons);
    applyIcon(bare, icons);
    applyIcon(unknown, icons);
    expect(rendered.iconPath).toBe("/datasets/gtnh/v/textures/rendered/glass-aaaaaaaaaaaa.png");
    expect(bare.iconPath).toBe("/datasets/gtnh/v/textures/item/glass-0123456789ab.png");
    expect("iconPath" in unknown).toBe(false);
    expect(resourceKey(bare)).toBe("item:minecraft:glass");
  });

  it("clear only an asset hint", () => {
    const kept = { kind: "aspect", id: "a", iconPath: "/nei/thaumcraft/aspects/ignis.png" };
    clearUnresolvedIconPathTextureHint(kept);
    expect(kept.iconPath).toBe("/nei/thaumcraft/aspects/ignis.png");
  });
});
