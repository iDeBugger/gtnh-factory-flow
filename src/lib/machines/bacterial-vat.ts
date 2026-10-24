import vatData from "./data/bio-vat.json";
import radioData from "./data/radio-hatch.json";
import vatData281 from "./data/2.8.1/bio-vat.json";
import radioData281 from "./data/2.8.1/radio-hatch.json";
import { forVersion, type VersionOverrides } from "./version-overrides";
import type { GameVersion } from "@/lib/model/game-version";
import { formulaNumber, knob, type FormulaLine } from "./formula-lines";
import type { MachineConfigControl, Recipe, RecipeInput, RecipeOutput } from "@/lib/model/types";
import { GT_VOLTAGE_TIERS } from "@/lib/model/tiers";

/**
 * The Bacterial Vat (bartworks MTEBioVat, GT5U 5.09.54.205; docs/design/bio-vat-and-tgs.md in the mod's repo).
 *
 * A recipe needs its culture's petri dish in the controller (never used up), glass of at least the recipe's tier,
 * and radiation from the one radio hatch: at least the recipe's sieverts, or exactly them. Overclocks are GT's
 * normal ones (the machine table). The fluids scale with how full the output hatch is kept when the next run is
 * checked:
 *     M = 1 when the hatch is empty or holds another fluid, else max(1, ceil(1000(1 - (2f - 1)^2))) + 1
 * so 2..1001, 1001 within 1.58% of half full, and the run must fit: M x out <= capacity - stored (void protection
 * on: the vat waits; off: the overflow is lost). Fluid in and fluid out are both x M; items, EU and time are not.
 * The radio hatch burns its material all the time, a mass unit every decay(sieverts) ticks.
 *
 * The dataset lacks the glass and sievert requirements; data/bio-vat.json carries them (read from the pack), and
 * data/radio-hatch.json the hatch's materials (tools/audits/import-machine-side-data.mjs).
 */
export const VAT_MACHINE_TYPE = "Bacterial Vat";

export const VAT_GLASS = "bioVatGlass";
export const VAT_OUTPUT_HATCH = "bioVatOutputHatch";
export const VAT_FILL = "bioVatFill";
export const VAT_VOID = "bioVatVoid";
export const VAT_RADIO = "bioVatRadio";
export const VAT_SHUTTER = "bioVatShutter";

/** Configuration.Multiblocks.bioVatMaxParallelBonus, which the config cannot change. */
const MAX_BONUS = 1000;

interface VatRecipeData {
  culture?: string;
  items: Array<{ id: string; amount: number }>;
  fluidIn?: { id: string; amount: number };
  fluidOut?: { id: string; amount: number };
  durationTicks: number;
  eut: number;
  glass: number;
  sievert: number;
  exact?: boolean;
  cleanroom?: boolean;
}

export interface RadioMaterial {
  id: string;
  name: string;
  sievert: number;
  mass: number;
}

interface VatData {
  recipes: VatRecipeData[];
}
interface RadioData {
  materials: RadioMaterial[];
}

/** The pack's files for each version whose recipes or materials differ from 2.9's. */
const VAT_DATA_OVERRIDES: VersionOverrides<VatData> = { "2.8.1": { "bio-vat": vatData281 as VatData } };
const RADIO_DATA_OVERRIDES: VersionOverrides<RadioData> = { "2.8.1": { "radio-hatch": radioData281 as RadioData } };

// -- Matching a dataset recipe to the pack's ------------------------------

export interface VatRequirements {
  glass: number;
  sievert: number;
  exact: boolean;
  cleanroom: boolean;
  culture?: string;
  /** False when the pack has no such recipe (the dataset is older): the defaults stand. */
  known: boolean;
}

/**
 * A vat recipe's identity: its fluid in (by id: a card's recipe carries it already scaled by the fill), its fluid
 * out, time and power. The culture tells the rare twins apart.
 */
