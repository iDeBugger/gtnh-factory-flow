import treeData from "./data/tgs-trees.json";
import treeData281 from "./data/2.8.1/tgs-trees.json";
import { forVersion, type VersionOverrides } from "./version-overrides";
import type { GameVersion } from "@/lib/model/game-version";
import { formulaNumber, knob, type FormulaLine } from "./formula-lines";
import type { MachineConfigControl, MachineConfigTierOption, Recipe, RecipeOutput } from "@/lib/model/types";
import { GT_VOLTAGE_TIERS, getVoltageTierForEuT, getVoltageTierIndex } from "@/lib/model/tiers";

/**
 * The Tree Growth Simulator (GT5U MTETreeFarm, 5.09.54.205; docs/design/bio-vat-and-tgs.md in the mod's repo).
 *
 * The sapling sits in the controller and is never used up. Every 100 ticks, whatever the voltage (no overclocks,
 * no parallels), each output mode that has a tool in an input bus makes
 *     NEI amount x (2t^2 - 2t + 5) x the tool's multiplier
 * where the NEI amount is the product times the mode's own multiplier (log 5, sapling 5, leaves 2, fruit 1) and t
 * is the tier of the hatches' V x A rounded up (one hatch: its tier). It draws VP[t] = V[t] x 30/32 EU/t. A mode
 * with no tool makes nothing. Forestry saplings scale by their genes: logs by height and girth, saplings by
 * fertility, fruit by yield. The dataset carries only NEI's outputs; the sapling, which output is which mode and
 * Forestry's genes come from data/tgs-trees.json, read from the pack (tools/audits/import-machine-side-data.mjs).
 */
export const TGS_MACHINE_TYPE = "Tree Growth Simulator";
export const TGS_TICKS = 100;
const TGS_SECONDS = TGS_TICKS / 20;

export type TgsMode = "log" | "sapling" | "leaves" | "fruit";
export const TGS_MODES: TgsMode[] = ["log", "sapling", "leaves", "fruit"];
const MODE_MULTIPLIER: Record<TgsMode, number> = { log: 5, sapling: 5, leaves: 2, fruit: 1 };
const MODE_PLURAL: Record<TgsMode, string> = { log: "logs", sapling: "saplings", leaves: "leaves", fruit: "fruit" };

export interface TgsForestry {
  species: string;
  height: number;
  girth: number;
  fertility: number;
  yield: number;
  /** The products before the genes scale them. */
  base: Partial<Record<TgsMode, number>>;
}

export interface TgsTree {
  sapling: { id: string; name: string };
  /** NEI's outputs by mode: the product times the mode's multiplier (Forestry: at the species' own genes). */
  outputs: Partial<Record<TgsMode, { id: string; amount: number }>>;
  forestry?: TgsForestry;
}

interface TgsData {
  trees: TgsTree[];
}

/** The pack's tree file for each version whose trees differ from 2.9's. */
const TREE_DATA_OVERRIDES: VersionOverrides<TgsData> = { "2.8.1": { "tgs-trees": treeData281 as TgsData } };

// -- Settings -------------------------------------------------------------

/** The tool slots' control ids; the old dataset's names, so plans saved with them keep their tools. */
export const TGS_TOOL_CONTROL: Record<TgsMode, string> = {
  log: "tgsLogTool",
  sapling: "tgsSaplingTool",
  leaves: "tgsLeavesTool",
  fruit: "tgsFruitTool",
};
export const TGS_HEIGHT = "tgsHeight";
export const TGS_FERTILITY = "tgsSaplings";
export const TGS_YIELD = "tgsYield";

export interface TgsTool {
  key: string;
  label: string;
  multiplier: number;
  itemId: string;
  /** GT electric tools pay 100 EU of their own charge a use. */
  electric?: boolean;
}

