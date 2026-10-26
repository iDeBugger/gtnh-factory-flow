import type { FactoryProject, ResourceKind } from "@/lib/model/types";
import { pinRuleOf } from "@/lib/model/pin-rule";
import { GT_VOLTAGE_TIERS } from "@/lib/model/tiers";
import type { SfxName } from "./sfx";

/**
 * What the board's edits sound of, read off the plan before and after (the mod plays these from `BoardSession`'s
 * edit methods; every edit here funnels through the store, so a diff of the plan catches them all, undo aside).
 * Pure: `soundForDiff` names the sound, the hook plays it.
 */

export interface DiffSound {
  name: SfxName;
  /** Before the mod's own variation (a rung of a ladder: a tier, a coil, a drawer rule). */
  pitch?: number;
  /** A pin or rate: when the wheel is turning, it plays once the wheel goes still (the mod's `live`). */
  settles?: boolean;
}

interface CardShot {
  pin: number;
  /** Exactly rather than Up to (a change of the rule is a pin change too). */
  exact: boolean;
  ports: string;
  tier: string;
  hatchTier: string;
  coil: string;
  sections: number;
  rest: string;
}

interface DrawerShot {
  kind: ResourceKind;
  rate: number;
  rule: string;
  role: string;
  rest: string;
}

interface NoteShot {
  color: string;
  font: number;
}

export interface BoardShot {
  projectId: string;
  cards: Map<string, CardShot>;
  drawers: Map<string, DrawerShot>;
  edges: Map<string, ResourceKind>;
  notes: Map<string, NoteShot>;
  openBoards: Set<string>;
}

/** Fields that change without the player turning a knob (drags, art, names, paint) and the ones read on their own. */
const SKIP = new Set([
  "position",
  "iconPath",
  "iconAtlas",
  "dominantColor",
  "tooltip",
  "displayName",
  "colorTag",
  "solvePin",
  "solvePinExact",
  "portRates",
  "overclockTier",
  "hatchVoltageTier",
  "coilTier",
  "extraRecipes",
  "targetPerSecond",
  "targetMode",
  "drainMode",
]);

function restOf(value: object): string {
  return JSON.stringify(value, (key, entry) => (SKIP.has(key) ? undefined : entry));
}

export function snapshotBoard(project: FactoryProject): BoardShot {
  const cards = new Map<string, CardShot>();
  for (const node of project.nodes) {
    const config = node.machineConfigTiers ?? {};
    cards.set(node.id, {
      pin: node.solvePin ?? 0,
      exact: pinRuleOf(node) === "exact",
      ports: JSON.stringify(node.portRates ?? {}),
      tier: String(node.overclockTier ?? ""),
      hatchTier: String(node.hatchVoltageTier ?? ""),
      coil: String(node.coilTier ?? config.heatingCoil ?? ""),
      sections: node.extraRecipes?.length ?? 0,
      rest: restOf(node),
    });
  }
  const drawers = new Map<string, DrawerShot>();
  for (const storage of project.storages ?? []) {
    drawers.set(storage.id, {
      kind: storage.kind,
      rate: storage.targetMode === "ignore" ? 0 : Math.abs(storage.targetPerSecond ?? 0),
      rule: storage.targetMode ?? "",
      role: storage.drainMode ?? "",
      rest: restOf(storage),
    });
  }
  const edges = new Map<string, ResourceKind>();
  for (const edge of project.edges) edges.set(edge.id, edge.resourceKind);
  const notes = new Map<string, NoteShot>();
  for (const annotation of project.annotations ?? []) {
    notes.set(annotation.id, {
      color: String(annotation.colorTag ?? ""),
      font: Number(annotation.fontSize ?? 0),
    });
  }
  const openBoards = new Set<string>();
  for (const pocket of project.pockets ?? []) if (pocket.expanded) openBoards.add(pocket.id);
  return { projectId: project.id, cards, drawers, edges, notes, openBoards };
}

function added<T>(from: Map<string, T>, to: Map<string, T>): string[] {
  const out: string[] = [];
  for (const id of to.keys()) if (!from.has(id)) out.push(id);
  return out;
}

const tierIndex = (tier: string) => GT_VOLTAGE_TIERS.findIndex((entry) => entry.tier === tier);

/** The mod's coil ladder (`GtCoils.all()`), lowest first, by the dataset's coil keys. */
const COILS = [
  "cupronickel",
  "kanthal",
  "nichrome",
  "tpv",
  "hss_g",
  "hss_s",
  "naquadah",
  "naquadah_alloy",
  "trinium",
  "electrum_flux",
  "awakened_draconium",
  "infinity",
  "hypogen",
  "eternal",
];

/** The mod's drawer rules in order (`Drawer.Rule`: ANY, AT_LEAST, EXACTLY, AT_MOST). */
const RULES = ["ignore", "at-least", "exact", "at-most"];

export const wireSound = (kind: ResourceKind | undefined): SfxName =>
  kind === "power" ? "wire.power" : kind === "fluid" ? "wire.fluid" : "wire.item";
export const cutSound = (kind: ResourceKind | undefined): SfxName =>
  kind === "power" ? "wire.power_cut" : kind === "fluid" ? "wire.fluid_cut" : "wire.cut";

/** The tier dial's pitch (`Sfx.tier`). */
export const tierPitch = (tier: number) => 0.62 * Math.pow(1.085, Math.max(0, tier));
const step = (rung: number, base: number, ratio: number) =>
  base * Math.pow(ratio, Math.max(0, rung));