function vatKey(fluidIn?: { id: string }, fluidOut?: { id: string; amount: number }, ticks?: number, eut?: number) {
  return `${fluidIn?.id}|${fluidOut?.id}x${fluidOut?.amount}|${ticks}|${eut}`;
}

interface VatTables {
  index: Map<string, VatRecipeData[]>;
  /** By sieverts, then mass; GregTech's own sticks first among equals (Uranium 238 before bartworks' isotopes). */
  radioMaterials: RadioMaterial[];
  requirements: Map<string, VatRequirements>;
  controls: Map<string, MachineConfigControl[]>;
}

const tablesByVersion = new Map<GameVersion, VatTables>();

/** One version's recipes, materials and caches, built once: a 2.8.1 answer never serves a 2.9 card. */
function vatTables(gameVersion: GameVersion): VatTables {
  const cached = tablesByVersion.get(gameVersion);
  if (cached) return cached;
  const recipes = forVersion("bio-vat", vatData as VatData, VAT_DATA_OVERRIDES, gameVersion)?.recipes ?? [];
  const materials = forVersion("radio-hatch", radioData as RadioData, RADIO_DATA_OVERRIDES, gameVersion)?.materials ?? [];
  const index = new Map<string, VatRecipeData[]>();
  for (const recipe of recipes) {
    const key = vatKey(recipe.fluidIn, recipe.fluidOut, recipe.durationTicks, recipe.eut);
    index.set(key, [...(index.get(key) ?? []), recipe]);
  }
  const tables: VatTables = {
    index,
    radioMaterials: [...materials].sort(
      (a, b) =>
        a.sievert - b.sievert ||
        a.mass - b.mass ||
        Number(!a.id.startsWith("gregtech:")) - Number(!b.id.startsWith("gregtech:")),
    ),
    requirements: new Map(),
    controls: new Map(),
  };
  tablesByVersion.set(gameVersion, tables);
  return tables;
}

/** The radio hatch's materials in this version, by sieverts, then mass. */
export function radioMaterials(gameVersion: GameVersion): RadioMaterial[] {
  return vatTables(gameVersion).radioMaterials;
}

/** The culture a dataset input names in its NBT tooltip line. */
function cultureOf(recipe: Partial<Pick<Recipe, "inputs">>): string | undefined {
  for (const input of recipe.inputs ?? []) {
    if (input.consumed !== false) continue;
    for (const line of input.tooltip ?? []) {
      const match = /Name:"([^"]+)"/.exec(line);
      if (match) return match[1];
    }
  }
  return undefined;
}

export function isVatRecipe(recipe: Partial<Pick<Recipe, "machineType">>): boolean {
  return recipe.machineType === VAT_MACHINE_TYPE;
}

/**
 * What a vat recipe's card reads off it, as one string: its identity (vatKey) and its culture. The solver hands over a
 * freshly derived recipe object on every call (a handler applied, inputs overridden), so caches keyed by the object
 * never hit; keyed by this they do, and a card's every power check stops rebuilding the same answers.
 */
function recipeKey(recipe: Partial<Pick<Recipe, "inputs" | "outputs" | "durationTicks" | "eut">>): string {
  const fluidIn = recipe.inputs?.find((input) => input.kind === "fluid");
  const fluidOut = recipe.outputs?.find((output) => output.kind === "fluid");
  return `${vatKey(fluidIn, fluidOut, recipe.durationTicks, recipe.eut)}|${cultureOf(recipe)}`;
}