/** MTETreeFarm.getToolMultiplier. A tool's material changes how long it lasts, never the amount. */
export const TGS_TOOLS: Record<TgsMode, TgsTool[]> = {
  log: [
    { key: "log:saw", label: "Saw", multiplier: 1, itemId: "gregtech:gt.metatool.01@10" },
    { key: "log:buzzsaw", label: "Buzzsaw", multiplier: 2, itemId: "gregtech:gt.metatool.01@140", electric: true },
    { key: "log:chainsaw", label: "Chainsaw", multiplier: 4, itemId: "gregtech:gt.metatool.01@110", electric: true },
  ],
  sapling: [
    { key: "sapling:branch_cutter", label: "Branch Cutter", multiplier: 1, itemId: "gregtech:gt.metatool.01@30" },
    { key: "sapling:grafter", label: "Grafter", multiplier: 4, itemId: "forestry:grafter" },
  ],
  leaves: [
    { key: "leaves:shears", label: "Shears", multiplier: 1, itemId: "minecraft:shears" },
    { key: "leaves:wire_cutter", label: "Wire Cutter", multiplier: 2, itemId: "gregtech:gt.metatool.01@26" },
    {
      key: "leaves:automatic_snips",
      label: "Electric Wire Cutter",
      multiplier: 4,
      itemId: "gregtech:gt.metatool.01@196",
      electric: true,
    },
  ],
  fruit: [{ key: "fruit:knife", label: "Knife", multiplier: 1, itemId: "gregtech:gt.metatool.01@34" }],
};
const MULTITOOL = { label: "Pocket Multitool", multiplier: 1, itemId: "gregtech:gt.metatool.01@180" };

/** Forestry's allele values (ForestryMC 4.11.39): what a bred sapling can carry. */
const HEIGHTS: Array<[string, number]> = [
  ["Smallest", 0.25], ["Smaller", 0.5], ["Small", 0.75], ["Average", 1], ["Large", 1.25], ["Larger", 1.5],
  ["Largest", 1.75], ["Gigantic", 2],
];
const FERTILITIES: Array<[string, number]> = [
  ["Lowest", 0.01], ["Lower", 0.025], ["Low", 0.035], ["Average", 0.05], ["High", 0.1], ["Higher", 0.2],
  ["Highest", 0.3],
];
const YIELDS: Array<[string, number]> = [
  ["Lowest", 0.025], ["Lower", 0.05], ["Low", 0.1], ["Average", 0.2], ["High", 0.3], ["Higher", 0.35],
  ["Highest", 0.4],
];

function configResource(id: string, label: string, detail: string, itemId?: string) {
  return {
    kind: "item" as const,
    id: itemId ?? `factoryflow:machine_config/${id}`,
    amount: 1,
    displayName: label,
    tooltip: [detail],
    consumed: false,
  };
}

function toolControl(mode: TgsMode): MachineConfigControl {
  const id = TGS_TOOL_CONTROL[mode];
  const tools: MachineConfigTierOption[] = [
    ...TGS_TOOLS[mode].map((tool) => ({
      key: tool.key,
      label: `${tool.label} ${tool.multiplier}x`,
      outputMultiplier: tool.multiplier,
      resource: configResource(
        `${id}_${tool.key}`,
        tool.label,
        `${tool.multiplier}x ${MODE_PLURAL[mode]}${tool.electric ? "; 100 EU of its own charge a use" : ""}.`,
        tool.itemId,
      ),
    })),
    {
      key: `${mode}:multitool`,
      label: `${MULTITOOL.label} ${MULTITOOL.multiplier}x`,
      outputMultiplier: MULTITOOL.multiplier,
      resource: configResource(
        `${id}_multitool`,
        MULTITOOL.label,
        "1x in every mode; worn once a run for each mode it serves.",
        MULTITOOL.itemId,
      ),
    },
    {
      key: "none",
      label: "No tool",
      outputMultiplier: 0,
      resource: configResource(`${id}_none`, "No tool", `No ${MODE_PLURAL[mode]}: a mode makes nothing without its tool.`),
    },
  ];
  return {
    id,
    label: `${MODE_PLURAL[mode][0].toUpperCase()}${MODE_PLURAL[mode].slice(1)} tool`,
    minimumKey: TGS_TOOLS[mode][0].key,
    defaultKey: TGS_TOOLS[mode][0].key,
    tiers: tools,
  };
}

/** The allele a gene value is (compared as Java floats), or undefined for a value Forestry has no name for. */
function alleleKey(alleles: Array<[string, number]>, value: number): string | undefined {
  return alleles.find(([, entry]) => Math.fround(entry) === Math.fround(value))?.[0].toLowerCase();
}

