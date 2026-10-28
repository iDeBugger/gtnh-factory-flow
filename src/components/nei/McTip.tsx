import "./nei.css";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getUiScale } from "@/lib/ui-scale";

/**
 * Minecraft's tooltip text: the name first in white, then grey lines, the mod's name last in blue italics, the
 * way the game and NEI write an item's tooltip.
 */
export interface McTipLine {
  text: string;
  tone?: "name" | "grey" | "mod" | "hint";
}

export function McTipLines({ lines }: { lines: readonly McTipLine[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <div key={index} className="mc-tip-line" data-tone={line.tone && line.tone !== "grey" ? line.tone : undefined}>
          {line.text}
        </div>
      ))}
    </>
  );
}

/**
 * A Minecraft tooltip at the pointer, shown at once as the game shows an item's: 12 px right of and above the
 * pointer, kept on screen. `x` and `y` are real (unzoomed) pixels; the panel is a body portal wearing `.ui-zoom`.
 */
export function McFloatingTip({ lines, x, y }: { lines: readonly McTipLine[]; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 200, h: 40 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setSize((current) => (current.w === w && current.h === h ? current : { w, h }));
  }, [lines]);
  if (typeof document === "undefined") return null;
  const scale = getUiScale();
  const vw = window.innerWidth / scale;
  const vh = window.innerHeight / scale;
  // The game puts the box right of the pointer and flips it left when it would run off the screen.
  let left = x / scale + 12;
  if (left + size.w > vw - 4) left = x / scale - 16 - size.w;
  const top = Math.max(4, Math.min(y / scale - 12, vh - size.h - 4));
  return createPortal(
    <div
      ref={ref}
      className="mc-tip ui-zoom pointer-events-none fixed z-[9999] w-max max-w-[420px]"
      data-minecraft-tooltip="true"
      style={{ left: Math.max(4, left), top }}
    >
      <McTipLines lines={lines} />
    </div>,
    document.body,
  );
}

/** What NEI names a mod by, from the id's prefix; an unknown prefix keeps its own spelling, capitalised. */
const MOD_NAMES: Record<string, string> = {
  minecraft: "Minecraft",
  gregtech: "GregTech",
  gt: "GregTech",
  ic2: "IndustrialCraft 2",
  bartworks: "BartWorks",
  miscutils: "GT++",
  gtplusplus: "GT++",
  dreamcraft: "GT: New Horizons",
  newhorizonscoremod: "GT: New Horizons",
  gtnhlanth: "GTNH: Lanthanides",
  tectech: "TecTech",
  goodgenerator: "Good Generator",
  kekztech: "KekzTech",
  ggfab: "GigaGramFab",
  thaumcraft: "Thaumcraft",
  forestry: "Forestry",
  appliedenergistics2: "Applied Energistics 2",
  biomesoplenty: "Biomes O' Plenty",
  harvestcraft: "Pam's HarvestCraft",
  enderio: "Ender IO",
  thermalfoundation: "Thermal Foundation",
  thermalexpansion: "Thermal Expansion",
  galacticraftcore: "Galacticraft",
  galacticraftmars: "Galacticraft Planets",
  galaxyspace: "GalaxySpace",
  extrautilities: "Extra Utilities",
  botania: "Botania",
  bloodmagic: "Blood Magic",
  avaritia: "Avaritia",
  tconstruct: "Tinkers' Construct",
  railcraft: "Railcraft",
  witchery: "Witchery",
  cropsnh: "CropsNH",
  ae2fc: "AE2 Fluid Crafting",
  structurelib: "StructureLib",
};

export function modDisplayName(prefix: string): string {
  const known = MOD_NAMES[prefix.toLowerCase()];
  if (known) return known;
  return prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : prefix;
}

/**
 * An item's or fluid's tooltip, as the game and NEI write it: the name in white, the grey lines under it, and the
 * mod's name last in blue italics (from the id's prefix; a bare fluid id names no mod).
 */
export function itemTipLines(item: {
  name: string;
  id: string;
  tooltip?: readonly string[];
  extra?: readonly string[];
}): McTipLine[] {
  const lines: McTipLine[] = [{ text: item.name, tone: "name" }];
  for (const line of item.tooltip ?? []) {
    if (line.trim() && line !== item.name) lines.push({ text: line });
  }
  for (const line of item.extra ?? []) lines.push({ text: line });
  const colon = item.id.indexOf(":");
  if (colon > 0) lines.push({ text: modDisplayName(item.id.slice(0, colon)), tone: "mod" });
  return lines;
}