/** The sound one edit makes, or undefined when nothing the player would hear changed. */
export function soundForDiff(prev: BoardShot, next: BoardShot): DiffSound | undefined {
  if (prev.projectId !== next.projectId) return undefined;
  const newCards = added(prev.cards, next.cards);
  const goneCards = added(next.cards, prev.cards);
  const newDrawers = added(prev.drawers, next.drawers);
  const goneDrawers = added(next.drawers, prev.drawers);
  const newEdges = added(prev.edges, next.edges);
  const goneEdges = added(next.edges, prev.edges);
  const newNotes = added(prev.notes, next.notes);
  const goneNotes = added(next.notes, prev.notes);

  // Cards combined onto one machine: they leave and a survivor gains their recipes.
  if (goneCards.length > 0) {
    for (const [id, card] of next.cards) {
      const was = prev.cards.get(id);
      if (was && card.sections > was.sections) return { name: "board.merge" };
    }
  }
  const landed = newCards.length + newDrawers.length + newNotes.length;
  if (newCards.length >= 2 || landed >= 3) return { name: "board.sweep" };
  if (newCards.length === 1) return { name: "board.place" };
  if (newNotes.length > 0 && newDrawers.length === 0) return { name: "note.stick" };
  if (newDrawers.length > 0) {
    // A drawer made for a port sounds of what it carries.
    return { name: wireSound(next.drawers.get(newDrawers[0])?.kind) };
  }
  if (goneCards.length + goneDrawers.length > 0) return { name: "board.remove" };
  if (goneNotes.length > 0) return { name: "note.crumple" };
  if (newEdges.length > 0) return { name: wireSound(next.edges.get(newEdges[0])) };
  if (goneEdges.length > 0) return { name: cutSound(prev.edges.get(goneEdges[0])) };

  // A board folded or unfolded.
  for (const id of next.openBoards) if (!prev.openBoards.has(id)) return { name: "ui.open" };
  for (const id of prev.openBoards) if (!next.openBoards.has(id)) return { name: "ui.close" };

  // A knob turned somewhere: the first that changed says which.
  for (const [id, card] of next.cards) {
    const was = prev.cards.get(id);
    if (!was) continue;
    if (card.pin !== was.pin)
      return { name: card.pin > 0 ? "board.pin" : "board.unpin", settles: true };
    if (card.exact !== was.exact) return { name: "board.pin", settles: true };
    if (card.ports !== was.ports) {
      const now = JSON.parse(card.ports) as Record<string, number>;
      const before = JSON.parse(was.ports) as Record<string, number>;
      const key = [...new Set([...Object.keys(now), ...Object.keys(before)])].find(
        (k) => now[k] !== before[k],
      );
      return {
        name: key !== undefined && (now[key] ?? 0) > 0 ? "board.pin" : "board.unpin",
        settles: true,
      };
    }
    if (card.tier !== was.tier && tierIndex(card.tier) >= 0)
      return { name: "dial.tier", pitch: tierPitch(tierIndex(card.tier)) };
    if (card.hatchTier !== was.hatchTier && tierIndex(card.hatchTier) >= 0) {
      return { name: "dial.tier", pitch: tierPitch(tierIndex(card.hatchTier)) };
    }
    if (card.coil !== was.coil)
      return { name: "board.adjust", pitch: step(COILS.indexOf(card.coil), 0.8, 1.05) };
    if (card.rest !== was.rest || card.tier !== was.tier || card.sections !== was.sections)
      return { name: "board.adjust" };
  }
  for (const [id, drawer] of next.drawers) {
    const was = prev.drawers.get(id);
    if (!was) continue;
    if (drawer.rule !== was.rule)
      return {
        name: "board.adjust",
        pitch: step(RULES.indexOf(drawer.rule || "ignore"), 0.9, 1.12),
      };
    if (drawer.rate !== was.rate)
      return { name: drawer.rate > 0 ? "board.pin" : "board.unpin", settles: true };
    if (drawer.role !== was.role)
      return { name: "board.adjust", pitch: step(drawer.role === "" ? 0 : 1, 0.9, 1.12) };
    if (drawer.rest !== was.rest) return { name: "board.adjust" };
  }
  for (const [id, note] of next.notes) {
    const was = prev.notes.get(id);
    if (!was) continue;
    if (note.color !== was.color) return { name: "board.adjust" };
    if (note.font !== was.font)
      return { name: "ui.tick", pitch: note.font > was.font ? 1.12 : 0.9 };
  }
  return undefined;
}

/** What the ear would call "the plan changed", as one comparable string (a refused drop commits an equal plan). */
export function boardFingerprint(project: FactoryProject): string {
  const shot = snapshotBoard(project);
  const cards = [...shot.cards].map(
    ([id, c]) =>
      `${id}:${c.pin}:${c.exact}:${c.ports}:${c.tier}:${c.hatchTier}:${c.coil}:${c.sections}:${c.rest}`,
  );
  const drawers = [...shot.drawers].map(
    ([id, d]) => `${id}:${d.rate}:${d.rule}:${d.role}:${d.rest}`,
  );
  return [
    cards.sort().join("\n"),
    drawers.sort().join("\n"),
    [...shot.edges.keys()].sort().join(","),
    [...shot.openBoards].sort().join(","),
  ].join("|");
}
