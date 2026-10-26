import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { writeDatasetJson } from "./dataset-json-writer.mjs";
import { recipeMapAmperage } from "./recipe-map-amperage.mjs";
import { withoutSteamHandlersLackingFluidHatches } from "./steam-fluid-hatches.mjs";
import { neiFirstStacksFromExport, neiItemOrderFromExport, neiSortProblem } from "./nei-item-order.mjs";
import { compareStandIns, orderCropDrops, orderOreMembers } from "./stand-in-order.mjs";
import { spargeRolledOutputs } from "./sparge-byproducts.mjs";
import { stageRenderedIcons as stageIconsOnWorkers } from "./stage-rendered-icons.mjs";
import {
  EEC_MACHINE_TYPE,
  eecDropChance,
  eecExpectedItems,
  unknownEecModifiers,
} from "./eec-drops.mjs";
import {
  buildMachineHandlerTemplates,
  heatingCoilTiers,
  instantiateRecipeMachineHandlers,
  machineConfigControlsForOracleRecipe,
  machineConfigResources,
  machineHandlerConfigResources,
  primaryMachineHandlerControls,
  VOLTAGE_TIER_NAMES,
} from "./machine-configs.mjs";

const inputPath = process.argv[2];
const outputPath = process.argv[3];
const GT_VOLTAGE_NAMES = VOLTAGE_TIER_NAMES;
// Arcane recipes with an unreadable grid cell an export may carry (listed in the
// oracle report) before it is refused; see arcaneGridGaps.
const ARCANE_UNRESOLVED_GRID_CEILING = 2;
if (!inputPath || !outputPath) {
  throw new Error("Usage: normalize-oracle-export.mjs <oracle.json> <recipes.json>");
}

const datasetVersionId = requiredEnv("GTNH_DATASET_VERSION_ID");
const gtnhVersion = requiredEnv("GTNH_DATASET_VERSION_LABEL");
const generatedAt = new Date().toISOString();
const outDir = path.dirname(outputPath);
// An earlier run's output goes before any work: a refused or failed run then leaves no
// recipes.json (or its gzip) behind for a later stage started by hand to take for its own.
await fs.rm(outputPath, { force: true });
await fs.rm(`${outputPath}.gz`, { force: true });
const renderedIconDir = process.env.GTNH_RENDERED_ICON_DIR;
const oracleStrict = envFlag("GTNH_ORACLE_STRICT", false);

const raw = JSON.parse(stripBom(await fs.readFile(inputPath, "utf8")));
const singleblockFamilyIds = new Set((findDomain("gregtech")?.recipeMaps ?? []).flatMap(map =>
  buildMachineHandlerTemplates(map.name, map.catalysts, undefined, gtnhVersion).filter(handler => handler.kind === "single").map(handler => handler.id)));
const renderedIcons = await stageRenderedIcons(renderedIconDir, outDir);

const resources = new Map();
// Per catalog key: the stack standing for it, and the best-ranked stack with an icon (addResource).
const standIns = new Map();
const standInIcons = new Map();
const recipes = [];
const recipeMaps = new Set();
const recipeMapIcons = new Map();
// GT's gt.recipe.furnace map mirrors vanilla FurnaceRecipes at runtime, so its
// export has catalysts (steam/electric furnaces, Multi Smelter...) but zero
// recipes; the recipes arrive through the "smelting" domain instead. Stash the
// catalysts so normalizeSmelting can reattach the machines to those recipes.
let furnaceCatalysts = [];
// Machine handler families -> the item that represents them (the family's
// lowest-tier catalyst), plus every tiered variant's own item where the
// family has more than one, so a card can wear the machine of its tier.
// Shipped dataset-wide so the app never guesses items from names. The face
// is first registration wins; the tier list is merged across every map the
// family appears in.
const machineHandlerIcons = new Map();
const machineHandlerTierIcons = new Map();
const VOLTAGE_TIER_ORDER = VOLTAGE_TIER_NAMES;

function registerMachineHandlerIcons(templates) {
  for (const template of templates ?? []) {
    if (!template.catalystResource) {
      continue;
    }
    for (const variant of template.tierIcons ?? []) {
      const tierResource = resourceAmount(variant.resource);
      if (!tierResource?.iconPath) {
        continue;
      }
      const tiers = machineHandlerTierIcons.get(template.id) ?? new Map();
      if (!tiers.has(variant.tier)) {
        addResource(tierResource);
        tiers.set(variant.tier, tierResource);
      }
      machineHandlerTierIcons.set(template.id, tiers);
    }
    if (machineHandlerIcons.has(template.id)) {
      continue;
    }
    const resource = resourceAmount(template.catalystResource);
    if (!resource?.iconPath) {
      continue;
    }
    addResource(resource);
    machineHandlerIcons.set(template.id, resource);
  }
}
const recipeSignatures = new Set();
// A game identity's recipe (vein, small ore, bee, crop, mob, underground fluid)
// by id: the hash of its first body, and every id met again with another body.
const identityBodies = new Map();
const identityConflicts = new Set();
// The game names two different maps "Coke Oven": gtpp.recipe.cokeoven is the
// Industrial Coke Oven's map (GTNH deliberately registers every Pyrolyse Oven
// recipe into it too), while gt.recipe.cokeoven mirrors the Railcraft brick
// Coke Oven. Left to their localized names they fold into one misleading
// "Coke Oven" family, so the ICO map wears its machine's name instead.
const RECIPE_MAP_DISPLAY_NAMES = new Map([["gtpp.recipe.cokeoven", "Industrial Coke Oven"]]);
// Maps the game exports with no translation, their name left as their id
// (2.8.1's Boldarnator map). Used only when the export's name is the bare id,
// so a translated name always wins.
const UNTRANSLATED_RECIPE_MAP_NAMES = new Map([["gt.recipe.multiblockrockbreaker", "Boldarnator"]]);
// GT++ merged into GregTech in 2.9.0-RC-1: its gtpp.recipe.* maps are
// gt.recipe.* there. Two took other names: the Industrial Coke Oven's map took
// the machine's name, and the Thermal Boiler's (GT++ called it
// thermalgeneratorfuel, the id of GT's own geothermal fuel map) became
// thermalboiler. Ids use the newest name, so a recipe keeps its id across that
// merge and never shares an id prefix with another machine's map.
const RECIPE_MAP_ID_RENAMES = new Map([
  ["gtpp.recipe.cokeoven", "gt.recipe.industrialcokeoven"],
  ["gtpp.recipe.thermalgeneratorfuel", "gt.recipe.thermalboiler"],
]);

// Fields, at any depth, a rebuild may change without the recipe changing:
// names, icons, tooltips (some mods randomize them), stamps and the version.
const VOLATILE_RECIPE_FIELDS = new Set([
  "displayName",
  "iconPath",
  "dominantColor",
  "tooltip",
  "generatedAt",
  "datasetVersionId",
  "rawRecipeId",
]);

// The Tank synthesis (see addTankRecipe): its machine name, and the fallback
// face for its chip when no plain empty cell ever crossed the Canner map.
const TANK_MACHINE_TYPE = "Tank";
let tankIconFallback;
const oreDictionaryAlternativesByName = new Map();
// NEI's order and its first listed stack per item, before the domains: every stand-in below is
// chosen by them (standInOrder), never by the order the export walked the game's hash maps.
const neiItemOrder = neiItemOrderFromExport(raw.neiItemList);
if (raw.neiItemList?.status === "exported" && neiSortProblem(raw.neiItemList)) {
  console.warn(`WARNING: ${neiSortProblem(raw.neiItemList)} The dataset gets no NEI order.`);
}
const neiPlace = new Map((neiItemOrder ?? []).map((key, index) => [key, index]));
const neiFirstStacks = neiFirstStacksFromExport(neiItemOrder ? raw.neiItemList : undefined);
const oreUnificationTargets = Object.fromEntries(
  Object.entries(findDomain("oreDictionary")?.unificationTargets ?? {}).map(([name, id]) => [
    name,
    canonicalResourceId("item", String(id)),
  ]),
);
const oreDictionary = normalizeOreDictionary(findDomain("oreDictionary")?.entries ?? {});

normalizeGregtech(findDomain("gregtech"));
normalizeCrafting(findDomain("crafting"));
normalizeSmelting(findDomain("smelting"));
normalizeThaumcraft(findDomain("thaumcraft"));
normalizeForestryBees(findDomain("forestryBees"));
normalizeIc2Crops(findDomain("ic2Crops"));
normalizeCropsNhCrops(findDomain("cropsNhCrops"));
normalizeMobDrops(findDomain("mobDrops"));
normalizeMining(findDomain("mining"));
overrideFurnaceRecipeMapIcon();
assignContentRecipeIds();
applyNeiStandIns();

const dataset = {
  schemaVersion: 1,
  datasetVersionId,
  gtnhVersion,
  sourceInfo: {
    sourceId: "gtnh-oracle",
    sourceVersion: raw.format ?? "dev.gtnhplanner.oracle.v1",
    generatedAt,
    notes:
      "Generated by a GTNH JVM oracle mod from live Forge/Minecraft/GTNH registries. Unsupported detected adapters are listed in oracle-report.json.",
  },
  resources: [...resources.values()].sort(compareById),
  recipes,
  oreDictionary,
  recipeMaps: [...recipeMaps].sort(),
  recipeMapIcons: [...recipeMapIcons.entries()]
    .map(([recipeMap, resource]) => ({ recipeMap, resource: compactRecipeResource(resource) }))
    .sort((left, right) => left.recipeMap.localeCompare(right.recipeMap)),
  machineHandlerIcons: [...machineHandlerIcons.entries()]
    .map(([familyId, resource]) => {
      const tiers = machineHandlerTierIcons.get(familyId);
      return {
        familyId,
        resource: compactRecipeResource(resource),
        ...(tiers && tiers.size > 1
          ? {
              tiers: [...tiers.entries()]
                .sort((left, right) => VOLTAGE_TIER_ORDER.indexOf(left[0]) - VOLTAGE_TIER_ORDER.indexOf(right[0]))
                .map(([tier, tierResource]) => ({ tier, resource: compactRecipeResource(tierResource) })),
            }
          : {}),
      };
    })
    .sort((left, right) => left.familyId.localeCompare(right.familyId)),
  generatedAt,
  // Last, and only when the export has NEI's list: build-resource-index turns it into resourceOrder.
  ...(neiItemOrder ? { neiItemOrder } : {}),
};

if (dataset.recipes.length === 0) {
  throw new Error("Oracle normalization produced zero recipes.");
}

await writeOracleReport(dataset);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await writeDatasetJson(outputPath, dataset);
console.log(`Wrote ${dataset.recipes.length} oracle recipe(s) to ${outputPath}.`);

function normalizeGregtech(domain) {
  for (const recipeMap of domain?.recipeMaps ?? []) {
    const exportedName = text(recipeMap.name, recipeMap.id ?? "GregTech");
    const machineType =
      RECIPE_MAP_DISPLAY_NAMES.get(recipeMap.id) ??
      (exportedName === recipeMap.id ? UNTRANSLATED_RECIPE_MAP_NAMES.get(recipeMap.id) : undefined) ??
      exportedName;
    recipeMaps.add(machineType);
    setRecipeMapIcon(machineType, recipeMap.icon);
    if (recipeMap.id === "gt.recipe.furnace") {
      furnaceCatalysts = recipeMap.catalysts ?? [];
    }
    // Catalysts are the machines NEI lists for this recipe map. The primary
    // machine's tooltip drives the recipe-level config controls; the other
    // machines become selectable handlers with their own stats, so one
    // machine's bonuses no longer leak onto another (the Dangote Distillus
    // used to force 12 parallels onto the plain Distillation Tower).
    const handlerTemplates = buildMachineHandlerTemplates(machineType, recipeMap.catalysts, singleblockFamilyIds, gtnhVersion);
    registerMachineHandlerIcons(handlerTemplates);
    const catalystControls = primaryMachineHandlerControls(handlerTemplates);
    for (const rawRecipe of recipeMap.recipes ?? []) {
      const inputs = [
        ...(rawRecipe.itemInputs ?? []).map((entry) =>
          resourceAmount(entry, { consumed: entry.consumed === false ? false : undefined }),
        ),
        ...(rawRecipe.nonConsumedInputs ?? []).map((entry) =>
          resourceAmount(entry, { consumed: false }),
        ),
        ...(rawRecipe.fluidInputs ?? []).map((entry) => resourceAmount(entry)),
      ].filter(Boolean);
      const outputs = [
        ...(rawRecipe.itemOutputs ?? []).map((entry) =>
          resourceAmount(entry, { chance: entry.chance }),
        ),
        ...(rawRecipe.fluidOutputs ?? []).map((entry) => resourceAmount(entry)),
      ].filter(Boolean);

      if (outputs.length === 0) {
        continue;
      }
      // The sparge tower's rolled outputs join after the exported ones. The
      // recipe id still hashes only the exported slots, so saved plans keep
      // their recipe.
      const sparge = spargeRolledOutputs(rawRecipe, (entry) => resourceAmount(entry));
      const machineConfigControls = machineConfigControlsForOracleRecipe(
        machineType,
        rawRecipe.specialValue,
        catalystControls,
        gtnhVersion,
      );
      // A singleblock finds the recipe at its voltage times the map's amps; a
      // multiblock's hatches must carry the whole draw (drawTier).
      const drawTier = voltageTierForEu(rawRecipe.eut ?? 0);
      const mapAmps = recipeMapAmperage(recipeMap.id, gtnhVersion);
      const minimumTier = mapAmps > 1 ? voltageTierForEu((Number(rawRecipe.eut) || 0) / mapAmps) : drawTier;
      const durationTicks = positiveInt(rawRecipe.durationTicks, 1);
      const eut = Math.max(0, Number(rawRecipe.eut) || 0);
      const machineHandlers = withoutSteamHandlersLackingFluidHatches(
        instantiateRecipeMachineHandlers(handlerTemplates, {
          minimumTier,
          drawTier,
          durationTicks,
          eut,
          machineConfigControls,
        }),
        inputs,
        outputs,
        gtnhVersion,
      );
      addRecipe({
        contentId: {
          idParts: ["gregtech", gameRecipeMapId(recipeMap.id)],
          rawPrefix: recipeMap.id,
          key: recipeContentKey(gameRecipeMapId(recipeMap.id), {
            inputs,
            outputs,
            durationTicks,
            eut,
            specialValue: Number(rawRecipe.specialValue) || 0,
          }),
        },
        name: `${machineType}: ${resourceLabel(outputs[0])}`,
        kind: "gregtech_machine",
        category: "gregtech",
        machineType,
        minimumTier,
        durationTicks,
        eut,
        inputs,
        outputs: sparge ? [...outputs, ...sparge.outputs] : outputs,
        machineConfigControls,
        machineHandlers,
        runtimeCalculation: normalizeRuntimeCalculation(
          rawRecipe.runtimeCalculation,
          machineType,
          sparge ? [...outputs, ...sparge.outputs] : outputs,
        ),
        programmedCircuit: detectProgrammedCircuit(inputs),
        specialValue: Number(rawRecipe.specialValue) || 0,
        notes: "Exported by the GTNH calculation oracle from gregtech.api.recipe.RecipeMap.",
        source: {
          datasetVersionId,
          recipeMap: machineType,
          exporter: "gtnh-oracle",
        },
        nei: {
          additionalInfo: [
            `Special value: ${rawRecipe.specialValue ?? 0}`,
            ...(sparge ? [sparge.note] : []),
          ],
        },
        metadata: {
          recipeMapId: recipeMap.id,
          specialValue: Number(rawRecipe.specialValue) || 0,
          ...(recipeMap.id === "gt.recipe.fusionreactor" && Number.isFinite(rawRecipe.fusionStartupEu)
            ? { fusionStartupEu: rawRecipe.fusionStartupEu } : {}),
          ...(sparge ? { spargeMaxByproduct: sparge.maxByproduct } : {}),
        },
      });

      // 2.9 keeps cell fills/empties in the canner map; 2.8.4 and earlier
      // had them in their own fluidcanner map. The fluid-touch filter inside
      // keeps food canning out either way.
      if (recipeMap.id === "gt.recipe.canner" || recipeMap.id === "gt.recipe.fluidcanner") {
        addTankRecipe(inputs, outputs);
      }
    }
  }
  setRecipeMapIcon(TANK_MACHINE_TYPE, tankIconFallback);
  overrideTankRecipeMapIcon();
}