function alleleValue(alleles: Array<[string, number]>, key: string | undefined): number | undefined {
  return alleles.find(([name]) => name.toLowerCase() === key)?.[1];
}

function geneControl(id: string, label: string, alleles: Array<[string, number]>, current: number, what: string) {
  return {
    id,
    label,
    minimumKey: alleles[0][0].toLowerCase(),
    defaultKey: alleleKey(alleles, current) ?? alleles[0][0].toLowerCase(),
    tiers: alleles.map(([name, value]) => ({
      key: name.toLowerCase(),
      label: `${name} (${value})`,
      resource: configResource(`${id}_${name}`, `${label}: ${name}`, `${what} ${value}.`),
    })),
  } satisfies MachineConfigControl;
}

/** The knobs this tree's card offers: a tool per output it has, and a Forestry sapling's genes. */
export function getTgsControls(
  recipe: Partial<Pick<Recipe, "outputs" | "machineType">>,
  gameVersion: GameVersion,
): MachineConfigControl[] {
  const match = matchTgsTree(recipe, gameVersion);
  const modes = match ? TGS_MODES.filter((mode) => match.modes.includes(mode)) : TGS_MODES;
  const controls = modes.map(toolControl);
  const forestry = match?.tree.forestry;
  if (forestry) {
    if (modes.includes("log")) {
      controls.push(geneControl(TGS_HEIGHT, "Height", HEIGHTS, forestry.height, "The sapling's height gene:"));
    }
    if (modes.includes("sapling")) {
      controls.push(geneControl(TGS_FERTILITY, "Saplings", FERTILITIES, forestry.fertility, "The sapling's fertility gene:"));
    }
    if (modes.includes("fruit")) {
      controls.push(geneControl(TGS_YIELD, "Yield", YIELDS, forestry.yield, "The sapling's yield gene:"));
    }
  }
  return controls;
}

// -- Matching a dataset recipe to its tree --------------------------------

export interface TgsMatch {
  tree: TgsTree;
  /** The mode of each of the recipe's outputs, in order. */
  modes: TgsMode[];
}

interface TgsTables {
  trees: TgsTree[];
  exactIndex: Map<string, TgsTree>;
  matches: Map<string, TgsMatch | null>;
}

const tablesByVersion = new Map<GameVersion, TgsTables>();

/** One version's trees, index and match cache, built once: a 2.8.1 match never serves a 2.9 card. */
function tgsTables(gameVersion: GameVersion): TgsTables {
  const cached = tablesByVersion.get(gameVersion);
  if (cached) return cached;
  const trees = forVersion("tgs-trees", treeData as TgsData, TREE_DATA_OVERRIDES, gameVersion)?.trees ?? [];
  const exactIndex = new Map<string, TgsTree>();
  for (const tree of trees) {
    const key = TGS_MODES.filter((mode) => tree.outputs[mode])
      .map((mode) => `${tree.outputs[mode]!.id}x${tree.outputs[mode]!.amount}`)
      .join(";");
    if (!exactIndex.has(key)) exactIndex.set(key, tree);
  }
  const tables: TgsTables = { trees, exactIndex, matches: new Map() };
  tablesByVersion.set(gameVersion, tables);
  return tables;
}

/**
 * The tree a TGS recipe farms, and which output is which mode: by NEI's outputs (ids and amounts), else by ids
 * alone where the dataset is missing a mode the pack has (an older export).
 */
export function matchTgsTree(
  recipe: Partial<Pick<Recipe, "outputs" | "machineType" | "metadata">>,
  gameVersion: GameVersion,
): TgsMatch | undefined {
  if (recipe.machineType !== undefined && recipe.machineType !== TGS_MACHINE_TYPE) return undefined;
  const outputs = recipe.outputs ?? [];
  if (outputs.length === 0) return undefined;
  // A recipe given reference amounts matches by NEI's own amounts: the reference ones can be another tree's.
  const stored = recipe.metadata?.[TGS_NEI_OUTPUTS];
  const key = typeof stored === "string" ? stored : outputsKey(outputs);
  const { trees, exactIndex, matches: matchCache } = tgsTables(gameVersion);
  const cached = matchCache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const modesFor = (tree: TgsTree): TgsMode[] | undefined => {
    const modes: TgsMode[] = [];
    let from = 0;
    for (const output of outputs) {
      const at = TGS_MODES.findIndex((mode, index) => index >= from && tree.outputs[mode]?.id === output.id);
      if (at < 0) return undefined;
      modes.push(TGS_MODES[at]);
      from = at + 1;
    }
    return modes;
  };
  let match: TgsMatch | null = null;
  const exact = exactIndex.get(key);
  const exactModes = exact && modesFor(exact);
  if (exact && exactModes) {
    match = { tree: exact, modes: exactModes };
  } else {
    for (const tree of trees) {
      const modes = modesFor(tree);
      if (modes) {
        match = { tree, modes };
        break;
      }
    }
  }
  matchCache.set(key, match);
  return match ?? undefined;
}