export function getVatRequirements(
  recipe: Partial<Pick<Recipe, "inputs" | "outputs" | "durationTicks" | "eut" | "machineType">>,
  gameVersion: GameVersion,
): VatRequirements {
  const tables = vatTables(gameVersion);
  const key = recipeKey(recipe);
  const cached = tables.requirements.get(key);
  if (cached) return cached;
  const fluidIn = recipe.inputs?.find((input) => input.kind === "fluid");
  const fluidOut = recipe.outputs?.find((output) => output.kind === "fluid");
  const candidates = tables.index.get(vatKey(fluidIn, fluidOut, recipe.durationTicks, recipe.eut)) ?? [];
  const culture = cultureOf(recipe);
  const found = candidates.find((entry) => entry.culture === culture) ?? candidates[0];
  const result: VatRequirements = found
    ? {
      glass: found.glass,
      sievert: found.sievert,
      exact: found.exact === true,
      cleanroom: found.cleanroom === true,
      culture: found.culture ?? culture,
      known: true,
    }
    : { glass: 3, sievert: 0, exact: false, cleanroom: false, culture, known: false };
  tables.requirements.set(key, result);
  return result;
}

// -- Hatches, fill and the multiplier -------------------------------------

export interface OutputHatch {
  key: string;
  label: string;
  /** Litres it holds; 0 for the ME output hatch, which keeps nothing. */
  capacity: number;
}

/** MTEHatchOutput: 8000 x 2^tier litres. The Giant Output Hatch holds 100M; an ME output hatch nothing. */
export const OUTPUT_HATCHES: OutputHatch[] = [
  ...GT_VOLTAGE_TIERS.slice(0, 10).map((entry, tier) => ({
    key: entry.tier.toLowerCase(),
    label: `${entry.tier} Output Hatch`,
    capacity: 8000 * 2 ** tier,
  })),
  { key: "giant", label: "Giant Output Hatch", capacity: 100_000_000 },
  { key: "me", label: "ME Output Hatch", capacity: 0 },
];

export interface VatSettings {
  glass: number;
  hatch: OutputHatch;
  /** Percent full when the next run is checked. */
  fill: number;
  voidExcess: boolean;
  radio?: RadioMaterial;
  shutter: number;
}

/** The smallest hatch that holds a full x1001 run on top of being half full; the Giant hatch past that. */
function defaultHatch(fluidOut: number): OutputHatch {
  return OUTPUT_HATCHES.find((hatch) => hatch.capacity > 0 && hatch.capacity / 2 >= (MAX_BONUS + 1) * fluidOut)
    ?? OUTPUT_HATCHES.find((hatch) => hatch.key === "giant")!;
}

/** MTERadioHatch.getSievert: the material's sieverts less the shutter's share, in float. */
export function effectiveSievert(sievert: number, shutter: number): number {
  return sievert - Math.ceil(Math.fround(Math.fround(sievert / 100) * shutter));
}

/** The material and shutter a recipe's radiation is met with by default: the least that does it. */
function defaultRadio(need: VatRequirements, gameVersion: GameVersion): { radio?: RadioMaterial; shutter: number } {
  if (need.sievert <= 0) return { shutter: 0 };
  for (const material of radioMaterials(gameVersion)) {
    if (material.sievert < need.sievert) continue;
    if (!need.exact) return { radio: material, shutter: 0 };
    for (let shutter = 0; shutter <= 100; shutter++) {
      if (effectiveSievert(material.sievert, shutter) === need.sievert) return { radio: material, shutter };
    }
  }
  return { shutter: 0 };
}

export function getVatSettings(
  settings: Record<string, string> | undefined,
  recipe: Partial<Pick<Recipe, "inputs" | "outputs" | "durationTicks" | "eut" | "machineType">>,
  gameVersion: GameVersion,
): VatSettings {
  const need = getVatRequirements(recipe, gameVersion);
  const fluidOut = recipe.outputs?.find((output) => output.kind === "fluid")?.amount ?? 0;
  const glass = Number(settings?.[VAT_GLASS]);
  const fill = Number(settings?.[VAT_FILL]);
  const shutter = Number(settings?.[VAT_SHUTTER]);
  const fallback = defaultRadio(need, gameVersion);
  const radioKey = settings?.[VAT_RADIO];
  return {
    glass: Number.isFinite(glass) && glass > 0 ? glass : Math.max(3, need.glass),
    hatch: OUTPUT_HATCHES.find((hatch) => hatch.key === settings?.[VAT_OUTPUT_HATCH]) ?? defaultHatch(fluidOut),
    fill: Number.isFinite(fill) ? Math.min(100, Math.max(0, fill)) : 50,
    voidExcess: settings?.[VAT_VOID] === "void",
    radio: radioKey === "none" ? undefined : (radioMaterials(gameVersion).find((material) => material.id === radioKey) ?? fallback.radio),
    shutter: Number.isFinite(shutter) && settings?.[VAT_SHUTTER] !== undefined
      ? Math.min(100, Math.max(0, Math.trunc(shutter)))
      : fallback.shutter,
  };
}

