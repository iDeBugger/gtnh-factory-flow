import { PROJECT_SCHEMA_VERSION, type FactoryProject, type Recipe } from "../types";

/**
 * A GTNH 2.8.1 Phenol line for the list-order tests: Phenol from Benzene, Chlorine and Water; the Hydrochloric Acid it
 * makes goes to a Vinyl Chloride reactor that takes Ethylene and Oxygen and gives the Water back. Benzene, Ethylene and
 * Oxygen come in at the same rate from two cards, so their solved rates differ only in the last bits and that noise
 * changes with the target. Recipes as the 2.8.1 export has them (`a2cac8d24af199dd`, `9f4ac3a11094fd85`).
 */

const circuit = (n: number) => ({
  kind: "item" as const,
  id: `gregtech:gt.integrated_circuit@${n}`,
  amount: 1,
  displayName: "Programmed Circuit",
  consumed: false,
});
const fluid = (id: string, amount: number, displayName: string) => ({
  kind: "fluid" as const,
  id,
  amount,
  displayName,
});

export const PHENOL_RECIPE: Recipe = {
  id: "oracle:gregtech:gt-recipe-largechemicalreactor:a2cac8d24af199dd",
  name: "Large Chemical Reactor: Phenol",
  machineType: "Large Chemical Reactor",
  minimumTier: "LV",
  durationTicks: 560,
  eut: 30,
  inputs: [
    circuit(24),
    fluid("benzene", 1000, "Benzene"),
    fluid("chlorine", 2000, "Chlorine"),
    fluid("water", 1000, "Water"),
  ],
  outputs: [
    fluid("phenol", 1000, "Phenol"),
    fluid("hydrochloricacid_gt5u", 1000, "Hydrochloric Acid"),
    fluid("dilutedhydrochloricacid_gt5u", 1000, "Diluted Hydrochloric Acid"),
  ],
};

export const VINYL_RECIPE: Recipe = {
  id: "oracle:gregtech:gt-recipe-largechemicalreactor:9f4ac3a11094fd85",
  name: "Large Chemical Reactor: Vinyl Chloride",
  machineType: "Large Chemical Reactor",
  minimumTier: "LV",
  durationTicks: 160,
  eut: 30,
  inputs: [
    circuit(2),
    fluid("hydrochloricacid_gt5u", 1000, "Hydrochloric Acid"),
    fluid("ethylene", 1000, "Ethylene"),
    fluid("oxygen", 1000, "Oxygen"),
  ],
  outputs: [fluid("vinylchloride", 1000, "Vinyl Chloride"), fluid("water", 1000, "Water")],
};

export const phenolCard = (id: string, recipeId: string, x: number, y = 0) => ({
  id,
  recipeId,
  machineCount: 1,
  parallel: 1,
  overclockTier: "LV",
  enabled: true,
  position: { x, y },
});

const wire = (id: string, source: string, target: string, resourceId: string) => ({
  id,
  source,
  target,
  sourceHandle: `output:fluid:${resourceId}`,
  ...(target === "out" ? {} : { targetHandle: `input:fluid:${resourceId}` }),
  resourceKind: "fluid" as const,
  resourceId,
});

export interface PhenolPlanOptions {
  /** The Vinyl Chloride recipe the second card runs (a variant to tie the two cards' draws). */
  vinyl?: Recipe;
  /** More cards. */
  extraNodes?: FactoryProject["nodes"];
  /** A supply drawer (rule Any) wired to every input the line takes from outside. */
  supplies?: boolean;
}

const SUPPLIES: Array<[resourceId: string, displayName: string, card: string]> = [
  ["benzene", "Benzene", "phenol"],
  ["chlorine", "Chlorine", "phenol"],
  ["ethylene", "Ethylene", "vinyl"],
  ["oxygen", "Oxygen", "vinyl"],
];

/** The line with a Phenol drawer set to exactly `perSecond`. */
export function phenolPlan(perSecond: number, options: PhenolPlanOptions = {}): FactoryProject {
  const vinyl = options.vinyl ?? VINYL_RECIPE;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "phenol",
    name: "Phenol",
    solveMode: true,
    planMode: true,
    recipes: [PHENOL_RECIPE, vinyl],
    nodes: [
      phenolCard("phenol", PHENOL_RECIPE.id, 0),
      phenolCard("vinyl", vinyl.id, 400),
      ...(options.extraNodes ?? []),
    ],
    storages: [
      {
        id: "out",
        kind: "fluid",
        resourceId: "phenol",
        displayName: "Phenol",
        position: { x: 800, y: 0 },
        targetPerSecond: perSecond,
        targetMode: "exact",
      },
      ...(options.supplies
        ? SUPPLIES.map(([resourceId, displayName], i) => ({
            id: `in-${resourceId}`,
            kind: "fluid",
            resourceId,
            displayName,
            position: { x: -400, y: i * 100 },
          }))
        : []),
    ],
    edges: [
      wire("water", "vinyl", "phenol", "water"),
      wire("acid", "phenol", "vinyl", "hydrochloricacid_gt5u"),
      wire("made", "phenol", "out", "phenol"),
      ...(options.supplies
        ? SUPPLIES.map(([resourceId, , card]) => ({
            id: `supply-${resourceId}`,
            source: `in-${resourceId}`,
            target: card,
            targetHandle: `input:fluid:${resourceId}`,
            resourceKind: "fluid" as const,
            resourceId,
          }))
        : []),
    ],
    fuelProfiles: [],
  } as unknown as FactoryProject;
}

/** The steps the player raised Phenol through. */
export const PHENOL_STEPS = Array.from({ length: 13 }, (_, i) => 8 + i);