/**
 * The Tank's face is the Low Voltage Fluid Tank, named simply "Fluid Tank"
 * (Jack, 2026-09-07): a card names itself after its map's machine, and the
 * empty cell it wore before made every Tank card read "Empty Cell". The cell
 * face above stays as the fallback for an export with no fluid tank item.
 */
function overrideTankRecipeMapIcon() {
  const tank = [...resources.values()].find(
    (resource) => resource.kind === "item" && resource.displayName === "Low Voltage Fluid Tank",
  );
  if (!recipeMaps.has(TANK_MACHINE_TYPE) || !tank?.iconPath) {
    return;
  }
  recipeMapIcons.set(TANK_MACHINE_TYPE, {
    kind: tank.kind,
    id: tank.id,
    amount: 1,
    displayName: "Fluid Tank",
    iconPath: tank.iconPath,
    dominantColor: tank.dominantColor,
    modId: tank.modId,
  });
}

/**
 * The Tank: the planner's free canner (Jack, 2026-08-23). Every Canner recipe
 * that touches a fluid - filling a cell, emptying one - is offered a second
 * time under this machine at zero EU and one tick, the same "instant" shape
 * hand-crafting wears. It keeps the REAL slots, empty cells included: the
 * game never deletes an emptied cell and neither does the planner. What it
 * waives is the Canner's power and time, so a chain that just needs the other
 * form of a fluid does not drag a powered machine line in with it.
 */
function addTankRecipe(inputs, outputs) {
  if (![...inputs, ...outputs].some((entry) => entry.kind === "fluid")) {
    return;
  }
  recipeMaps.add(TANK_MACHINE_TYPE);
  const face = [...inputs, ...outputs].find((entry) => entry.kind === "item");
  if (face?.id === "ic2:itemcellempty") {
    // The recognizable face for the machine chip; first-wins, so claim it
    // the moment the plain empty cell shows up and fall back otherwise.
    setRecipeMapIcon(TANK_MACHINE_TYPE, face);
  } else if (face && !tankIconFallback) {
    tankIconFallback = face;
  }
  addRecipe({
    contentId: {
      idParts: ["gregtech", "planner.tank"],
      rawPrefix: "planner.tank",
      key: recipeContentKey("planner.tank", { inputs, outputs, durationTicks: 1, eut: 0, specialValue: 0 }),
    },
    name: `Tank: ${resourceLabel(outputs[0])}`,
    kind: "gregtech_machine",
    category: "gregtech",
    machineType: TANK_MACHINE_TYPE,
    minimumTier: "NONE",
    durationTicks: 1,
    eut: 0,
    inputs: inputs.map((entry) => ({ ...entry })),
    outputs: outputs.map((entry) => ({ ...entry })),
    programmedCircuit: detectProgrammedCircuit(inputs),
    specialValue: 0,
    notes: "A free, instant canner: the planner's tank. Synthesized from the Canner map.",
    source: {
      datasetVersionId,
      recipeMap: TANK_MACHINE_TYPE,
      exporter: "gtnh-oracle",
    },
    nei: {
      additionalInfo: ["Free and instant: a planner convenience, not a placeable machine."],
    },
    metadata: {
      recipeMapId: "planner.tank",
      specialValue: 0,
    },
  });
}

function normalizeCrafting(domain) {
  for (const rawRecipe of domain?.recipes ?? []) {
    const output = resourceAmount(rawRecipe.output, { neiSlot: { x: 124, y: 26 } });
    if (!output) {
      continue;
    }
    const machineType = rawRecipe.type === "shapeless" ? "Shapeless Crafting" : "Shaped Crafting";
    recipeMaps.add(machineType);
    setRecipeMapIcon(machineType, {
      kind: "item",
      id: "minecraft:crafting_table",
      amount: 1,
      displayName: "Crafting Table",
    });
    const craftingSlots = (rawRecipe.inputs ?? [])
      .map((entry, index) => ({
        gridSlot: entry.slotIndex ?? index,
        resource: resourceAmount(entry, {
          neiSlot: craftingInputNeiSlot(rawRecipe, entry.slotIndex ?? index),
        }),
      }))
      .filter((slot) => slot.resource);
    const craftingInputs = craftingSlots.map((slot) => slot.resource);
    const inputGrid = craftingInputGrid(rawRecipe);
    addRecipe({
      contentId: {
        idParts: ["crafting", rawRecipe.type],
        key: recipeContentKey(machineType, {
          // A shaped recipe is its pattern: the same items in another layout make another
          // recipe. The grid cell comes from the export, since ore dictionary slots carry no
          // neiSlot.
          inputs: craftingSlots.map(({ gridSlot, resource }) =>
            rawRecipe.type === "shapeless" ? resource : { ...resource, gridSlot },
          ),
          outputs: [output],
        }),
      },
      name: `${machineType}: ${resourceLabel(output)}`,
      kind: "gregtech_machine",
      category: "crafting",
      machineType,
      minimumTier: "NONE",
      durationTicks: 1,
      eut: 0,
      inputs: craftingInputs,
      outputs: [output],
      notes: "Exported by the GTNH calculation oracle from Minecraft/Forge crafting registries.",
      source: {
        datasetVersionId,
        recipeMap: machineType,
        exporter: "gtnh-oracle",
        rawRecipeId: rawRecipe.id,
      },
      nei: {
        itemInputGrid: inputGrid,
        itemOutputGrid: { width: 1, height: 1 },
        slots: craftingNeiSlots(rawRecipe, craftingInputs.length),
        progressBars: [{ x: 84, y: 26, width: 24, height: 17, direction: "right" }],
      },
    });
  }
}

function normalizeSmelting(domain) {
  const machineType = "Furnace";
  const handlerTemplates = furnaceHandlerTemplates();
  for (const rawRecipe of domain?.recipes ?? []) {
    const input = resourceAmount(rawRecipe.input);
    const output = resourceAmount(rawRecipe.output);
    if (!input || !output) {
      continue;
    }
    recipeMaps.add(machineType);
    addRecipe({
      contentId: {
        idParts: ["smelting"],
        key: recipeContentKey(machineType, { inputs: [input], outputs: [output] }),
      },
      name: `${machineType}: ${resourceLabel(output)}`,
      kind: "gregtech_machine",
      category: "furnace",
      machineType,
      minimumTier: "NONE",
      durationTicks: 200,
      eut: 0,
      inputs: [input],
      outputs: [output],
      machineHandlers: instantiateRecipeMachineHandlers(handlerTemplates, {
        minimumTier: "NONE",
        durationTicks: 200,
        eut: 0,
      }),
      notes: "Exported by the GTNH calculation oracle from FurnaceRecipes.",
      source: {
        datasetVersionId,
        recipeMap: machineType,
        exporter: "gtnh-oracle",
        rawRecipeId: rawRecipe.id,
      },
    });
  }
}

/**
 * Machine choices for vanilla smelting recipes: the plain furnace as primary,
 * plus the machines NEI lists for gt.recipe.furnace. Every electric
 * single-block on that map is a tier of the same machine line (Electric
 * Furnace, Electric Oven, and joke names like Atom Stimulator or Electron
 * Excitement Processor), so they fold into one LV Electric Furnace family
 * running GT's fixed furnace recipe stats (FurnaceBackend:
 * duration(128).eut(4)). Steam machines and multiblocks keep the vanilla
 * 200-tick base because the export carries no steam costs; the Multi
 * Smelter's parallels arrive through its parsed tooltip controls.
 */
function furnaceHandlerTemplates() {
  const templates = buildMachineHandlerTemplates("Furnace", furnaceCatalysts, singleblockFamilyIds, gtnhVersion);
  registerMachineHandlerIcons(templates);
  if (templates.length === 0) {
    return [];
  }
  const isElectricSingle = (template) =>
    template.kind === "single" && template.minimumTier !== undefined;
  const electricTiers = templates
    .filter(isElectricSingle)
    .map((template) => GT_VOLTAGE_NAMES.indexOf(template.minimumTier))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  const electricFamily =
    electricTiers.length > 0
      ? [
          {
            ...templates.find(isElectricSingle),
            id: "electric-furnace",
            label: "Electric Furnace",
            kind: "single",
            minimumTier: GT_VOLTAGE_NAMES[electricTiers[0]],
            durationTicks: 128,
            eut: 4,
          },
        ]
      : [];
  const rest = templates
    .filter((template) => !isElectricSingle(template))
    .map((template) => removeUndefined({ ...template, isPrimary: undefined }));
  return [
    { id: "furnace", label: "Furnace", kind: "single", isPrimary: true },
    ...electricFamily,
    ...rest,
  ];
}

/**
 * The "Furnace" map's recipes are vanilla smelting, so its icon must be the
 * vanilla furnace — not the Multi Smelter that the empty gt.recipe.furnace
 * shell (or the gt.recipe.microwave map, which shares the "Furnace" name)
 * exported as its NEI icon.
 */
function overrideFurnaceRecipeMapIcon() {
  const furnace = resources.get("item:minecraft:furnace");
  if (!recipeMaps.has("Furnace") || !furnace?.iconPath) {
    return;
  }
  const furnaceIcon = {
    kind: furnace.kind,
    id: furnace.id,
    amount: 1,
    displayName: furnace.displayName,
    iconPath: furnace.iconPath,
    dominantColor: furnace.dominantColor,
    modId: furnace.modId,
  };
  recipeMapIcons.set("Furnace", furnaceIcon);
  // The synthetic vanilla-furnace handler has no catalyst to take a face from.
  machineHandlerIcons.set("furnace", furnaceIcon);
}

function normalizeThaumcraft(domain) {
  for (const rawRecipe of domain?.recipes ?? []) {
    const normalizedRecipe = normalizeThaumcraftRecipe(rawRecipe);
    const outputs = normalizedRecipe.outputs?.length
      ? normalizedRecipe.outputs
      : normalizedRecipe.output
        ? [normalizedRecipe.output]
        : [];
    const output = outputs[0];
    if (!output || outputs.length === 0) {
      continue;
    }
    const machineType = thaumcraftMachineType(rawRecipe.type);
    const inputs = normalizedRecipe.inputs;

    recipeMaps.add(machineType);
    setRecipeMapIcon(
      machineType,
      rawRecipe.neiLayout?.category?.icon ?? thaumcraftRecipeMapIcon(rawRecipe.type),
    );
    const durationTicks = positiveInt(rawRecipe.durationTicks, thaumcraftDuration(rawRecipe.type));
    addRecipe({
      contentId: {
        idParts: ["thaumcraft", rawRecipe.type],
        key: recipeContentKey(machineType, {
          inputs: normalizedRecipe.keyInputs ?? inputs,
          outputs,
          durationTicks,
          // An arcane layout from NEI has no grid cells, so its slot positions stand in.
          positional: !normalizedRecipe.keyInputs && rawRecipe.type === "arcane",
        }),
      },
      name: `${machineType}: ${resourceLabel(output)}`,
      kind: rawRecipe.type === "essentiaSmelting" ? "essentia_smelting" : "gregtech_machine",
      category: "thaumcraft",
      machineType,
      minimumTier: "NONE",
      durationTicks,
      eut: 0,
      inputs,
      outputs,
      runtimeCalculation: {
        sourceKind: "thaumcraft-runtime",
        sourceClass: rawRecipe.className,
        recipeMap: machineType,
        status: "computed",
        oracleEligible: true,
        strict: true,
        generatedAt,
        variants: [
          {
            id: "base",
            label: text(rawRecipe.type, "Thaumcraft"),
            durationTicks,
            eut: 0,
            outputs: runtimeResources(outputs),
            notes: rawRecipe.durationSource
              ? `Duration exported from ${rawRecipe.durationSource}.`
              : undefined,
          },
          ...(rawRecipe.variants ?? []).map((variant) => ({
            id: text(variant.id, "variant"),
            label: text(variant.label, "Variant"),
            durationTicks: positiveInt(variant.durationTicks, durationTicks),
            eut: 0,
            outputs: runtimeResources(outputs),
            notes:
              variant.bellows !== undefined
                ? `Alchemical Furnace bellows: ${variant.bellows}.`
                : undefined,
          })),
        ],
      },
      notes: [
        `Exported by the GTNH calculation oracle from ${rawRecipe.className}.`,
        rawRecipe.research ? `Research: ${rawRecipe.research}` : undefined,
        rawRecipe.instability !== undefined ? `Instability: ${rawRecipe.instability}` : undefined,
        rawRecipe.notes,
      ]
        .filter(Boolean)
        .join(" "),
      source: {
        datasetVersionId,
        recipeMap: machineType,
        exporter: "gtnh-oracle",
        rawRecipeId: rawRecipe.id,
      },
      nei: normalizedRecipe.nei,
      metadata: {
        thaumcraftType: rawRecipe.type,
        research: rawRecipe.research,
        instability: rawRecipe.instability,
      },
    });
  }
}