export interface VatMultiplier {
  /** Litres in the output hatch when the run is checked. */
  stored: number;
  /** MTEBioVat.getExpectedMultiplier. */
  multiplier: number;
  /** Whether the scaled output fits on top of what is stored. */
  fits: boolean;
  /** Litres of output a run keeps: all of it, the room left when voiding, none when it cannot start. */
  keptOut: number;
}

/** MTEBioVat.calcMod + 1, from the litres stored in a hatch of this capacity (Java's doubles). */
export function vatMultiplierAt(stored: number, capacity: number): number {
  if (!(capacity > 0) || !(stored > 0)) return 1;
  const y = capacity / 2;
  const ret = Math.ceil(((-1 / y) * (stored - y) * (stored - y) + y) / y * MAX_BONUS);
  return Math.max(1, ret) + 1;
}

export function getVatMultiplier(settings: VatSettings, fluidOut: number): VatMultiplier {
  const capacity = settings.hatch.capacity;
  const stored = Math.round((capacity * settings.fill) / 100);
  const multiplier = vatMultiplierAt(stored, capacity);
  const room = capacity > 0 ? capacity - stored : Number.POSITIVE_INFINITY;
  const fits = multiplier * fluidOut <= room;
  const keptOut = fits ? multiplier * fluidOut : settings.voidExcess ? Math.max(0, room) : 0;
  return { stored, multiplier, fits, keptOut };
}

// -- Radiation ------------------------------------------------------------

/** MTERadioHatch.calcDecayTicks: ticks a mass unit of a material of these sieverts lasts. */
export function radioDecayTicks(sievert: number): number {
  if (sievert === 43) return 5000;
  if (sievert === 61) return 4500;
  if (sievert <= 100) return Math.ceil((8000 * Math.tanh(-sievert / 20) + 8000) * 1000);
  return Math.ceil(8000 * Math.tanh(-sievert / 65) + 8000);
}

/** Items of a material one radio hatch burns a second, running or not. */
export function radioBurnPerSecond(material: RadioMaterial): number {
  return 20 / (material.mass * radioDecayTicks(material.sievert));
}

/** Why the recipe cannot run in this vat, if it cannot (glass, radiation, an output that never fits). */
export function getVatGateReason(
  recipe: Partial<Pick<Recipe, "inputs" | "outputs" | "durationTicks" | "eut" | "machineType">>,
  settings: Record<string, string> | undefined,
  gameVersion: GameVersion,
): string | undefined {
  const need = getVatRequirements(recipe, gameVersion);
  const parsed = getVatSettings(settings, recipe, gameVersion);
  if (parsed.glass < need.glass) {
    return `Needs ${GT_VOLTAGE_TIERS[need.glass]?.tier ?? need.glass} glass or better.`;
  }
  if (need.sievert > 0) {
    const have = parsed.radio ? effectiveSievert(parsed.radio.sievert, parsed.shutter) : 0;
    if (need.exact ? have !== need.sievert : have < need.sievert) {
      return need.exact
        ? `Needs exactly ${need.sievert} Sv from the radio hatch (it has ${have}).`
        : `Needs at least ${need.sievert} Sv from the radio hatch (it has ${have}).`;
    }
  }
  const fluidOut = recipe.outputs?.find((output) => output.kind === "fluid")?.amount ?? 0;
  if (fluidOut > 0 && !getVatMultiplier(parsed, fluidOut).fits && !parsed.voidExcess) {
    return "The scaled output does not fit in the output hatch at this fill: void protection holds the vat.";
  }
  return undefined;
}