function outputsKey(outputs: RecipeOutput[]): string {
  return outputs.map((output) => `${output.id}x${output.amount}`).join(";");
}

/** The metadata key holding NEI's outputs (ids and amounts) once `withTgsReferenceAmounts` has replaced a 0. */
const TGS_NEI_OUTPUTS = "tgsNeiOutputs";

/** The gene-free amount of a Forestry mode: the product at gene 1, times the mode's multiplier. */
function tgsReferenceAmount(tree: TgsTree, mode: TgsMode): number | undefined {
  const base = tree.forestry?.base[mode];
  return base === undefined ? undefined : base * MODE_MULTIPLIER[mode];
}

/**
 * NEI's TGS recipe is built once from the species' default genes, but each run recomputes from the real
 * sapling's genes (MTETreeFarm.process). 2.8.1 fruit has no floor, so a low-yield species shows 0 in NEI, yet a
 * higher yield gene makes fruit. Rates are an output's amount times its multiplier, so on 2.8.1 such an output
 * takes its gene-free amount here and `getTgsOutputMultiplier` scales from it. 2.9 recipes come back as they are.
 */
export function withTgsReferenceAmounts<T extends Partial<Pick<Recipe, "outputs" | "machineType" | "metadata">>>(
  recipe: T,
  gameVersion: GameVersion,
): T {
  if (fruitHasFloor(gameVersion)) return recipe;
  const outputs = recipe.outputs;
  if (!outputs?.some((output) => !(output.amount > 0))) return recipe;
  const match = matchTgsTree(recipe, gameVersion);
  if (!match?.tree.forestry) return recipe;
  const next = outputs.map((output, index) => {
    const reference = output.amount > 0 ? undefined : tgsReferenceAmount(match.tree, match.modes[index]);
    return reference === undefined ? output : { ...output, amount: reference };
  });
  return { ...recipe, outputs: next, metadata: { ...recipe.metadata, [TGS_NEI_OUTPUTS]: outputsKey(outputs) } };
}

export function isTgsRecipe(recipe: Partial<Pick<Recipe, "machineType">>): boolean {
  return recipe.machineType === TGS_MACHINE_TYPE;
}

// -- The model ------------------------------------------------------------

export interface TgsSettings {
  tools: Record<TgsMode, TgsTool | typeof MULTITOOL | undefined>;
  height?: number;
  fertility?: number;
  yield?: number;
}

export function getTgsSettings(settings: Record<string, string> | undefined, tree?: TgsTree): TgsSettings {
  const tools = {} as TgsSettings["tools"];
  for (const mode of TGS_MODES) {
    const key = settings?.[TGS_TOOL_CONTROL[mode]] ?? TGS_TOOLS[mode][0].key;
    tools[mode] = key === "none"
      ? undefined
      : key.endsWith(":multitool")
        ? MULTITOOL
        : (TGS_TOOLS[mode].find((tool) => tool.key === key) ?? TGS_TOOLS[mode][0]);
  }
  return {
    tools,
    height: alleleValue(HEIGHTS, settings?.[TGS_HEIGHT]) ?? tree?.forestry?.height,
    fertility: alleleValue(FERTILITIES, settings?.[TGS_FERTILITY]) ?? tree?.forestry?.fertility,
    yield: alleleValue(YIELDS, settings?.[TGS_YIELD]) ?? tree?.forestry?.yield,
  };
}

/** The game's t: the tier of the hatches' V x A, rounded up, at least LV (GTUtility.getTierExtended). */
export function tgsTier(poolEuT: number): number {
  return Math.max(1, getVoltageTierIndex(getVoltageTierForEuT(poolEuT)));
}