function normalizeThaumcraftRecipe(rawRecipe) {
  const exportedLayout = normalizeExportedNeiLayout(rawRecipe.neiLayout);
  if (exportedLayout) {
    return exportedLayout;
  }

  const type = text(rawRecipe.type, "thaumcraft");
  const inputs = [];
  const slots = [];
  const progressBars = [];
  const addSlot = (side, kind, slotIndex, slot) => {
    if (!slot) return;
    slots.push({ side, kind, slotIndex, x: slot.x, y: slot.y });
  };
  const addInput = (rawResource, slot, slotIndex) => {
    const resource = resourceAmount(rawResource, { neiSlot: slot });
    if (!resource) return undefined;
    inputs.push(resource);
    addSlot("input", resource.kind, slotIndex, slot);
    return resource;
  };

  const outputSlot =
    type === "infusion"
      ? { x: 75, y: 1 }
      : type === "crucible"
        ? { x: 76, y: 8 }
        : type === "essentiaSmelting"
          ? undefined
          : { x: 74, y: 2 };
  const output = resourceAmount(rawRecipe.output, { neiSlot: outputSlot });
  if (output) {
    addSlot("output", output.kind, 0, outputSlot);
  }

  if (type === "essentiaSmelting") {
    addInput(rawRecipe.input, { x: 42, y: 34 }, 0);
    const aspectSlots = thaumcraftAspectSlots(
      (rawRecipe.outputs ?? rawRecipe.aspects ?? []).length,
      112,
      34,
    );
    const outputs = (rawRecipe.outputs ?? rawRecipe.aspects ?? [])
      .map((entry, index) => resourceAmount(entry, { neiSlot: aspectSlots[index] }))
      .filter(Boolean);
    outputs.forEach((resource, index) =>
      slots.push({
        side: "output",
        kind: resource.kind,
        slotIndex: index,
        x: aspectSlots[index].x,
        y: aspectSlots[index].y,
      }),
    );
    progressBars.push({ x: 72, y: 35, width: 24, height: 17, direction: "right" });
    return {
      output: outputs[0],
      outputs,
      inputs,
      nei: { slots, progressBars },
    };
  } else if (type === "infusion") {
    addInput(rawRecipe.centralInput ?? rawRecipe.catalyst, { x: 75, y: 58 }, 0);
    const componentSlots = thaumcraftInfusionComponentSlots((rawRecipe.components ?? []).length);
    (rawRecipe.components ?? []).forEach((entry, index) =>
      addInput(entry, componentSlots[index], index + 1),
    );
    const aspectSlots = thaumcraftInfusionAspectSlots((rawRecipe.aspects ?? []).length);
    (rawRecipe.aspects ?? []).forEach((entry, index) => addInput(entry, aspectSlots[index], index));
  } else if (type === "crucible") {
    addInput(rawRecipe.catalyst ?? rawRecipe.centralInput, { x: 60, y: 34 }, 0);
    const aspectSlots = thaumcraftCrucibleAspectSlots((rawRecipe.aspects ?? []).length);
    (rawRecipe.aspects ?? []).forEach((entry, index) => addInput(entry, aspectSlots[index], index));
  } else if (type === "arcane") {
    const componentSlots = thaumcraftArcaneComponentSlots();
    // A shaped ingredient sits in its exported 3x3 cell (`gridSlot`), which also goes into the
    // recipe's id: the same items in another pattern are another recipe. Shapeless ingredients
    // and aspects fill their slots in order and carry no position.
    const rawInputs = [
      rawRecipe.centralInput,
      rawRecipe.catalyst,
      ...(rawRecipe.components ?? []),
    ].filter(Boolean);
    const keyInputs = [];
    rawInputs.forEach((entry, index) => {
      const gridSlot = Number.isInteger(entry.gridSlot) ? entry.gridSlot : undefined;
      const resource = addInput(entry, componentSlots[gridSlot ?? index], gridSlot ?? index);
      if (resource) keyInputs.push(gridSlot === undefined ? resource : { ...resource, gridSlot });
    });
    const aspectSlots = thaumcraftArcaneAspectSlots((rawRecipe.aspects ?? []).length);
    (rawRecipe.aspects ?? []).forEach((entry, index) => {
      const resource = addInput(entry, aspectSlots[index], index);
      if (resource) keyInputs.push(resource);
    });
    return {
      output,
      outputs: output ? [output] : [],
      inputs,
      keyInputs,
      nei: slots.length > 0 ? { slots, progressBars } : undefined,
    };
  } else {
    [rawRecipe.centralInput, rawRecipe.catalyst, ...(rawRecipe.components ?? [])].forEach(
      (entry, index) => addInput(entry, compactCraftingInputPositions(6)[index], index),
    );
    (rawRecipe.aspects ?? []).forEach((entry, index) =>
      addInput(
        entry,
        thaumcraftAspectSlots((rawRecipe.aspects ?? []).length, 16, 62)[index],
        index,
      ),
    );
  }

  return {
    output,
    outputs: output ? [output] : [],
    inputs,
    nei:
      slots.length > 0
        ? {
            slots,
            progressBars,
          }
        : undefined,
  };
}

function normalizeExportedNeiLayout(rawLayout) {
  if (!rawLayout || typeof rawLayout !== "object" || !Array.isArray(rawLayout.slots)) {
    return undefined;
  }

  const inputs = [];
  const outputs = [];
  const slots = [];
  for (const rawSlot of rawLayout.slots) {
    const side = rawSlot?.side === "output" ? "output" : "input";
    const slot = {
      x: positiveInt(rawSlot?.x, 0),
      y: positiveInt(rawSlot?.y, 0),
    };
    const resource = resourceAmount(rawSlot?.resource, { neiSlot: slot });
    if (!resource) {
      continue;
    }
    const slotIndex = positiveInt(
      rawSlot?.slotIndex,
      side === "output" ? outputs.length : inputs.length,
    );
    slots.push({ side, kind: resource.kind, slotIndex, x: slot.x, y: slot.y });
    if (side === "output") {
      outputs.push(resource);
    } else {
      inputs.push(resource);
    }
  }

  if (outputs.length === 0) {
    return undefined;
  }

  const canvas =
    rawLayout.canvas && typeof rawLayout.canvas === "object"
      ? {
          width: positiveInt(rawLayout.canvas.width, 170),
          height: positiveInt(rawLayout.canvas.height, 82),
        }
      : undefined;

  return {
    output: outputs[0],
    inputs,
    nei: {
      source: text(rawLayout.source, "gtnh-nei-handler"),
      handlerClass: text(rawLayout.handlerClass, undefined),
      canvas,
      slots,
      progressBars: [],
    },
  };
}

function thaumcraftInfusionComponentSlots(count) {
  if (count <= 0) {
    return [];
  }
  const step = 360 / count;
  return Array.from({ length: count }, (_, index) => {
    const angle = (-90 + step * index) * (Math.PI / 180);
    return {
      x: 75 + Math.trunc(Math.cos(angle) * 40),
      y: 59 + Math.trunc(Math.sin(angle) * 40),
    };
  });
}

function thaumcraftInfusionAspectSlots(count) {
  const perRow = 9;
  const rows = Math.floor(count / perRow);
  const centerOffset = (5 - (count % perRow)) * 10;
  const baseX = 35;
  const baseY = 114 - 10 * rows;
  return Array.from({ length: count }, (_, index) => {
    const wrap = Math.floor(index / perRow) >= rows && (rows > 1 || count < perRow) ? 1 : 0;
    return {
      x: baseX + (index % perRow) * 20 + centerOffset * wrap,
      y: baseY + Math.floor(index / perRow) * 20,
    };
  });
}

function thaumcraftCrucibleAspectSlots(count) {
  const rows = Math.floor((count - 1) / 3);
  const centerOffset = (3 - (count % 3)) * 10;
  const baseX = 51;
  const baseY = 79 - 10 * rows;
  return Array.from({ length: count }, (_, index) => {
    const wrap = Math.floor(index / 3) >= rows && (rows > 1 || count < 3) ? 1 : 0;
    return {
      x: baseX + (index % 3) * 20 + centerOffset * wrap,
      y: baseY + Math.floor(index / 3) * 20,
    };
  });
}

function thaumcraftArcaneComponentSlots() {
  return [
    { x: 48, y: 33 },
    { x: 75, y: 33 },
    { x: 103, y: 33 },
    { x: 49, y: 60 },
    { x: 76, y: 60 },
    { x: 103, y: 60 },
    { x: 49, y: 87 },
    { x: 76, y: 87 },
    { x: 103, y: 87 },
  ];
}

function thaumcraftArcaneAspectSlots(count) {
  return Array.from({ length: count }, (_, index) => ({
    x: 42 + 18 * index + (5 - count) * 8,
    y: 115,
  }));
}

function thaumcraftAspectSlots(count, x, y) {
  return Array.from({ length: count }, (_, index) => ({
    x: x + (index % 6) * 18,
    y: y + Math.floor(index / 6) * 18,
  }));
}

function normalizeForestryBees(domain) {
  const machineType = "Bee Produce";
  for (const species of domain?.species ?? []) {
    const outputs = [
      ...(species.products ?? []).map((entry) => beeProductOutput(entry)),
      ...(species.specialty ?? []).map((entry) => beeProductOutput(entry, true)),
    ].filter(Boolean);
    if (outputs.length === 0) {
      continue;
    }
    const input = beeSpeciesInput(species);
    const durationTicks = positiveInt(species.cycleTicks, 550);
    recipeMaps.add(machineType);
    setRecipeMapIcon(
      machineType,
      species.input ?? species.products?.[0]?.resource ?? species.specialty?.[0]?.resource,
      { ordered: true },
    );
    addRecipe({
      id: recipeId("forestry-bee", species.uid ?? species.name ?? hashRecipe(species)),
      name: `${text(species.name, species.uid ?? "Bee")} Produce`,
      kind: "bee_produce",
      category: "forestry-bee",
      machineType,
      minimumTier: "NONE",
      durationTicks,
      eut: 0,
      inputs: input ? [input] : [],
      outputs,
      runtimeCalculation: {
        sourceKind: "passive-bee",
        sourceClass: species.className,
        recipeMap: machineType,
        status: "computed",
        oracleEligible: true,
        strict: true,
        generatedAt,
        variants: [
          {
            id: "base-apiary",
            label: "Forestry species base cycle",
            machineConfigTiers: {
              beeSpeedGene: "normal",
              beeEnvironment: "preferred",
              beeFrameSlot1: "none",
              beeFrameSlot2: "none",
              beeFrameSlot3: "none",
            },
            durationTicks,
            eut: 0,
            outputs: runtimeResources(outputs),
          },
        ],
        warnings: [
          "Species products and chances come from the live Forestry allele API. Housing, frame, industrial, and mega modifiers require their matching oracle variant before being used as exact variants.",
        ],
      },
      notes: "Exported by the GTNH calculation oracle from Forestry bee allele species.",
      source: {
        datasetVersionId,
        recipeMap: machineType,
        exporter: "gtnh-oracle",
        rawRecipeId: species.uid ?? species.name,
      },
      metadata: {
        speciesUid: species.uid,
        speciesName: species.name,
        condition: species.humidity || species.temperature ? "Preferred environment" : undefined,
      },
    });
  }
}

/**
 * The Extreme Entity Crusher: one recipe per mob a Powered Spawner can hold.
 * The spawner is the recipe's non-consumed input (its own resource per mob,
 * the way a bee species is), the outputs are the drops a plain EEC can really
 * roll (see eec-drops.mjs) plus 120 L of Liquid XP, and `metadata.eec` keeps
 * what the app's machine math needs to replay weapons, Looting, infernals,
 * the ritual and the void switch. Several drops of one item share an output,
 * its amount the expected count; `metadata.eec.outputs[i]` lists them.
 */