// -- Rates ----------------------------------------------------------------

/** The output multiplier: the first fluid out times M (or what is kept of it); items as written. */
export function getVatOutputMultiplier(
  recipe: Partial<Pick<Recipe, "inputs" | "outputs" | "durationTicks" | "eut" | "machineType">>,
  output: RecipeOutput,
  settings: Record<string, string> | undefined,
  gameVersion: GameVersion,
): number {
  if (output.kind !== "fluid") return 1;
  const first = recipe.outputs?.find((entry) => entry.kind === "fluid");
  if (!first || first.id !== output.id || !(first.amount > 0)) return 1;
  return getVatMultiplier(getVatSettings(settings, recipe, gameVersion), first.amount).keptOut / first.amount;
}

/**
 * The vat's inputs at the card's settings: the first fluid in times M, and the radio hatch's material burned over
 * one run (`craftSeconds` long). The burn is per machine, running or not; a run is how the solver counts.
 */
/** Recipes already scaled here, so a second pass leaves them alone. */
const scaled = new WeakSet<Recipe>();

export function applyVatInputs(
  recipe: Recipe,
  settings: Record<string, string> | undefined,
  craftSeconds: number,
  gameVersion: GameVersion,
): Recipe {
  if (scaled.has(recipe)) return recipe;
  const parsed = getVatSettings(settings, recipe, gameVersion);
  const fluidOut = recipe.outputs.find((output) => output.kind === "fluid")?.amount ?? 0;
  const { multiplier, fits } = getVatMultiplier(parsed, fluidOut);
  const runs = fits || parsed.voidExcess;
  const firstFluid = recipe.inputs.findIndex((input) => input.kind === "fluid");
  const inputs: RecipeInput[] = recipe.inputs.map((input, index) =>
    index === firstFluid && runs && multiplier !== 1 ? { ...input, amount: input.amount * multiplier } : input,
  );
  const need = getVatRequirements(recipe, gameVersion);
  if (need.sievert > 0 && parsed.radio && craftSeconds > 0) {
    inputs.push({
      kind: "item",
      id: parsed.radio.id,
      amount: radioBurnPerSecond(parsed.radio) * craftSeconds,
      displayName: parsed.radio.name,
      tooltip: [`Burned by the radio hatch: one every ${formulaNumber((parsed.radio.mass * radioDecayTicks(parsed.radio.sievert)) / 20)} s, running or not.`],
    });
  }
  const result = { ...recipe, inputs };
  scaled.add(result);
  return result;
}

// -- Settings -------------------------------------------------------------

function option(id: string, key: string, label: string, detail: string, itemId?: string) {
  return {
    key,
    label,
    resource: {
      kind: "item" as const,
      id: itemId ?? `factoryflow:machine_config/${id}_${key}`,
      amount: 1,
      displayName: label,
      tooltip: [detail],
      consumed: false,
    },
  };
}

/** The knobs a vat recipe's card offers; radiation only on recipes that need it. Built once per recipe. */
export function getVatControls(
  recipe: Partial<Pick<Recipe, "inputs" | "outputs" | "durationTicks" | "eut" | "machineType">>,
  gameVersion: GameVersion,
): MachineConfigControl[] {
  const cache = vatTables(gameVersion).controls;
  const key = recipeKey(recipe);
  const cached = cache.get(key);
  if (cached) return cached;
  const controls = buildVatControls(recipe, gameVersion);
  cache.set(key, controls);
  return controls;
}

