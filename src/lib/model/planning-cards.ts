import type { RecipeSummary } from "@/lib/datasets/types";
import { CROP_FARM_RECIPE_MAP } from "./passive-production";

/** A planning card the non-recipe picker lists first: no recipe, no tier. */
export interface PlanningCard {
  id: "custom-rate" | "fluid-tank" | "crop-farm";
  name: string;
  blurb: string;
}

const PLANNING_CARDS: readonly PlanningCard[] = [
  { id: "custom-rate", name: "Custom Rate", blurb: "A rate you set: supplies or drains any resource, at a dial." },
  { id: "fluid-tank", name: "Fluid Tank", blurb: "Empties a filled cell into its fluid and the empty cell, or fills cells. Free and instant." },
  { id: "crop-farm", name: "Crop Farm", blurb: "Crops planted and harvested: pick the crop on the card." },
];

/**
 * The planning cards the loaded dataset can back. The Crop Farm plants CropsNH crops, so it is listed only when
 * the dataset carries one (2.8.1 ships no CropsNH). The dataset decides, never a version name.
 */
export function planningCardsFor(opts: { datasetHasCropsNh: boolean }): PlanningCard[] {
  return PLANNING_CARDS.filter((card) => card.id !== "crop-farm" || opts.datasetHasCropsNh);
}

/**
 * True when any summary is a CropsNH crop: category `cropsnh-crop`, or a Crop Farm map recipe. The crop endpoint
 * lists the Crop Farm map only, and every recipe on it is a CropsNH crop (`createCropFarmPlaceholderRecipe`), so the
 * map stands in where a summary carries no category.
 */
export function datasetHasCropsNh(
  crops: Iterable<Pick<RecipeSummary, "category"> & Partial<Pick<RecipeSummary, "recipeMap">>>,
): boolean {
  for (const crop of crops) {
    if (crop.category === "cropsnh-crop" || crop.recipeMap === CROP_FARM_RECIPE_MAP) return true;
  }
  return false;
}
