import { GT_TIER_COLORS } from "../tier-colors";
import { contrastInk, mixHex } from "./colors";

/**
 * Tokens of the clean look, as TypeScript for code that needs a value (a mix,
 * a measurement) and as the same numbers in `clean.css` for everything else.
 * Hex is exact from the mod (`Hyb.java`, `CardPaint.java`, `DrawerPaint.java`).
 * Other clean-look packages read this file; the card package owns it.
 */
export const CC = {
  surface: "#23252A",
  edge: "#34363C",
  hair: "#2C2E34",
  ink: "#E8E9EE",
  muted: "#9A9CA4",
  gold: "#FFD257",
  select: "#22D3EE",
  red: "#E05252",
  amber: "#E0A63A",
  ok: "#5EE9B5",
  source: "#78B6F4",
  product: "#F59A5C",
  trash: "#8A93A6",
  /** A buffer: teal, the one drawer inside the plan (the mod's `DrawerPaint.BUFFER_INK`). */
  buffer: "#2E9C8F",
  idle: "#A8AFBB",
  accept: "#4ADE80",
  wireGo: "#22C55E",
  wireNo: "#EF4444",
  key: "#26282D",
  keyHover: "#2D2F35",
  keyEdge: "#111317",
  keyHi: "#4A4C54",
  keyLo: "#17191D",
  canvas: "#141414",
  canvasDot: "#26282D",
  /** The text colour of a prompt in its off half-beat. */
  promptOff: "#6F737C",
  /** The outline on a card reached from a machine list (`card-flash.ts`). */
  flash: "#F2F4F8",
} as const;

/** Geometry in CSS px at zoom 1: the mod's card exactly, 320 wide (16 cells), 112 rails, 32 icons; rows stay two cells. */
export const CC_GEOMETRY = {
  cardWidth: 320,
  cell: 20,
  headHeight: 40,
  rowHeight: 40,
  railWidth: 112,
  railInset: 4,
  pictureWidth: 88,
  pictureMinHeight: 100,
  pictureArtMax: 88,
  iconSize: 32,
  iconInset: 4,
  wordsX: 40,
  wordsWidth: 70,
  keySize: 20,
  chipWidth: 48,
  chipHeight: 20,
  stripGap: 6,
  stripPad: 4,
  stripChipHeight: 18,
  stripPitch: 20,
  stripChipGap: 4,
  stripInset: 8,
} as const;

/** Mod pulse periods (seconds). */
export const CC_PULSE = { glow: 1.9, accept: 1.43, prompt: 1 } as const;

export interface TierChipColors {
  background: string;
  border: string;
  ink: string;
  hover: string;
  pressed: string;
  underline: boolean;
}

/**
 * A flat tier chip's colours: the tier's background and border, a label by
 * luminance (black on LuV, as the mod has it), hover 88% bg + 12% white,
 * pressed 92% bg + 8% black.
 */
export function tierChipColors(tier: string): TierChipColors | undefined {
  const entry = (GT_TIER_COLORS as Record<string, (typeof GT_TIER_COLORS)[keyof typeof GT_TIER_COLORS]>)[tier];
  if (!entry) return undefined;
  return {
    background: entry.background,
    border: entry.border,
    ink: contrastInk(entry.background),
    hover: mixHex(entry.background, "#FFFFFF", 0.88),
    pressed: mixHex(entry.background, "#000000", 0.92),
    underline: entry.underline === true,
  };
}

/** The mixes drawers and forced rows share (spec section 1, computed not typed). */
export type DrawerKind = "source" | "product" | "trash" | "buffer";

export function drawerMixes(kind: DrawerKind) {
  const tint =
    kind === "source" ? CC.source : kind === "product" ? CC.product : kind === "buffer" ? CC.buffer : CC.trash;
  return {
    tint,
    edge: mixHex(tint, CC.edge, 0.55),
    frameEdge: mixHex(tint, CC.edge, 0.4),
    barFill: mixHex(tint, CC.surface, 0.2),
    barFillHot: mixHex(tint, CC.surface, 0.32),
    bodyFill: mixHex(tint, CC.surface, 0.07),
    stripe: mixHex(tint, CC.surface, 0.13),
    glanceFill: mixHex(tint, CC.surface, 0.1),
    numberInk: mixHex(tint, CC.ink, 0.75),
    nameInk: mixHex(tint, CC.muted, 0.45),
  };
}