function buildVatControls(
  recipe: Partial<Pick<Recipe, "inputs" | "outputs" | "durationTicks" | "eut" | "machineType">>,
  gameVersion: GameVersion,
): MachineConfigControl[] {
  const need = getVatRequirements(recipe, gameVersion);
  const defaults = getVatSettings(undefined, recipe, gameVersion);
  const controls: MachineConfigControl[] = [
    {
      id: VAT_GLASS,
      label: "Glass",
      minimumKey: "3",
      defaultKey: String(defaults.glass),
      tiers: GT_VOLTAGE_TIERS.slice(3, 13).map((entry, index) =>
        option(VAT_GLASS, String(index + 3), `${entry.tier} glass`, `All the vat's glass is ${entry.tier} tier or better.`),
      ),
    },
    {
      id: VAT_OUTPUT_HATCH,
      label: "Output hatch",
      minimumKey: OUTPUT_HATCHES[0].key,
      defaultKey: defaults.hatch.key,
      tiers: OUTPUT_HATCHES.map((hatch) =>
        option(
          VAT_OUTPUT_HATCH,
          hatch.key,
          hatch.label,
          hatch.capacity > 0
            ? `Holds ${formulaNumber(hatch.capacity)} L.`
            : "Sends everything to ME and keeps nothing, so the vat stays at 1x.",
        ),
      ),
    },
    {
      id: VAT_FILL,
      label: "Kept full %",
      minimumKey: "0",
      defaultKey: "50",
      numeric: { min: 0, max: 100, step: 0.1 },
      tiers: [option(VAT_FILL, "50", "Kept full %", "How full the output hatch is when the next run starts: half full is 1001x.")],
    },
    {
      id: VAT_VOID,
      label: "Void protection",
      minimumKey: "protect",
      defaultKey: "protect",
      tiers: [
        option(VAT_VOID, "protect", "On", "A run whose scaled output does not fit waits."),
        option(VAT_VOID, "void", "Off", "A run starts anyway and the output that does not fit is lost."),
      ],
    },
  ];
  if (need.sievert > 0) {
    controls.push(
      {
        id: VAT_RADIO,
        label: "Radio hatch",
        minimumKey: "none",
        defaultKey: defaults.radio?.id ?? "none",
        tiers: [
          option(VAT_RADIO, "none", "Empty", "Nothing in the radio hatch: 0 Sv."),
          ...radioMaterials(gameVersion).map((material) =>
            option(
              VAT_RADIO,
              material.id,
              `${material.name} (${material.sievert} Sv)`,
              `${material.sievert} Sv; one lasts ${formulaNumber((material.mass * radioDecayTicks(material.sievert)) / 20)} s.`,
              material.id,
            ),
          ),
        ],
      },
      {
        id: VAT_SHUTTER,
        label: "Shutter %",
        minimumKey: "0",
        defaultKey: String(defaults.shutter),
        numeric: { min: 0, max: 100, step: 1 },
        tiers: [option(VAT_SHUTTER, "0", "Shutter %", "How far the radio hatch's shutter is closed: it takes that share off its sieverts, rounded up.")],
      },
    );
  }
  return controls;
}

// -- The worked formulas --------------------------------------------------

export interface VatRunStats {
  /** Ticks a run takes after overclocks. */
  durationTicks: number;
  eut: number;
  overclockSteps: number;
}

