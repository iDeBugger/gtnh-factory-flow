import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastInk, mixHex } from "./colors";
import { CC, drawerMixes, tierChipColors } from "./tokens";

describe("clean colours", () => {
  it("clean.css's tokens are the same colours as tokens.ts", () => {
    const css = readFileSync(path.join(__dirname, "clean.css"), "utf8");
    const mirrored: string[] = [];
    for (const [key, hex] of Object.entries(CC)) {
      const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const match = css.match(new RegExp(`--cc-${name}:\\s*(#[0-9a-fA-F]{6})`));
      if (!match) continue;
      mirrored.push(key);
      expect(match[1]!.toUpperCase(), key).toBe(hex.toUpperCase());
    }
    expect(mirrored).toContain("flash");
    expect(mirrored).toContain("select");
  });

  it("mixes the way the mod's Hyb.mix does (per channel, rounded)", () => {
    // spec section 1: source edge = mix(tint, edge, .55), computed from the mod's code
    expect(mixHex(CC.source, CC.edge, 0.55)).toBe("#597CA1");
    expect(mixHex(CC.product, CC.edge, 0.55)).toBe("#9E6D4E");
    expect(mixHex(CC.trash, CC.edge, 0.55)).toBe("#636976");
  });

  it("derives the drawer table from the palette", () => {
    const source = drawerMixes("source");
    expect(source.frameEdge).toBe("#4F6986");
    expect(source.barFill).toBe("#344252");
    expect(source.barFillHot).toBe("#3E536B");
    expect(source.bodyFill).toBe("#292F38");
    expect(source.stripe).toBe("#2E3844");
    expect(source.glanceFill).toBe("#2C343E");
    expect(source.numberInk).toBe("#94C3F3");
    const product = drawerMixes("product");
    expect(product.frameEdge).toBe("#815E49");
    expect(product.bodyFill).toBe("#322D2E");
    expect(product.numberInk).toBe("#F2AE81");
    expect(drawerMixes("trash").bodyFill).toBe("#2A2D33");
  });

  it("labels a flat chip black or white by luminance, black on LuV", () => {
    expect(contrastInk("#FF55FF")).toBe("#111111");
    expect(contrastInk("#5555FF")).toBe("#FFFFFF");
    expect(tierChipColors("LuV")?.ink).toBe("#111111");
    expect(tierChipColors("EV")?.ink).toBe("#FFFFFF");
    expect(tierChipColors("HV")?.ink).toBe("#111111");
  });

  it("underlines from UV up and not before", () => {
    expect(tierChipColors("ZPM")?.underline).toBe(false);
    expect(tierChipColors("UV")?.underline).toBe(true);
    expect(tierChipColors("nope")).toBeUndefined();
  });

  it("hovers 88% bg and presses 92% bg", () => {
    const hv = tierChipColors("HV")!;
    expect(hv.hover).toBe(mixHex(hv.background, "#FFFFFF", 0.88));
    expect(hv.pressed).toBe(mixHex(hv.background, "#000000", 0.92));
  });
});