function normalizeMobDrops(domain) {
  const mobs = domain?.mobs ?? [];
  if (mobs.length === 0) {
    return;
  }
  const unknown = unknownEecModifiers(mobs);
  if (unknown.length > 0) {
    console.warn(`EEC: chance modifiers with no rule, treated as gates: ${unknown.join(", ")}`);
  }
  const machine = domain.machine ?? {};
  const playerOnlyModifier = finiteNumber(machine.playerOnlyDropsModifier) ?? 0.1;
  const infernal = domain.infernal ?? {};
  const infernalSettings = removeUndefined({
    eliteRarity: finiteNumber(infernal.eliteRarity),
    ultraRarity: finiteNumber(infernal.ultraRarity),
    infernoRarity: finiteNumber(infernal.infernoRarity),
    minEliteModifiers: finiteNumber(infernal.minEliteModifiers),
    minUltraModifiers: finiteNumber(infernal.minUltraModifiers),
    minInfernoModifiers: finiteNumber(infernal.minInfernoModifiers),
    mobModHealthFactor: finiteNumber(infernal.mobModHealthFactor),
  });
  const spawnerIcon = resourceAmount(machine.spawner, { consumed: false });
  const experience = resourceAmount(machine.experience ?? { kind: "fluid", id: "xpjuice", amount: 120 });
  recipeMaps.add(EEC_MACHINE_TYPE);
  setRecipeMapIcon(EEC_MACHINE_TYPE, machine.controller);

  for (const mob of mobs) {
    const key = text(mob.key, "");
    if (!key) continue;
    const name = text(mob.displayName, key);
    const groups = new Map();
    const gated = [];
    for (const drop of mob.drops ?? []) {
      const resource = resourceAmount(drop.resource);
      if (!resource) continue;
      const c0 = eecDropChance(drop, { looting: 0, playerOnlyModifier });
      const cL = eecDropChance(drop, { looting: 1, playerOnlyModifier });
      if (c0 === 0 && cL === 0) {
        gated.push(resource.displayName);
        continue;
      }
      const entry = {
        amount: positiveInt(drop.resource?.amount, 1),
        c0,
        ...(cL !== c0 ? { cL } : {}),
        ...(drop.lootable ? { lootable: true } : {}),
        // What the EEC's "void damaged and enchanted" switch throws away.
        ...(drop.damages || drop.enchantable != null ? { voidable: true } : {}),
      };
      const group = groups.get(resource.id) ?? { resource, drops: [] };
      group.drops.push(entry);
      groups.set(resource.id, group);
    }
    // A mob whose every drop is gated still gives the EEC its Liquid XP.

    const outputs = [];
    const outputMeta = [];
    for (const { resource, drops } of groups.values()) {
      const expectedAt = (looting) =>
        drops.reduce(
          (sum, drop) =>
            sum +
            eecExpectedItems(drop.amount, looting > 0 ? (drop.cL ?? drop.c0) : drop.c0, drop.lootable, looting),
          0,
        );
      // The static figure is what drops with no weapon, or with Looting I for
      // a drop that only a Looting weapon makes (Forbidden Magic greed shards).
      const refLooting = expectedAt(0) > 0 ? 0 : 1;
      const single = drops.length === 1 && refLooting === 0;
      outputs.push({
        ...resource,
        amount: single ? drops[0].amount : roundExpected(expectedAt(refLooting)),
        chance: single && drops[0].c0 < 10000 ? drops[0].c0 / 10000 : undefined,
      });
      outputMeta.push({ ...(refLooting ? { refLooting } : {}), drops });
    }
    if (experience) {
      outputs.push({ ...experience, amount: 120 });
      outputMeta.push({ xp: true });
    }

    const alwaysInfernal = mob.alwaysInfernal === true;
    const baseEut = positiveInt(mob.eut, 1920);
    const eut = alwaysInfernal ? baseEut * 8 : baseEut;
    const health = finiteNumber(mob.maxEntityHealth) ?? 20;
    const spawner = removeUndefined({
      kind: "item",
      id: `factoryflow:eec_mob:${slug(key)}`,
      amount: 1,
      // The mob first: a card's input row has room for two short lines, and
      // this name is the only place on the card that says which mob it runs.
      displayName: `${name} Spawner`,
      iconPath: spawnerIcon?.iconPath,
      dominantColor: spawnerIcon?.dominantColor,
      modId: "EnderIO",
      tooltip: [
        `Powered Spawner holding a ${name}`,
        "Goes in the Extreme Entity Crusher's controller slot",
        `Health: ${health}`,
      ],
      consumed: false,
    });
    addRecipe({
      id: recipeId("kubatech-eec", key),
      name: `${EEC_MACHINE_TYPE}: ${name}`,
      kind: "gregtech_machine",
      category: "kubatech-eec",
      machineType: EEC_MACHINE_TYPE,
      minimumTier: GT_VOLTAGE_NAMES[voltageTierIndexForEuT(eut)],
      durationTicks: positiveInt(mob.durationTicks, 55),
      eut,
      inputs: [spawner],
      outputs: outputs.map(removeUndefined),
      notes: gated.length
        ? `Never drops in a plain EEC (needs an enchantment, weapon, dimension or other condition): ${[...new Set(gated)].join(", ")}.`
        : undefined,
      source: {
        datasetVersionId,
        recipeMap: EEC_MACHINE_TYPE,
        exporter: "gtnh-oracle",
        rawRecipeId: key,
      },
      metadata: {
        eec: removeUndefined({
          mob: key,
          entityName: mob.entityName,
          maxHealth: health,
          alwaysInfernal: alwaysInfernal || undefined,
          infernalityAllowed: mob.infernalityAllowed === false ? false : undefined,
          peacefulAllowed: mob.isPeacefulAllowed === true || undefined,
          baseEut,
          spawnInterval: finiteNumber(machine.mobSpawnInterval),
          spikesDamage: finiteNumber(machine.diamondSpikesDamage),
          maxLooting: finiteNumber(machine.maxLootingLevel),
          infernal: Object.keys(infernalSettings).length ? infernalSettings : undefined,
          outputs: outputMeta,
        }),
      },
    });
  }
}