/** Every number on a vat card, worked from the card's own settings (FormulaLine). */
export function getVatFormulas(
  recipe: Partial<Pick<Recipe, "inputs" | "outputs" | "durationTicks" | "eut" | "machineType">>,
  settings: Record<string, string> | undefined,
  stats: VatRunStats,
  gameVersion: GameVersion,
): FormulaLine[] {
  const need = getVatRequirements(recipe, gameVersion);
  const parsed = getVatSettings(settings, recipe, gameVersion);
  const fluidIn = recipe.inputs?.find((input) => input.kind === "fluid")?.amount ?? 0;
  const fluidOut = recipe.outputs?.find((output) => output.kind === "fluid")?.amount ?? 0;
  const vat = getVatMultiplier(parsed, fluidOut);
  const f = parsed.fill / 100;
  const lines: FormulaLine[] = [];
  lines.push(
    parsed.hatch.capacity === 0
      ? { label: "fill", math: [knob("ME", VAT_OUTPUT_HATCH), " hatch keeps nothing"], result: "1x" }
      : vat.stored <= 0
        ? { label: "fill", math: ["an empty hatch"], result: "1x" }
        : {
          label: "fill",
          math: ["⌈1000·(1−(2·", knob(formulaNumber(f), VAT_FILL), "−1)", { sup: "2" }, ")⌉+1"],
          result: `${formulaNumber(vat.multiplier)}x`,
        },
  );
  if (fluidIn > 0) {
    lines.push({ label: "in", math: [`${formulaNumber(fluidIn)} L·${formulaNumber(vat.multiplier)}`], result: `${formulaNumber(fluidIn * vat.multiplier)} L` });
  }
  if (fluidOut > 0) {
    lines.push({ label: "out", math: [`${formulaNumber(fluidOut)} L·${formulaNumber(vat.multiplier)}`], result: `${formulaNumber(fluidOut * vat.multiplier)} L` });
    if (parsed.hatch.capacity > 0) {
      lines.push({
        label: "room",
        math: [`${formulaNumber(fluidOut * vat.multiplier)} ≤ `, knob(formulaNumber(parsed.hatch.capacity), VAT_OUTPUT_HATCH), `−${formulaNumber(vat.stored)}`],
        result: vat.fits ? "fits" : parsed.voidExcess ? `voids ${formulaNumber(fluidOut * vat.multiplier - vat.keptOut)} L` : "waits",
        tone: vat.fits ? "good" : "bad",
      });
    }
  }
  const seconds = stats.durationTicks / 20;
  lines.push({
    label: "time",
    math: [`${formulaNumber(recipe.durationTicks ?? 0)}t ÷ 2`, { sup: String(stats.overclockSteps) }],
    result: `${formulaNumber(stats.durationTicks)}t`,
  });
  if (fluidOut > 0) {
    lines.push({
      label: "rate",
      math: [`${formulaNumber(vat.keptOut)} L ÷ ${formulaNumber(seconds)}s`],
      result: `${formulaNumber(seconds > 0 ? vat.keptOut / seconds : 0)} L/s`,
    });
  }
  lines.push({
    label: "glass",
    math: [knob(GT_VOLTAGE_TIERS[parsed.glass]?.tier ?? String(parsed.glass), VAT_GLASS), ` ≥ ${GT_VOLTAGE_TIERS[Math.max(need.glass, 0)]?.tier ?? need.glass}`],
    result: parsed.glass >= need.glass ? "ok" : "too low",
    tone: parsed.glass >= need.glass ? "good" : "bad",
  });
  if (need.sievert > 0) {
    const have = parsed.radio ? effectiveSievert(parsed.radio.sievert, parsed.shutter) : 0;
    const met = need.exact ? have === need.sievert : have >= need.sievert;
    lines.push({
      label: "rad",
      math: parsed.radio
        ? [knob(parsed.radio.sievert, VAT_RADIO), "−⌈", knob(parsed.radio.sievert, VAT_RADIO), "·", knob(parsed.shutter, VAT_SHUTTER), `%⌉ ${need.exact ? "=" : "≥"} ${need.sievert}`]
        : [knob("empty", VAT_RADIO), ` ${need.exact ? "=" : "≥"} ${need.sievert}`],
      result: `${have} Sv`,
      tone: met ? "good" : "bad",
    });
    if (parsed.radio) {
      const decay = radioDecayTicks(parsed.radio.sievert);
      lines.push({
        label: "burn",
        math: [`20 ÷ (${parsed.radio.mass}·${formulaNumber(decay)}t)`],
        result: `${formulaNumber(radioBurnPerSecond(parsed.radio))}/s`,
      });
    }
  }
  lines.push({
    label: "power",
    math: [`${formulaNumber(recipe.eut ?? 0)}·4`, { sup: String(stats.overclockSteps) }],
    result: `${formulaNumber(stats.eut)} EU/t`,
  });
  return lines;
}