/** 2t^2 - 2t + 5 (MTETreeFarm.getTierMultiplier). */
export function tgsTierMultiplier(t: number): number {
  return 2 * t * t - 2 * t + 5;
}

/** GTValues.VP[t]: the voltage less 1/16. */
export function tgsEuPerTick(t: number): number {
  const voltage = GT_VOLTAGE_TIERS[Math.min(t, GT_VOLTAGE_TIERS.length - 1)].maxEuT;
  return Math.floor((voltage * 30) / 32);
}

/** Java's float multiply of a gene by 10, widened to double. */
function geneTimesTen(value: number): number {
  return Math.fround(Math.fround(value) * 10);
}

/**
 * 2.9 floors fruit at 1 like the sapling (GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTETreeFarm.java:731).
 * 2.8.1 truncates fruit with no floor, so a low-yield tree gives 0
 * (GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/production/MTETreeFarm.java:637).
 * The sapling keeps its floor in both (5.09.51.476 :619, 5.09.54.205 :713).
 */
function fruitHasFloor(gameVersion: GameVersion): boolean {
  return gameVersion !== "2.8.1";
}

/** MTETreeFarm.getOutputsForForestrySapling: one mode's product at these genes, before the mode's multiplier. */
export function tgsForestryProduct(
  forestry: TgsForestry,
  mode: TgsMode,
  settings: TgsSettings,
  gameVersion: GameVersion,
): number | undefined {
  const base = forestry.base[mode];
  if (base === undefined) return undefined;
  if (mode === "log") {
    const height = Math.fround(Math.max(Math.fround(3 * Math.fround(Math.fround(settings.height ?? forestry.height) - 1)), 0) + 1);
    return Math.trunc(base * height * forestry.girth);
  }
  if (mode === "sapling") return Math.max(1, Math.trunc(base * geneTimesTen(settings.fertility ?? forestry.fertility)));
  if (mode === "fruit") {
    const fruit = Math.trunc(base * geneTimesTen(settings.yield ?? forestry.yield));
    return fruitHasFloor(gameVersion) ? Math.max(1, fruit) : fruit;
  }
  return base;
}

/** One run's NEI amount for a mode (the product times the mode's multiplier), at the card's genes. */
export function tgsNeiAmount(tree: TgsTree, mode: TgsMode, settings: TgsSettings, gameVersion: GameVersion): number {
  const forestry = tree.forestry ? tgsForestryProduct(tree.forestry, mode, settings, gameVersion) : undefined;
  if (forestry !== undefined) return forestry * MODE_MULTIPLIER[mode];
  return tree.outputs[mode]?.amount ?? 0;
}

/**
 * How far an output's rate moves from what the dataset wrote: tier, tool and genes. `tierIndex` is the tier
 * getOverclockedRecipeStats reports for a TGS card, which is already the game's t.
 */
export function getTgsOutputMultiplier(
  recipe: Partial<Pick<Recipe, "outputs" | "machineType" | "metadata">>,
  output: RecipeOutput,
  settings: Record<string, string> | undefined,
  tierIndex: number,
  gameVersion: GameVersion,
): number {
  const match = matchTgsTree(recipe, gameVersion);
  if (!match) return 1;
  // 2.8.1 fruit can be 0, so NEI's amount can be 0 too; that output scales from its gene-free amount, never 0 / 0.
  const hasAmount = output.amount > 0;
  if (!hasAmount && fruitHasFloor(gameVersion)) return 1;
  const index = (recipe.outputs ?? []).indexOf(output);
  const mode = match.modes[index >= 0 ? index : (recipe.outputs ?? []).findIndex((entry) => entry.id === output.id)];
  if (!mode) return 1;
  const parsed = getTgsSettings(settings, match.tree);
  const tool = parsed.tools[mode];
  if (!tool) return 0;
  const perRun = tgsNeiAmount(match.tree, mode, parsed, gameVersion) * tgsTierMultiplier(Math.max(1, tierIndex)) * tool.multiplier;
  const reference = hasAmount ? output.amount : tgsReferenceAmount(match.tree, mode);
  if (reference === undefined || !(reference > 0)) return 0;
  return perRun / reference;
}