function roundExpected(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** The lowest GT tier whose voltage covers `eut`, the recipe's own draw. */
function voltageTierIndexForEuT(eut) {
  let index = 0;
  while (index < GT_VOLTAGE_NAMES.length - 1 && 8 * 4 ** index < eut) index += 1;
  return index;
}

function normalizeIc2Crops(domain) {
  for (const rawCrop of domain?.crops ?? []) {
    const crop = { ...rawCrop, name: ic2CropDisplayName(rawCrop) };
    const variants = crop.variants ?? [];
    const conditional = variants.filter((variant) => ic2CropConditions(variant).length > 0);
    addIc2CropRecipe(
      crop,
      variants.filter((variant) => ic2CropConditions(variant).length === 0),
      conditional.length === 0 ? crop : undefined,
    );
    // A crop that drops something else on a block under it or with a redstone signal
    // (Stonelillies, Magic Metal Berry, Red Wheat) is one recipe per such condition.
    const groups = new Map();
    for (const variant of conditional) {
      const key = ic2CropConditions(variant)
        .map((condition) => text(condition.key, ""))
        .join("|");
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(variant);
    }
    for (const group of groups.values()) {
      addIc2CropRecipe(crop, group, undefined, ic2CropConditions(group[0]));
    }
  }
}

// IC2's own crop cards export their unlocalized name (`ic2.crop.redwheat`). The game names
// the crop's seed bag "<name> Seeds" with the translated name, so that is the display name;
// a crop with no seed bag takes a name made from the key's last part. Only IC2's crops (owner
// IC2, or with no owner an `ic2.` key) are renamed: another mod's dotted name is its own.
function ic2CropDisplayName(crop) {
  const name = text(crop.name, undefined);
  if (!name || !/^[\w-]+(\.[\w-]+)+$/.test(name)) {
    return name;
  }
  const owner = text(crop.owner, undefined);
  if (owner !== undefined ? owner.toLowerCase() !== "ic2" : !name.toLowerCase().startsWith("ic2.")) {
    return name;
  }
  const seedName = text(crop.seed?.displayName, "");
  const fromSeed = seedName.match(/^(.+) Seeds$/)?.[1]?.trim();
  if (fromSeed && !fromSeed.includes(".")) {
    return fromSeed;
  }
  return name
    .slice(name.lastIndexOf(".") + 1)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ic2CropConditions(variant) {
  return Array.isArray(variant?.conditions) ? variant.conditions.filter((condition) => condition?.key) : [];
}

// The sentence follows CropsNH's growth requirements ("Needs ... under it"), which the
// app reads as a block under the crop.
function ic2CropRequirement(conditions) {
  const blocks = conditions.filter((condition) => condition.kind !== "redstoneSignal");
  const parts = [];
  if (blocks.length > 0) {
    parts.push(`Needs ${ic2CropBlockNames(blocks)} under it`);
  }
  if (conditions.some((condition) => condition.kind === "redstoneSignal")) {
    parts.push("Needs a redstone signal");
  }
  return parts.join(". ");
}

function ic2CropBlockNames(blocks) {
  return [...new Set(blocks.map(ic2CropBlockName))].join(" or ");
}

// A player-facing name for a block under a crop, never a registry id. The oracle names a
// block after its item; a block with no item of its own (the skull block) comes back as its
// registry id, so it takes the name of the item with that id, else a name made from the id.
function ic2CropBlockName(condition) {
  const id = text(condition.block ?? condition.oreDict, text(condition.key, ""));
  const name = text(condition.displayName, "");
  if (name && name !== id && !/^[\w.-]+:[\w./-]+$/.test(name)) {
    return name;
  }
  if (condition.block) {
    const item = resources.get(`item:${canonicalResourceId("item", condition.block)}`);
    if (item?.displayName && !item.displayName.includes(":")) {
      return item.displayName;
    }
  }
  const bare = id.slice(id.indexOf(":") + 1);
  return bare
    .replace(/^(block|stone|ore)(?=[A-Z])/, "$1 ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ic2CropConditionLabel(conditions) {
  const blocks = conditions.filter((condition) => condition.kind !== "redstoneSignal");
  const parts = [];
  if (blocks.length > 0) {
    parts.push(`on ${ic2CropBlockNames(blocks)}`);
  }
  if (conditions.some((condition) => condition.kind === "redstoneSignal")) {
    parts.push("with a redstone signal");
  }
  return parts.join(", ");
}

function ic2CropConditionSlug(conditions) {
  return conditions
    .map((condition) =>
      condition.kind === "redstoneSignal"
        ? "redstone-signal"
        : `under-${text(condition.oreDict ?? condition.block, condition.key)}`,
    )
    .join("-or-");
}

function addIc2CropRecipe(crop, variants, fallback, conditions = []) {
  const machineType = "IC2 Crop";
  const baseVariant =
    variants.find((variant) => variant.id === "23-31-0") ??
    variants.find((variant) => variant.id === "31-31-31") ??
    variants[0] ??
    fallback;
  if (!baseVariant) {
    return;
  }
  const outputs = cropOutputs(baseVariant.drops ?? fallback?.drops);
  if (outputs.length === 0) {
    return;
  }
  const input = cropSeedInput(crop);
  const durationTicks = positiveInt(baseVariant.durationTicks ?? fallback?.durationTicks, 200);
  const cropKey = crop.id ?? crop.name ?? hashRecipe(crop);
  const conditionSlug = conditions.length > 0 ? ic2CropConditionSlug(conditions) : undefined;
  const requirement = conditions.length > 0 ? ic2CropRequirement(conditions) : undefined;

  recipeMaps.add(machineType);
  setRecipeMapIcon(
    machineType,
    crop.seed ?? crop.displayItem ?? baseVariant.drops?.[0]?.resource,
    { ordered: true },
  );
  addRecipe({
    id: recipeId("ic2-crop", crop.owner, cropKey, conditionSlug),
    name: `${machineType}: ${text(crop.name, crop.id ?? "Crop")}${
      conditions.length > 0 ? ` (${ic2CropConditionLabel(conditions)})` : ""
    }`,
    kind: "crop_produce",
    category: "ic2-crop",
    machineType,
    minimumTier: "NONE",
    durationTicks,
    eut: 0,
    inputs: input ? [input] : [],
    outputs,
    runtimeCalculation: {
      sourceKind: "passive-crop",
      sourceClass: crop.className,
      recipeMap: machineType,
      status: "computed",
      oracleEligible: true,
      strict: true,
      generatedAt,
      variants: cropRuntimeVariants(variants, outputs, durationTicks),
      warnings: [
        "Crop drops are calculated by live IC2/CropsNH crop-card methods with a simulated server crop tile. Environment-specific support blocks are represented by separate controls when the crop exposes enough data.",
      ],
    },
    notes: [
      "Exported by the GTNH calculation oracle from IC2/CropsNH crop-card APIs.",
      crop.owner ? `Owner: ${crop.owner}` : undefined,
      crop.tier !== undefined ? `Tier: ${crop.tier}` : undefined,
      requirement ? `${requirement}.` : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    source: {
      datasetVersionId,
      recipeMap: machineType,
      exporter: "gtnh-oracle",
      rawRecipeId: `${crop.owner ?? "unknown"}:${cropKey}${conditionSlug ? `:${conditionSlug}` : ""}`,
    },
    metadata: removeUndefined({
      cropOwner: crop.owner,
      cropId: crop.id,
      cropTier: crop.tier,
      requirements: requirement ? [requirement] : undefined,
      cropConditions:
        conditions.length > 0
          ? conditions.map((condition) =>
              removeUndefined({
                kind: text(condition.kind, undefined),
                oreDict: text(condition.oreDict, undefined),
                block: text(condition.block, undefined),
                displayName:
                  condition.kind === "redstoneSignal" ? text(condition.displayName, undefined) : ic2CropBlockName(condition),
              }),
            )
          : undefined,
    }),
    nei: {
      slots: [
        { side: "input", kind: "item", slotIndex: 0, x: 34, y: 35 },
        ...outputs.map((output, index) => ({
          side: "output",
          kind: output.kind,
          slotIndex: index,
          x: 124 + index * 18,
          y: 35,
        })),
      ],
      progressBars: [
        { x: 78, y: 35, width: 24, height: 17, direction: "right", texture: "arrow" },
      ],
    },
  });
}

// CropsNH steady-state reference point: perfect 31/31/31 seeds on a fully
// supplied farm (water 100, fertilizer 100, sky access, both biome tags).
// The app recomputes duration/output continuously from the same formulas
// (verified against TileEntityCropSticks bytecode) when controls change.
// Hoisted function: normalizeCropsNhCrops runs during module evaluation.
function cropsNhReference() {
  return { growth: 31, gain: 31, water: 100, fertilizer: 100, sky: true, biomeBonus: 28 };
}

function normalizeCropsNhCrops(domain) {
  const CROPSNH_REFERENCE = cropsNhReference();
  const machineType = "Crop Farm";
  const crops = domain?.crops ?? [];
  if (crops.length === 0) {
    return;
  }
  const growthCycleTicks = positiveInt(domain?.config?.growthCycleTicks, 256);
  const growthMultiplier = positiveNumber(domain?.config?.growthMultiplier, 1);

  for (const crop of crops) {
    const tier = positiveInt(crop.tier, 1);
    const growthPoints = positiveInt(crop.growthDuration, 0);
    const dropChance = positiveNumber(crop.dropChance, 0);
    // The export lists drops in hash-map order; the slots show them heaviest first.
    const dropTable = orderCropDrops(
      (crop.dropTable ?? [])
        .map((entry) => ({
          resource: resourceAmount(entry.resource),
          stackSize: positiveNumber(entry.resource?.amount, 1),
          weight: positiveInt(entry.weight, 0),
        }))
        .filter((entry) => entry.resource && entry.weight > 0),
    );
    if (growthPoints <= 0 || dropChance <= 0 || dropTable.length === 0) {
      continue;
    }

    const durationTicks = cropsNhDurationTicks(
      { tier, growthPoints, growthCycleTicks, growthMultiplier },
      CROPSNH_REFERENCE,
    );
    if (!Number.isFinite(durationTicks) || durationTicks <= 0) {
      continue;
    }

    const dropRounds = dropChance * 1.03 ** CROPSNH_REFERENCE.gain;
    const outputSlot = (index) => ({
      x: 124 + (index % 4) * 18,
      y: dropTable.length > 4 ? 26 + Math.floor(index / 4) * 18 : 35,
    });
    const outputs = dropTable.map((entry, index) => ({
      ...entry.resource,
      amount: roundAmount(
        dropRounds * (entry.weight / 10000) * (entry.stackSize + (CROPSNH_REFERENCE.gain + 1) / 100),
      ),
      // Display badge only: the weight is ALREADY inside `amount` above, so
      // the app must never multiply crop amounts by `chance` again
      // (`getChanceMultiplier` knows this).
      chance: entry.weight < 10000 ? entry.weight / 10000 : undefined,
      neiSlot: outputSlot(index),
    }));

    const input = cropsNhSeedInput(crop);
    recipeMaps.add(machineType);
    setRecipeMapIcon(machineType, crop.seed ?? heaviestRawDrop(crop), { ordered: true });
    addRecipe({
      id: recipeId("cropsnh-crop", "cropsnh", crop.id ?? crop.name ?? hashRecipe(crop)),
      name: `${machineType}: ${text(crop.name, crop.id ?? "Crop")}`,
      kind: "crop_produce",
      category: "cropsnh-crop",
      machineType,
      minimumTier: "NONE",
      durationTicks,
      eut: 0,
      inputs: input ? [input] : [],
      outputs,
      metadata: {
        cropsNh: removeUndefined({
          cropId: text(crop.id, undefined),
          tier,
          growthPoints,
          dropChance,
          growthCycleTicks,
          growthMultiplier,
          minSeedBedTier: Number.isFinite(Number(crop.minSeedBedTier))
            ? Number(crop.minSeedBedTier)
            : undefined,
          machineOnly: crop.machineOnly === true ? true : undefined,
          // Sets in the game, exported in hash-set order: sorted so a rebuild keeps them.
          biomeTags: normalizeStringArray(crop.likedBiomeTags)?.sort(),
          requirements: normalizeStringArray(crop.growthRequirements),
          soils: normalizeStringArray(
            (crop.soils ?? []).map((entry) => entry?.displayName).filter(Boolean),
          )?.sort(),
          drops: dropTable.map((entry) => ({
            id: entry.resource.id,
            stackSize: entry.stackSize,
            weight: entry.weight,
          })),
        }),
      },
      notes: [
        "Exported by the GTNH calculation oracle from the live CropsNH crop registry.",
        `Tier ${tier}, ${growthPoints} growth points, base drop chance x${dropChance}.`,
        crop.machineOnly === true ? "Grows only inside an Industrial Farm." : undefined,
        ...(normalizeStringArray(crop.growthRequirements) ?? []),
      ]
        .filter(Boolean)
        .join(" "),
      source: {
        datasetVersionId,
        recipeMap: machineType,
        exporter: "gtnh-oracle",
        rawRecipeId: `cropsnh:${crop.id ?? crop.name ?? hashRecipe(crop)}`,
      },
      nei: {
        slots: [
          { side: "input", kind: "item", slotIndex: 0, x: 34, y: 35 },
          ...outputs.map((output, index) => ({
            side: "output",
            kind: "item",
            slotIndex: index,
            ...outputSlot(index),
          })),
        ],
        progressBars: [
          { x: 78, y: 35, width: 24, height: 17, direction: "right", texture: "arrow" },
        ],
      },
    });
  }
}

// Mirrors TileEntityCropSticks.getNutrientsPerCycle + getGrowthRate + doGrowth.
function cropsNhDurationTicks(crop, env) {
  const waterBonus = Math.floor((Math.min(100, env.water) + 9) / 10);
  const fertilizerBonus = Math.floor((Math.min(100, env.fertilizer) + 9) / 10);
  const score = 5 + waterBonus + fertilizerBonus + (env.sky ? 2 : 0) + env.biomeBonus;
  const supply = score * 5;
  const demand = crop.tier * 10;
  const base = 6 + env.growth;
  const rate =
    supply >= demand
      ? Math.trunc((base * (100 + supply - demand)) / 100)
      : Math.max(0, Math.trunc((base * (100 - (demand - supply) * 4)) / 100));
  const perCycle = Math.trunc(rate * crop.growthMultiplier);
  if (perCycle <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(crop.growthPoints / perCycle) * crop.growthCycleTicks;
}

/** A crop's heaviest drop, then by id: the face a crop with no seed item wears. */
function heaviestRawDrop(crop) {
  const drops = (crop.dropTable ?? []).map((entry) => ({ ...entry, resource: entry.resource, weight: Number(entry.weight) || 0 }));
  return orderCropDrops(drops)[0]?.resource;
}

function cropsNhSeedInput(crop) {
  const icon = resourceAmount(crop.seed ?? heaviestRawDrop(crop), {
    consumed: false,
    defaultAmount: 1,
  });
  const name = text(crop.name, crop.id ?? hashRecipe(crop));
  return removeUndefined({
    kind: "item",
    id: `factoryflow:cropsnh_seed:${slug(crop.id ?? name)}`,
    amount: 1,
    displayName: `${name} Seeds`,
    iconPath: icon?.iconPath,
    dominantColor: icon?.dominantColor,
    modId: icon?.modId ?? "cropsnh",
    tooltip: ["CropsNH crop seed", `Crop: ${name}`, crop.className].filter(Boolean),
    consumed: false,
    neiSlot: { x: 34, y: 35 },
  });
}

function roundAmount(value) {
  return Math.round(value * 1e6) / 1e6;
}

// Worldgen is not a machine, but a vein IS a source: something a player mines
// by hand (or with a miner) that a plan can otherwise never explain. Each vein,
// small ore, and underground fluid becomes an instant zero-EU source recipe in
// the bee/crop mould, with where-to-find-it (dimensions, rocket tier, height,
// chance) riding in metadata for the UI and future access planning.
function normalizeMining(domain) {
  const dimensionsByKey = new Map();
  for (const dim of domain?.dimensions ?? []) {
    const tier = rocketTierFromKey(dim.tier);
    const entry = removeUndefined({
      id: text(dim.id, undefined),
      name: text(dim.name, undefined) ?? text(dim.id, "Unknown"),
      abbr: text(dim.abbr, undefined),
      tier,
      tierLabel: tier === undefined ? text(dim.tier, undefined) : undefined,
    });
    // The export names a dimension three ways depending on which helper is
    // talking (internal id, trimmed name, abbreviation); key all of them.
    for (const key of [dim.id, dim.name, dim.fullName, dim.abbr]) {
      const normalized = text(key, undefined);
      if (normalized !== undefined && !dimensionsByKey.has(normalized)) {
        dimensionsByKey.set(normalized, entry);
      }
    }
  }
  normalizeOreVeins(domain, dimensionsByKey);
  normalizeSmallOres(domain, dimensionsByKey);
  normalizeUndergroundFluids(domain, dimensionsByKey);
}

function normalizeOreVeins(domain, dimensionsByKey) {
  const machineType = "Ore Vein";
  for (const vein of domain?.veins ?? []) {
    const outputs = [];
    const layers = [];
    for (const layer of vein.ores ?? []) {
      const output = resourceAmount(layer?.ore);
      if (!output) {
        continue;
      }
      layers.push(
        removeUndefined({
          role: text(layer.role, undefined),
          resourceId: output.id,
          material: text(layer.material?.name, undefined),
        }),
      );
      // A vein can carry one material in two layers; the roles stay in
      // metadata, the recipe lists the ore once.
      if (!outputs.some((existing) => existing.id === output.id)) {
        outputs.push(output);
      }
    }
    if (outputs.length === 0) {
      continue;
    }
    recipeMaps.add(machineType);
    setRecipeMapIcon(machineType, (vein.ores ?? [])[0]?.ore, { ordered: true });
    const name = veinDisplayName(vein);
    addRecipe({
      id: recipeId("ore-vein", text(vein.id, undefined) ?? hashRecipe(vein)),
      name: `${machineType}: ${name}`,
      kind: "ore_vein",
      category: "ore-vein",
      machineType,
      minimumTier: "NONE",
      durationTicks: 1,
      eut: 0,
      inputs: [],
      outputs,
      notes:
        "Mined from a GregTech ore vein. Exported by the GTNH calculation oracle from worldgen vein definitions.",
      source: {
        datasetVersionId,
        recipeMap: machineType,
        exporter: "gtnh-oracle",
        rawRecipeId: text(vein.id, undefined),
      },
      metadata: removeUndefined({
        veinId: text(vein.id, undefined),
        veinName: name,
        veinWeight: finiteNumber(vein.weight),
        veinDensity: finiteNumber(vein.density),
        veinSize: finiteNumber(vein.size),
        heightRange: text(vein.heightRange, undefined),
        dimensions: miningDimensionList(vein.dims, vein.dimAbbrs, dimensionsByKey, {
          heightRanges: vein.dimHeightRanges,
          chances: vein.dimChances,
        }),
        oreLayers: layers.length > 0 ? layers : undefined,
      }),
    });
  }
}

function normalizeSmallOres(domain, dimensionsByKey) {
  const machineType = "Small Ore";
  for (const smallOre of domain?.smallOres ?? []) {
    const outputs = [];
    for (const drop of smallOre.drops ?? []) {
      const output = resourceAmount(drop);
      if (output && !outputs.some((existing) => existing.id === output.id)) {
        outputs.push(output);
      }
    }
    if (outputs.length === 0) {
      continue;
    }
    recipeMaps.add(machineType);
    setRecipeMapIcon(machineType, (smallOre.drops ?? [])[0], { ordered: true });
    const name =
      text(smallOre.material?.name, undefined) ?? veinDisplayName({ id: smallOre.id });
    addRecipe({
      id: recipeId("small-ore", text(smallOre.id, undefined) ?? hashRecipe(smallOre)),
      name: `${machineType}: ${name}`,
      kind: "small_ore",
      category: "small-ore",
      machineType,
      minimumTier: "NONE",
      durationTicks: 1,
      eut: 0,
      inputs: [],
      outputs,
      notes:
        "Mined from scattered GregTech small ores. Exported by the GTNH calculation oracle from worldgen definitions.",
      source: {
        datasetVersionId,
        recipeMap: machineType,
        exporter: "gtnh-oracle",
        rawRecipeId: text(smallOre.id, undefined),
      },
      metadata: removeUndefined({
        smallOreId: text(smallOre.id, undefined),
        material: text(smallOre.material?.name, undefined),
        amountPerChunk: finiteNumber(smallOre.amountPerChunk),
        heightRange: text(smallOre.heightRange, undefined),
        dimensions: miningDimensionList(smallOre.dims, smallOre.enabledDims, dimensionsByKey),
      }),
    });
  }
}

function normalizeUndergroundFluids(domain, dimensionsByKey) {
  const machineType = "Underground Fluid";
  for (const entry of domain?.undergroundFluids ?? []) {
    // No registered fluid means nothing a plan could link to; skip rather than
    // shipping a bare id that renders as `fluid.*`.
    const output = resourceAmount(entry.fluid);
    if (!output) {
      continue;
    }
    const deposits = [];
    for (const deposit of entry.deposits ?? []) {
      const key = text(deposit?.dim, undefined);
      if (key === undefined) {
        continue;
      }
      const known = dimensionsByKey.get(key);
      deposits.push(
        removeUndefined({
          dimension: known?.name ?? key,
          abbr: known?.abbr,
          tier: known?.tier,
          tierLabel: known?.tierLabel,
          chance: finiteNumber(deposit.chance),
          minAmount: finiteNumber(deposit.minAmount),
          maxAmount: finiteNumber(deposit.maxAmount),
        }),
      );
    }
    recipeMaps.add(machineType);
    setRecipeMapIcon(machineType, entry.fluid, { ordered: true });
    addRecipe({
      id: recipeId("underground-fluid", text(entry.fluidId, undefined) ?? hashRecipe(entry)),
      name: `${machineType}: ${resourceLabel(output)}`,
      kind: "underground_fluid",
      category: "underground-fluid",
      machineType,
      minimumTier: "NONE",
      durationTicks: 1,
      eut: 0,
      inputs: [],
      outputs: [output],
      notes:
        "Pumped from per-chunk underground fluid deposits. Exported by the GTNH calculation oracle from GregTech worldgen definitions.",
      source: {
        datasetVersionId,
        recipeMap: machineType,
        exporter: "gtnh-oracle",
        rawRecipeId: text(entry.fluidId, undefined),
      },
      metadata: removeUndefined({
        fluidId: text(entry.fluidId, undefined),
        deposits: deposits.length > 0 ? deposits : undefined,
      }),
    });
  }
}

function miningDimensionList(names, fallbackNames, dimensionsByKey, extras = {}) {
  const primary = Array.isArray(names) && names.length > 0 ? names : fallbackNames;
  const list = [];
  for (const rawKey of primary ?? []) {
    const key = text(rawKey, undefined);
    if (key === undefined) {
      continue;
    }
    const known = dimensionsByKey.get(key);
    const chance = dimensionExtra(extras.chances, key, known);
    const heightRange = dimensionExtra(extras.heightRanges, key, known);
    list.push(
      removeUndefined({
        name: known?.name ?? key,
        abbr: known?.abbr,
        tier: known?.tier,
        tierLabel: known?.tierLabel,
        chance: finiteNumber(chance),
        heightRange: text(heightRange, undefined),
      }),
    );
  }
  return list.length > 0 ? list : undefined;
}

// Per-dimension maps in the export are keyed by whichever alias the GT helper
// that built them used; try every alias we know for the dimension.
function dimensionExtra(map, key, known) {
  if (!map || typeof map !== "object") {
    return undefined;
  }
  for (const candidate of [key, known?.abbr, known?.name, known?.id]) {
    if (candidate !== undefined && map[candidate] !== undefined) {
      return map[candidate];
    }
  }
  return undefined;
}

// Dimension tiers arrive as keys like "T3"; a plain number means the rocket
// tier needed to reach the dimension.
function rocketTierFromKey(value) {
  const match = /(\d+)\s*$/.exec(text(value, "") ?? "");
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function veinDisplayName(vein) {
  const name = text(vein.name, undefined);
  const id = text(vein.id, undefined);
  if (name !== undefined && name !== id) {
    return name;
  }
  const tail = (id ?? "vein").split(".").pop().replace(/[_-]+/g, " ");
  return tail.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function beeSpeciesInput(species) {
  const icon = resourceAmount(species.input, { consumed: false, defaultAmount: 1 });
  const uid = text(species.uid, species.name ?? hashRecipe(species));
  return removeUndefined({
    kind: "item",
    id: `factoryflow:bee_species:${slug(uid)}`,
    amount: 1,
    displayName: `${text(species.name, uid)} Bee`,
    iconPath: icon?.iconPath,
    dominantColor: icon?.dominantColor,
    modId: icon?.modId ?? "Forestry",
    consumed: false,
    neiSlot: { x: 48, y: 35 },
  });
}

function cropSeedInput(crop) {
  const icon = resourceAmount(crop.seed ?? crop.displayItem, { consumed: false, defaultAmount: 1 });
  const owner = text(crop.owner, "unknown");
  const name = text(crop.name, crop.id ?? hashRecipe(crop));
  return removeUndefined({
    kind: "item",
    id: `factoryflow:ic2_crop_seed:${slug(owner)}-${slug(crop.id ?? name)}`,
    amount: 1,
    displayName: `${name} Seed`,
    iconPath: icon?.iconPath,
    dominantColor: icon?.dominantColor,
    modId: icon?.modId ?? "IC2",
    tooltip: ["IC2 crop seed", `Owner: ${owner}`, `Crop: ${name}`, crop.className].filter(Boolean),
    consumed: false,
    neiSlot: { x: 34, y: 35 },
  });
}

function cropOutputs(rawDrops) {
  return (rawDrops ?? [])
    .map((entry, index) =>
      resourceAmount(entry.resource, {
        chance: normalizeChance(entry.chance),
        neiSlot: { x: 124 + index * 18, y: 35 },
      }),
    )
    .filter(Boolean);
}

function cropRuntimeVariants(cropVariants, fallbackOutputs, fallbackDurationTicks) {
  const variants = cropVariants
    .map((variant) => {
      const outputs = cropOutputs(variant.drops);
      if (outputs.length === 0) {
        return undefined;
      }
      return {
        id: text(variant.id, "base"),
        label: text(variant.label, variant.id ?? "Crop stats"),
        machineConfigTiers: {
          cropStats: text(variant.id, "23-31-0"),
        },
        durationTicks: positiveInt(variant.durationTicks, fallbackDurationTicks),
        eut: 0,
        outputs: runtimeResources(outputs),
      };
    })
    .filter(Boolean);

  if (variants.length > 0) {
    return variants;
  }
  return [
    {
      id: "base",
      label: "Base crop-card output",
      durationTicks: fallbackDurationTicks,
      eut: 0,
      outputs: runtimeResources(fallbackOutputs),
    },
  ];
}

function beeProductOutput(entry, specialty = false) {
  const output = resourceAmount(entry.resource, { chance: normalizeChance(entry.chance) });
  if (output && specialty) {
    output.byproduct = true;
  }
  return output;
}

/**
 * A map's icon. A map with its NEI catalyst (GregTech's, crafting, Thaumcraft, the machines the
 * normalizer names) sets it once. A map built from many records (bees, crops, veins, small ores,
 * underground fluids) has no catalyst in the export, so `ordered` keeps the candidate first in
 * NEI's order, then by id and stand-in rank, whatever order the records came in.
 */
function setRecipeMapIcon(machineType, rawIcon, { ordered = false } = {}) {
  const icon = resourceAmount(rawIcon);
  if (!icon) {
    return;
  }
  addResource(icon);
  const current = recipeMapIcons.get(machineType);
  if (!current || (ordered && compareByNeiPlace(icon, current) < 0)) {
    recipeMapIcons.set(machineType, icon);
  }
}

function neiPlaceOf(resource) {
  return neiPlace.get(`${resource.kind}:${resource.id}`) ?? Number.MAX_SAFE_INTEGER;
}

/** NEI's order, then id, then the stand-in rule (no NBT, smallest NBT). */
function compareByNeiPlace(left, right) {
  return (
    neiPlaceOf(left) - neiPlaceOf(right) ||
    compareById(left, right) ||
    compareStandIns(left, right)
  );
}

function craftingInputGrid(rawRecipe) {
  if (rawRecipe.type === "shaped") {
    return { width: 3, height: 3 };
  }
  const count = Math.max(1, (rawRecipe.inputs ?? []).length);
  if (count <= 1) return { width: 1, height: 1 };
  if (count <= 4) return { width: 2, height: 2 };
  return { width: 3, height: 2 };
}

function craftingInputNeiSlot(rawRecipe, slotIndex) {
  const index = Math.max(0, Number(slotIndex) || 0);
  if (rawRecipe.type === "shaped") {
    const width = Math.max(1, positiveInt(rawRecipe.width, 3));
    return {
      x: 25 + (index % width) * 18,
      y: 8 + Math.floor(index / width) * 18,
    };
  }
  return compactCraftingInputPositions((rawRecipe.inputs ?? []).length)[index];
}

function craftingNeiSlots(rawRecipe, inputCount) {
  const inputSlots =
    rawRecipe.type === "shaped"
      ? Array.from({ length: 9 }, (_, index) => ({
          side: "input",
          kind: "item",
          slotIndex: index,
          x: 25 + (index % 3) * 18,
          y: 8 + Math.floor(index / 3) * 18,
        }))
      : compactCraftingInputPositions(inputCount).map((slot, index) => ({
          side: "input",
          kind: "item",
          slotIndex: index,
          x: slot.x,
          y: slot.y,
        }));
  return [...inputSlots, { side: "output", kind: "item", slotIndex: 0, x: 124, y: 26 }];
}

function compactCraftingInputPositions(count) {
  switch (Math.max(0, count)) {
    case 0:
      return [];
    case 1:
      return [{ x: 61, y: 26 }];
    case 2:
      return [
        { x: 52, y: 26 },
        { x: 70, y: 26 },
      ];
    case 3:
      return [
        { x: 43, y: 26 },
        { x: 61, y: 26 },
        { x: 79, y: 26 },
      ];
    case 4:
      return [
        { x: 52, y: 17 },
        { x: 70, y: 17 },
        { x: 52, y: 35 },
        { x: 70, y: 35 },
      ];
    default:
      return Array.from({ length: count }, (_, index) => ({
        x: 43 + (index % 3) * 18,
        y: 17 + Math.floor(index / 3) * 18,
      }));
  }
}

function addRecipe(recipe) {
  if (recipe.id !== undefined) {
    // The same identity exported twice folds only when both copies say the
    // same thing; two different bodies under one id would keep whichever came
    // first, so the export is refused (identityExportGaps).
    const body = sha1Hex(JSON.stringify(recipe));
    const first = identityBodies.get(recipe.id);
    if (first !== undefined) {
      if (first !== body) {
        identityConflicts.add(recipe.id);
      }
      return;
    }
    identityBodies.set(recipe.id, body);
  }
  const signature = recipeSignature(recipe);
  if (recipeSignatures.has(signature)) {
    return;
  }
  recipeSignatures.add(signature);
  for (const resource of [
    ...recipe.inputs,
    ...recipe.outputs,
    ...machineConfigResources(recipe.machineConfigControls),
    ...machineHandlerConfigResources(recipe.machineHandlers),
  ]) {
    addResource(resource);
  }
  recipes.push({
    ...recipe,
    inputs: recipe.inputs.map(compactRecipeResource),
    outputs: recipe.outputs.map(compactRecipeResource),
  });
}

// Two different things travel under `alternatives`, and only one of them may
// ride along on every recipe that mentions the item.
//
// Ore dictionary membership belongs to the ITEM. It is identical everywhere
// the item appears, so it is written once into the shared resource catalog and
// stripped from the recipe copies; inlining `logWood`'s fifty members into
// every recipe that burns a log would bloat the dataset for no new fact.
//
// What a recipe SLOT accepts belongs to the RECIPE. The Circuit Assembler will
// take tin or lead in place of soldering alloy, but that says nothing about
// solder in any other machine, so this must stay on the input and must never
// reach the catalog.
function compactRecipeResource(resource) {
  const compact = { ...resource };
  delete compact.slotChoice;
  if (!resource.slotChoice) {
    delete compact.alternatives;
  }
  return compact;
}

function resourceAmount(rawResource, options = {}) {
  if (!rawResource || typeof rawResource !== "object") {
    return undefined;
  }

  if (rawResource.kind === "oreDictionary") {
    return oreDictionaryResource(rawResource);
  }
  if (rawResource.kind === "choice") {
    return choiceResource(rawResource);
  }
  if (rawResource.kind === "text") {
    return undefined;
  }
  if (!["item", "fluid", "aspect"].includes(rawResource.kind)) {
    return undefined;
  }

  const amount = positiveNumber(rawResource.amount, options.defaultAmount ?? 1);
  const id = canonicalResourceId(rawResource.kind, text(rawResource.id, ""));
  if (!id || !(amount > 0)) {
    return undefined;
  }

  const slotChoices = slotAlternatives(rawResource, id, amount);
  const iconPath = renderedIconPath(rawResource.icon) ?? text(rawResource.iconPath, undefined);
  const tooltip = [
    ...(normalizeStringArray(rawResource.tooltip) ?? []),
    rawResource.nbt ? `NBT: ${rawResource.nbt}` : undefined,
  ].filter(Boolean);
  const resource = removeUndefined({
    kind: rawResource.kind,
    id,
    amount,
    displayName: text(rawResource.displayName, id),
    iconPath,
    dominantColor:
      renderedIconColor(rawResource.icon) ?? text(rawResource.dominantColor, undefined),
    modId: rawResource.modId,
    tooltip: tooltip.length > 0 ? tooltip : undefined,
    consumed: options.consumed === false || rawResource.consumed === false ? false : undefined,
    chance: normalizeChance(options.chance ?? rawResource.chance),
    neiSlot: options.neiSlot,
    // The other things this exact slot accepts, straight from the recipe. The
    // Circuit Assembler slot that wants 72 L of soldering alloy will equally
    // take 144 L of tin or 288 L of lead, and only the recipe knows that.
    alternatives: slotChoices,
    // Marks the line above as slot data rather than ore dictionary membership,
    // so `compactRecipeResource` keeps it and the shared catalog does not take
    // it. Stripped before the recipe is written; it never ships.
    slotChoice: slotChoices ? true : undefined,
  });
  return resource;
}

function slotAlternatives(rawResource, selfId, selfAmount) {
  if (!Array.isArray(rawResource.alternatives) || rawResource.alternatives.length === 0) {
    return undefined;
  }

  const alternatives = [];
  for (const entry of rawResource.alternatives) {
    const resolved = resourceAmount(entry);
    if (!resolved) {
      continue;
    }
    if (alternatives.some((existing) => existing.id === resolved.id)) {
      continue;
    }
    // `amount` on an alternative is a RATIO, not a stack size: the field means
    // target units per source unit everywhere else it is used. Substitutes are
    // rarely one for one -- a recipe taking 72 L of soldering alloy wants 144 L
    // of tin or 288 L of lead -- so the real amounts are divided out here and
    // multiplied back when a slot is actually switched.
    alternatives.push({
      ...resolved,
      amount: selfAmount > 0 ? resolved.amount / selfAmount : 1,
    });
  }

  // A slot that only ever offered itself is not a choice.
  if (alternatives.length < 2 && !alternatives.some((entry) => entry.id !== selfId)) {
    return undefined;
  }
  return alternatives;
}

function oreDictionaryResource(rawResource) {
  const names = (rawResource.names ?? []).map((entry) => text(entry, "")).filter(Boolean);
  const alternatives = orderOreMembers(
    [
      ...(rawResource.alternatives ?? []).map((entry) => resourceAmount(entry)).filter(Boolean),
      ...names.flatMap((name) => oreDictionaryAlternativesByName.get(name) ?? []),
    ],
    { target: oreUnificationTargets[names[0]], neiPlace },
  );
  if (names.length === 0 && alternatives.length === 0) {
    return undefined;
  }

  const primaryName = names[0] ?? `choice-${hashRecipe(alternatives.map((entry) => entry.id))}`;
  const id = `oredict:${primaryName}`;
  for (const name of names) {
    oreDictionary[name] = [
      ...new Set([...(oreDictionary[name] ?? []), ...alternatives.map((entry) => entry.id)]),
    ].sort();
  }
  return {
    kind: "item",
    id,
    amount: 1,
    displayName: names.length > 0 ? `Ore Dictionary: ${names.join(", ")}` : "Ore Dictionary Choice",
    alternatives: alternatives.map(resourceAlternative),
    tooltip: [
      names.length > 0 ? `Ore dictionary: ${names.join(", ")}` : undefined,
      alternatives.length > 0
        ? `Accepts: ${alternatives
            .slice(0, 12)
            .map(resourceLabel)
            .join(", ")}${alternatives.length > 12 ? `, +${alternatives.length - 12} more` : ""}`
        : undefined,
    ].filter(Boolean),
    oreDictionary: names.length > 0 ? names : undefined,
  };
}

function choiceResource(rawResource) {
  const alternatives = (rawResource.alternatives ?? [])
    .map((entry) => resourceAmount(entry))
    .filter(Boolean);
  if (alternatives.length === 0) {
    return undefined;
  }

  const id = text(rawResource.id, `choice:${hashRecipe(alternatives.map((entry) => entry.id))}`);
  return {
    kind: "item",
    id,
    amount: positiveNumber(rawResource.amount, 1),
    displayName: text(rawResource.displayName, "Item Choice"),
    alternatives: alternatives.map(resourceAlternative),
    tooltip: [
      `Accepts: ${alternatives
        .slice(0, 12)
        .map(resourceLabel)
        .join(", ")}${alternatives.length > 12 ? `, +${alternatives.length - 12} more` : ""}`,
    ],
  };
}

/**
 * The catalog's stand-in for an id is chosen by rule, never by which stack the export met first:
 * the stack with no NBT, else the smallest NBT (compareStandIns), and NEI's own first listed stack
 * over both where NEI lists the item (applyNeiStandIns). An icon the stand-in lacks comes from the
 * best-ranked stack that has one.
 */
function addResource(resource) {
  if (!resource?.kind || !resource?.id) {
    return;
  }
  const key = `${resource.kind}:${resource.id}`;
  const current = standIns.get(key);
  if (!current || compareStandIns(resource, current) < 0) {
    standIns.set(key, resource);
    resources.set(key, resourceCatalogEntry(resource));
  }
  const iconed = standInIcons.get(key);
  if (resource.iconPath && (!iconed || compareStandIns(resource, iconed) < 0)) {
    standInIcons.set(key, resource);
  }
}

/** Fills missing icons from the best iconed stack, then lays NEI's first listed stack over each item it lists. */
function applyNeiStandIns() {
  for (const [key, entry] of resources) {
    const iconed = standInIcons.get(key);
    if (!entry.iconPath && iconed) {
      entry.iconPath = iconed.iconPath;
      entry.dominantColor = iconed.dominantColor;
    }
    const first = neiFirstStacks.get(key);
    const nei = first ? resourceAmount(first) : undefined;
    if (!nei) {
      continue;
    }
    entry.displayName = nei.displayName ?? entry.displayName;
    if (nei.modId) entry.modId = nei.modId;
    if (nei.tooltip) entry.tooltip = nei.tooltip;
    else delete entry.tooltip;
    if (nei.iconPath) {
      entry.iconPath = nei.iconPath;
      entry.dominantColor = nei.dominantColor;
    }
  }
}

function resourceCatalogEntry(resource) {
  return removeUndefined({
    id: resource.id,
    kind: resource.kind,
    displayName: resource.displayName ?? resource.id,
    iconPath: resource.iconPath,
    dominantColor: resource.dominantColor,
    modId: resource.modId,
    tooltip: resource.tooltip,
    oreDictionary: resource.oreDictionary,
    // The catalog is keyed by id and shared by every recipe, so only
    // item-level membership may live here. A substitute one recipe's slot
    // happens to allow must not follow the item into every other recipe.
    alternatives: resource.slotChoice ? undefined : resource.alternatives,
  });
}

function resourceAlternative(resource) {
  return removeUndefined({
    kind: resource.kind,
    id: resource.id,
    displayName: resource.displayName,
    iconPath: resource.iconPath,
    dominantColor: resource.dominantColor,
    modId: resource.modId,
    tooltip: resource.tooltip,
    amount: resource.amount,
  });
}

function normalizeRuntimeCalculation(rawRuntime, recipeMap, fallbackOutputs) {
  if (!rawRuntime || typeof rawRuntime !== "object") {
    return undefined;
  }
  const rawVariants = rawRuntime.compactVariants
    ? rawRuntime.compactVariants.map((variant) => compactRuntimeVariant(variant))
    : (rawRuntime.variants ?? []);
  const variants = rawVariants
    .map((variant, index) => normalizeRuntimeVariant(variant, index, fallbackOutputs))
    .filter(Boolean);
  return {
    sourceKind: text(rawRuntime.sourceKind, "gregtech-overclock-calculator"),
    sourceClass: rawRuntime.sourceClass,
    sourceVersion: rawRuntime.sourceVersion,
    recipeMap: text(rawRuntime.recipeMap, recipeMap),
    status: variants.length > 0 ? text(rawRuntime.status, "computed") : "missing",
    oracleEligible: rawRuntime.oracleEligible !== false,
    strict: rawRuntime.strict !== false,
    generatedAt: rawRuntime.generatedAt ?? generatedAt,
    variants,
    warnings: normalizeStringArray(rawRuntime.warnings),
  };
}

function compactRuntimeVariant(value) {
  if (!Array.isArray(value)) {
    return value;
  }
  const tierIndex = Number(value[0]);
  const tier = GT_VOLTAGE_NAMES[tierIndex] ?? `tier-${tierIndex}`;
  const profile = text(value[3], "");
  const configKey = text(value[4], "");
  const coil = configKey ? heatingCoilTiers.find((entry) => entry.key === configKey) : undefined;
  const variant = {
    id: `tier-${tier.toLowerCase()}`,
    label: tier,
    overclockTier: tier,
    durationTicks: value[1],
    eut: value[2],
    parallel: 1,
  };
  if (!profile) {
    return variant;
  }

  if (profile === "ebf-heat") {
    return {
      ...variant,
      id: `tier-${tier.toLowerCase()}-coil-${configKey}`,
      label: `${tier} / ${coil?.label ?? configKey}`,
      coilTier: configKey,
      notes: "GTNH EBF heat overclock and heat discount profile.",
    };
  }
  if (profile === "pyrolyse-coil") {
    return {
      ...variant,
      id: `tier-${tier.toLowerCase()}-coil-${configKey}`,
      label: `${tier} / ${coil?.label ?? configKey}`,
      coilTier: configKey,
      notes: "GTNH Pyrolyse Oven coil speed profile.",
    };
  }
  if (profile === "oil-cracker-coil") {
    return {
      ...variant,
      id: `tier-${tier.toLowerCase()}-coil-${configKey}`,
      label: `${tier} / ${coil?.label ?? configKey}`,
      coilTier: configKey,
      notes: "GTNH Oil Cracker coil EU discount profile.",
    };
  }
  if (profile === "perfect-oc") {
    return {
      ...variant,
      id: `tier-${tier.toLowerCase()}-perfect-oc`,
      label: `${tier} Perfect OC`,
      notes: "GTNH perfect overclock profile.",
    };
  }
  return {
    ...variant,
    id: `tier-${tier.toLowerCase()}-${slug(profile)}${configKey ? `-${slug(configKey)}` : ""}`,
    label: `${tier} ${profile}${configKey ? ` ${configKey}` : ""}`,
    notes: `GTNH runtime profile: ${profile}${configKey ? `/${configKey}` : ""}.`,
  };
}

function normalizeRuntimeVariant(variant, index, fallbackOutputs) {
  const durationTicks = positiveInt(variant?.durationTicks, 0);
  const eut = Number(variant?.eut);
  if (!(durationTicks > 0) || !Number.isFinite(eut) || eut < 0) {
    return undefined;
  }
  const outputs = (variant.outputs ?? []).map((entry) => resourceAmount(entry)).filter(Boolean);
  return removeUndefined({
    id: text(variant.id, `variant-${index}`),
    label: variant.label,
    machineHandlerId: variant.machineHandlerId,
    overclockTier: variant.overclockTier,
    coilTier: variant.coilTier,
    machineConfigTiers: variant.machineConfigTiers,
    durationTicks,
    eut,
    parallel: positiveNumber(variant.parallel, undefined),
    inputs: (variant.inputs ?? [])
      .map((entry) => runtimeResource(resourceAmount(entry)))
      .filter(Boolean),
    outputs: runtimeResources(outputs.length > 0 ? outputs : fallbackOutputs),
    notes: variant.notes,
  });
}

function runtimeResources(values) {
  return (values ?? []).map(runtimeResource).filter(Boolean);
}

function runtimeResource(resource) {
  if (!resource) {
    return undefined;
  }
  return removeUndefined({
    kind: resource.kind,
    id: resource.id,
    amount: Number(resource.amount),
    chance: normalizeChance(resource.chance),
  });
}

async function writeOracleReport(dataset) {
  const runtimeRecipes = dataset.recipes.filter(
    (recipe) => recipe.runtimeCalculation?.oracleEligible,
  );
  const computedRuntimeRecipes = runtimeRecipes.filter(
    (recipe) =>
      recipe.runtimeCalculation?.status === "computed" &&
      recipe.runtimeCalculation?.variants?.length > 0,
  );
  const runtimeFailures = runtimeRecipes
    .filter((recipe) => !computedRuntimeRecipes.includes(recipe))
    .map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      machineType: recipe.machineType,
      status: recipe.runtimeCalculation?.status ?? "missing",
    }));
  const gridGaps = arcaneGridGaps(raw);
  const exportGaps = [
    ...spargeExportGaps(raw),
    ...wearExportGaps(raw),
    ...identityExportGaps(),
    ...(gridGaps.length > ARCANE_UNRESOLVED_GRID_CEILING
      ? [
          {
            status: "arcane-grid-cells-unresolved",
            recipeCount: gridGaps.length,
            message: `Export gap: ${gridGaps.length} arcane recipe(s) have grid cells the oracle could not read (at most ${ARCANE_UNRESOLVED_GRID_CEILING} allowed), so they would ship without those ingredients.`,
          },
        ]
      : []),
  ];
  const failures = [...runtimeFailures, ...exportGaps];
  const adapterWarnings = (raw.adapters ?? [])
    .filter((adapter) => adapter.status === "partial" || adapter.status === "missing")
    .map((adapter) => ({
      id: adapter.id,
      status: adapter.status,
      detected: adapter.detected,
      warnings: adapter.warnings,
    }));
  const report = {
    schemaVersion: 1,
    datasetVersionId,
    generatedAt,
    strict: oracleStrict,
    adapterCount: raw.adapters?.length ?? 0,
    adapters: raw.adapters ?? [],
    recipeCount: dataset.recipes.length,
    runtimeEligibleRecipeCount: runtimeRecipes.length,
    runtimeComputedRecipeCount: computedRuntimeRecipes.length,
    runtimeMissingRecipeCount: runtimeFailures.length,
    failures,
    adapterWarnings,
    // Arcane recipes missing a grid cell, each with the cells' class and text.
    unresolvedArcaneGrids: gridGaps,
    notes:
      "Strict mode fails only for recipes that are exported as oracle-eligible but lack computed runtime variants. Adapter warnings are preserved for coverage tracking.",
  };
  await fs.mkdir(path.join(outDir, "oracle"), { recursive: true });
  await fs.writeFile(
    path.join(outDir, "oracle", "oracle-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (exportGaps.length > 0) {
    throw new Error(
      exportGaps.map((gap) => gap.message).join("\n") + "\nSee oracle/oracle-report.json.",
    );
  }
  if (oracleStrict && runtimeFailures.length > 0) {
    throw new Error(
      `Oracle strict mode failed: ${runtimeFailures.length} oracle-eligible recipe(s) have no computed runtime calculation. See oracle/oracle-report.json.`,
    );
  }
}

/** Game identities exported more than once with different contents (addRecipe). */
function identityExportGaps() {
  if (identityConflicts.size === 0) {
    return [];
  }
  const ids = [...identityConflicts].sort();
  const shown = ids.slice(0, 20).join(", ");
  return [
    {
      status: "identity-exported-twice",
      recipeCount: ids.length,
      recipeIds: ids,
      message: `Export gap: ${ids.length} game identit${ids.length === 1 ? "y is" : "ies are"} exported more than once with different contents (${shown}${ids.length > 20 ? ", ..." : ""}), so only the first copy would ship.`,
    },
  ];
}

/**
 * Arcane recipes the oracle exported with grid cells it could not read
 * (`unresolvedGridInputs`): such a recipe ships short of an ingredient. A few
 * are listed in the oracle report; more than ARCANE_UNRESOLVED_GRID_CEILING
 * means the grid reader broke, and the export is refused.
 */
function arcaneGridGaps(rawExport) {
  return (rawExport.domains ?? [])
    .filter((domain) => domain?.id === "thaumcraft")
    .flatMap((domain) => domain.recipes ?? [])
    .filter((recipe) => Number(recipe?.unresolvedGridInputs) > 0)
    .map((recipe) => ({
      output: recipe.output?.id,
      displayName: recipe.output?.displayName,
      research: recipe.research,
      className: recipe.className,
      unresolvedGridInputs: recipe.unresolvedGridInputs,
      cells: recipe.unresolvedGridCells ?? [],
    }));
}

/**
 * Sparging maps whose recipes came without their rolled outputs. The oracle
 * exports `spargeFluidOutputs` only for the maps it recognises by name, so a
 * renamed map loses the returned gas and every byproduct without an error;
 * such an export is refused rather than published with salt-only cards.
 */
function spargeExportGaps(rawExport) {
  return (rawExport.domains ?? [])
    .flatMap((domain) => domain?.recipeMaps ?? [])
    .filter(
      (recipeMap) =>
        gameRecipeMapId(recipeMap.id) === "gt.recipe.lftr.sparging" &&
        (recipeMap.recipes?.length ?? 0) > 0 &&
        !recipeMap.recipes.some((recipe) => Array.isArray(recipe?.spargeFluidOutputs)),
    )
    .map((recipeMap) => ({
      recipeMapId: recipeMap.id,
      status: "sparge-byproducts-missing",
      recipeCount: recipeMap.recipes.length,
      message: `Export gap: ${recipeMap.recipes.length} recipe(s) in ${recipeMap.id} carry no spargeFluidOutputs, so their returned gas and byproducts would be lost.`,
    }));
}

/**
 * Wear maps whose recipes came without their wear data. A renamed map would lose every
 * `wearingInputs` without an error, and a failed read leaves `wearError` on the recipe;
 * either refuses the export, as a sparging map without its rolled outputs does.
 */
function wearExportGaps(rawExport) {
  // The GT++ maps whose machines wear an input down instead of eating it: Chemical Plant
  // catalysts and IsaMill milling balls. The oracle reads which inputs wear, and how long
  // they last, only for maps it recognises by name (`isGtppMap`); on 2.9 and 2.8.1 every
  // milling recipe and each catalyst recipe carries them. (Declared here: the module's
  // top-level work runs before constants declared below it.)
  const WEAR_RECIPE_MAPS = ["gt.recipe.fluidchemicaleactor", "gt.recipe.oremill"];
  return (rawExport.domains ?? [])
    .flatMap((domain) => domain?.recipeMaps ?? [])
    .filter((recipeMap) => WEAR_RECIPE_MAPS.includes(gameRecipeMapId(recipeMap.id)))
    .flatMap((recipeMap) => {
      const recipes = recipeMap.recipes ?? [];
      const failed = recipes.filter((recipe) => recipe?.wearError);
      if (failed.length > 0) {
        return [{
          recipeMapId: recipeMap.id,
          status: "wear-data-failed",
          recipeCount: failed.length,
          message: `Export gap: ${failed.length} recipe(s) in ${recipeMap.id} failed to read which inputs wear (${failed[0].wearError}).`,
        }];
      }
      if (recipes.length > 0 && !recipes.some((recipe) => Array.isArray(recipe?.wearingInputs))) {
        return [{
          recipeMapId: recipeMap.id,
          status: "wear-data-missing",
          recipeCount: recipes.length,
          message: `Export gap: ${recipes.length} recipe(s) in ${recipeMap.id} and none carries wearingInputs, so the inputs its machine wears down would be lost.`,
        }];
      }
      return [];
    });
}

async function stageRenderedIcons(sourceDir, datasetOutDir) {
  const icons = new Map();
  if (!sourceDir || !existsSync(sourceDir)) {
    return icons;
  }
  const targetDir = path.join(datasetOutDir, "textures", "rendered");
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  const files = (await fs.readdir(sourceDir)).filter((file) => file.toLowerCase().endsWith(".png"));
  // Keyed by the export's file name, which the raw records cite; the path is the staged,
  // content-addressed name (stage-rendered-icons.mjs).
  const { colors, names } = await stageIconsOnWorkers(files, sourceDir, targetDir);
  files.forEach((file, index) => {
    icons.set(file, {
      iconPath: `/datasets/gtnh/${datasetVersionId}/textures/rendered/${names[index]}`,
      dominantColor: colors[index],
    });
  });
  return icons;
}

function renderedIconPath(fileName) {
  return renderedIcons.get(path.basename(String(fileName ?? "")))?.iconPath;
}

function renderedIconColor(fileName) {
  return renderedIcons.get(path.basename(String(fileName ?? "")))?.dominantColor;
}

function normalizeOreDictionary(entries) {
  const normalized = {};
  for (const [name, alternatives] of Object.entries(entries ?? {})) {
    const normalizedAlternatives = orderOreMembers(
      (alternatives ?? []).map((entry) => resourceAmount(entry)).filter(Boolean),
      { target: oreUnificationTargets[name], neiPlace },
    );
    oreDictionaryAlternativesByName.set(name, normalizedAlternatives);
    normalized[name] = normalizedAlternatives.map((entry) => entry.id).sort();
  }
  return normalized;
}

function findDomain(id) {
  return (raw.domains ?? []).find((domain) => domain.id === id);
}

/**
 * What a recipe IS, for its id: its map, slots, amounts, chances, ticks, EU
 * and special value. Neither the dataset version nor anything the exporter
 * numbers goes in, so an unchanged recipe keeps its id on every rebuild and
 * in every pack version that has it, and plans keep their cards.
 *
 * The exporter's own ids counted registrations (crafting, furnace,
 * thaumcraft) or hashed `GTRecipe.toString()`, a JVM identity hash: every
 * export renamed recipes and every saved plan lost its ids. Slots are sorted;
 * a pattern's layout is part of the recipe, so a slot carries its grid cell
 * (`gridSlot`, or its neiSlot when the recipe is `positional`).
 */
function recipeContentKey(map, recipe) {
  const slotKey = (entry) =>
    [
      entry.kind,
      entry.id,
      entry.amount,
      entry.consumed === false ? "nc" : "",
      entry.chance ?? "",
      entry.gridSlot ?? (recipe.positional && entry.neiSlot ? `${entry.neiSlot.x},${entry.neiSlot.y}` : ""),
    ].join("|");
  return JSON.stringify({
    map,
    inputs: recipe.inputs.map(slotKey).sort(),
    outputs: recipe.outputs.map(slotKey).sort(),
    durationTicks: recipe.durationTicks ?? null,
    eut: recipe.eut ?? null,
    specialValue: recipe.specialValue ?? null,
  });
}

function gameRecipeMapId(recipeMapId) {
  return RECIPE_MAP_ID_RENAMES.get(recipeMapId) ?? String(recipeMapId).replace(/^gtpp\.recipe\./, "gt.recipe.");
}

function canonicalRecipeBody(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalRecipeBody);
  }
  if (value && typeof value === "object") {
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
      if (!VOLATILE_RECIPE_FIELDS.has(key)) {
        canonical[key] = canonicalRecipeBody(value[key]);
      }
    }
    return canonical;
  }
  return value;
}

/**
 * Gives every recipe that carries a `contentId` its id: the hash of its
 * content key. Recipes with the same key (GT registers such pairs, which
 * differ only outside the key) take `-2`, `-3`... in the order of a hash of
 * their whole body, not in export order, which the game does not keep.
 * GregTech recipes get the same suffix as their rawRecipeId, after the map.
 */
function assignContentRecipeIds() {
  const groups = new Map();
  for (const recipe of recipes) {
    if (!recipe.contentId) {
      continue;
    }
    const hash = sha1Hex(recipe.contentId.key).slice(0, 16);
    const groupKey = `${recipe.contentId.idParts.join(":")}:${hash}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { hash, members: [] });
    }
    groups.get(groupKey).members.push(recipe);
  }
  for (const { hash, members } of groups.values()) {
    if (members.length > 1) {
      const bodyHash = new Map(
        members.map((recipe) => {
          const { id, contentId, ...body } = recipe;
          return [recipe, sha1Hex(JSON.stringify(canonicalRecipeBody(body)))];
        }),
      );
      members.sort((left, right) => {
        const a = bodyHash.get(left);
        const b = bodyHash.get(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }
    members.forEach((recipe, index) => {
      const suffix = index === 0 ? hash : `${hash}-${index + 1}`;
      recipe.id = recipeId(...recipe.contentId.idParts, suffix);
      if (recipe.contentId.rawPrefix) {
        recipe.source.rawRecipeId = `${recipe.contentId.rawPrefix}:${suffix}`;
      }
      delete recipe.contentId;
    });
  }
}

function sha1Hex(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

/** A recipe id: `oracle:` and its parts, never the dataset version (see recipeContentKey). */
function recipeId(...parts) {
  return `oracle:${parts
    .map((part) => slug(part))
    .filter(Boolean)
    .join(":")}`;
}

// A recipe named by a game identity (a vein, small ore, bee, crop, mob or
// underground fluid) is that identity: two veins with the same ores in other
// dimensions are two veins, and only the same identity exported twice folds.
// Content-keyed recipes reach here without an id and fold by what they do.
function recipeSignature(recipe) {
  if (recipe.id !== undefined) {
    return JSON.stringify({ identity: recipe.id });
  }
  return JSON.stringify({
    machineType: recipe.machineType,
    inputs: recipe.inputs.map((entry) => [entry.kind, entry.id, entry.amount, entry.consumed]),
    outputs: recipe.outputs.map((entry) => [entry.kind, entry.id, entry.amount, entry.chance]),
  });
}

function hashRecipe(value) {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/**
 * The number a machine's circuit slot has to be dialled to.
 *
 * Only the GregTech programmed circuit counts. Matching anything merely named
 * "circuit" claimed ordinary ingredients and read their item id as a setting,
 * so a recipe taking a Circuit Board was labelled "configuration 32100" and a
 * Wrap of Circuit Board "configuration 32760". Neither is a circuit setting;
 * both are just where the item sits in its mod's item list.
 */
function detectProgrammedCircuit(inputs) {
  // Declared here rather than at module scope: this file does its work as it
  // is read, well above where a constant down here would be initialised.
  const programmedCircuitItem = "gregtech:gt.integrated_circuit";
  const circuit = inputs.find(
    (input) => input.kind === "item" && baseItemId(input.id) === programmedCircuitItem,
  );
  if (!circuit) {
    return undefined;
  }

  const configuration = Number(/@(\d+)$/.exec(circuit.id)?.[1] ?? Number.NaN);
  // 32767 is "any damage", which is a wildcard rather than a setting.
  return Number.isFinite(configuration) && configuration !== 32767
    ? String(configuration)
    : undefined;
}

function baseItemId(id) {
  return String(id ?? "").replace(/@\d+$/, "");
}

function thaumcraftMachineType(type) {
  if (type === "infusion") return "Thaumcraft Infusion";
  if (type === "crucible") return "Thaumcraft Crucible";
  if (type === "arcane") return "Thaumcraft Arcane Crafting";
  if (type === "essentiaSmelting") return "Thaumcraft Essentia Smelting";
  return "Thaumcraft";
}

function thaumcraftRecipeMapIcon(type) {
  if (type === "infusion") {
    return {
      kind: "item",
      id: "Thaumcraft:blockStoneDevice@2",
      displayName: "Infusion Matrix",
      modId: "Thaumcraft",
    };
  }
  if (type === "crucible") {
    return {
      kind: "item",
      id: "Thaumcraft:blockMetalDevice@0",
      displayName: "Crucible",
      modId: "Thaumcraft",
    };
  }
  if (type === "arcane") {
    return {
      kind: "item",
      id: "Thaumcraft:blockTable@0",
      displayName: "Arcane Worktable",
      modId: "Thaumcraft",
    };
  }
  if (type === "essentiaSmelting") {
    return {
      kind: "item",
      id: "Thaumcraft:blockStoneDevice@0",
      displayName: "Alchemical Furnace",
      modId: "Thaumcraft",
    };
  }
  return undefined;
}

function thaumcraftDuration(type) {
  if (type === "infusion") return 200;
  if (type === "crucible") return 20;
  if (type === "essentiaSmelting") return 10;
  return 1;
}

function voltageTierForEu(eut) {
  const value = Math.abs(Number(eut) || 0);
  const tiers = [
    ["ULV", 8],
    ["LV", 32],
    ["MV", 128],
    ["HV", 512],
    ["EV", 2048],
    ["IV", 8192],
    ["LuV", 32768],
    ["ZPM", 131072],
    ["UV", 524288],
    ["UHV", 2097152],
    ["UEV", 8388608],
    ["UIV", 33554432],
    ["UXV", 134217728],
    ["OpV", 536870912],
  ];
  return tiers.find(([, max]) => value <= max)?.[0] ?? "MAX";
}

function resourceLabel(resource) {
  return resource?.displayName ?? resource?.id ?? "unknown";
}

function compareById(left, right) {
  return `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`);
}

function normalizeChance(value) {
  const chance = Number(value);
  if (!Number.isFinite(chance) || chance < 0) {
    return undefined;
  }
  return Math.max(0, Math.min(1, chance));
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => text(entry, "")).filter(Boolean) : undefined;
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function slug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function text(value, defaultText) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : defaultText;
}

function canonicalResourceId(kind, id) {
  if (kind !== "item") {
    return id;
  }
  const separator = id.lastIndexOf("@");
  const baseId = separator >= 0 ? id.slice(0, separator) : id;
  const suffix = separator >= 0 ? id.slice(separator) : "";
  const namespaceSeparator = baseId.indexOf(":");
  if (namespaceSeparator < 0) {
    return `${baseId.toLowerCase()}${suffix}`;
  }
  return `${baseId.slice(0, namespaceSeparator).toLowerCase()}:${baseId
    .slice(namespaceSeparator + 1)
    .toLowerCase()}${suffix}`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function envFlag(name, defaultValue) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }
  return /^(1|true|yes|on)$/i.test(rawValue);
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