export interface TgsStats {
  t: number;
  durationTicks: number;
  eut: number;
}

export function getTgsStats(poolEuT: number): TgsStats {
  const t = tgsTier(poolEuT);
  return { t, durationTicks: TGS_TICKS, eut: tgsEuPerTick(t) };
}

// -- The worked formulas --------------------------------------------------

const TIER_NAMES = GT_VOLTAGE_TIERS.map((entry) => entry.tier);

/** Every number on a TGS card, worked from the card's own settings (FormulaLine). */
export function getTgsFormulas(
  recipe: Partial<Pick<Recipe, "outputs" | "machineType">>,
  settings: Record<string, string> | undefined,
  voltageEuT: number,
  amps: number,
  gameVersion: GameVersion,
): FormulaLine[] {
  const match = matchTgsTree(recipe, gameVersion);
  const pool = voltageEuT * amps;
  const t = tgsTier(pool);
  const mult = tgsTierMultiplier(t);
  const lines: FormulaLine[] = [
    {
      label: "tier",
      math: [knob(formulaNumber(voltageEuT), "tier"), " V · ", knob(formulaNumber(amps), "amps"), " A"],
      result: `${TIER_NAMES[t]}, t = ${t}`,
    },
    { label: "mult", math: [`2·${t}`, { sup: "2" }, `−2·${t}+5`], result: `${mult}x` },
  ];
  if (!match) return lines;
  const parsed = getTgsSettings(settings, match.tree);
  const forestry = match.tree.forestry;
  if (forestry) {
    const base = forestry.base;
    if (match.modes.includes("log") && base.log !== undefined) {
      const height = parsed.height ?? forestry.height;
      lines.push({
        label: "height",
        math: [`${base.log}·(3·(`, knob(height, TGS_HEIGHT), `−1)+1)·${forestry.girth}`],
        result: `${tgsForestryProduct(forestry, "log", parsed, gameVersion)} logs`,
      });
    }
    if (match.modes.includes("sapling") && base.sapling !== undefined) {
      lines.push({
        label: "fertility",
        math: [`max(1, ⌊${base.sapling}·`, knob(parsed.fertility ?? forestry.fertility, TGS_FERTILITY), "·10⌋)"],
        result: `${tgsForestryProduct(forestry, "sapling", parsed, gameVersion)}`,
      });
    }
    if (match.modes.includes("fruit") && base.fruit !== undefined) {
      lines.push({
        label: "yield",
        math: fruitHasFloor(gameVersion)
          ? [`max(1, ⌊${base.fruit}·`, knob(parsed.yield ?? forestry.yield, TGS_YIELD), "·10⌋)"]
          : [`⌊${base.fruit}·`, knob(parsed.yield ?? forestry.yield, TGS_YIELD), "·10⌋"],
        result: `${tgsForestryProduct(forestry, "fruit", parsed, gameVersion)}`,
      });
    }
  }
  let tools = 0;
  let electric = 0;
  for (const mode of match.modes) {
    const tool = parsed.tools[mode];
    const nei = tgsNeiAmount(match.tree, mode, parsed, gameVersion);
    if (!tool) {
      lines.push({ label: MODE_PLURAL[mode], math: ["no tool"], result: "0/s", tone: "bad" });
      continue;
    }
    tools += 1;
    if ("electric" in tool && tool.electric) electric += 1;
    const perRun = nei * mult * tool.multiplier;
    lines.push({
      label: MODE_PLURAL[mode],
      math: [`${nei}·${mult}·`, knob(`${tool.multiplier}`, TGS_TOOL_CONTROL[mode]), ` ÷ ${TGS_SECONDS}s`],
      result: `${formulaNumber(perRun / TGS_SECONDS)}/s`,
    });
  }
  lines.push({ label: "power", math: [`${formulaNumber(GT_VOLTAGE_TIERS[t].maxEuT)}·30/32`], result: `${formulaNumber(tgsEuPerTick(t))} EU/t` });
  if (tools > 0) {
    lines.push({
      label: "wear",
      math: [`${tools} tool${tools === 1 ? "" : "s"}, 1 use ÷ ${TGS_SECONDS}s`],
      result: electric > 0 ? `720/h; electric 20 EU/s` : "720 uses/h",
    });
  }
  return lines;
}
