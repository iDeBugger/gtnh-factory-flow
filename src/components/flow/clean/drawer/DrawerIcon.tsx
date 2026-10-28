import { makeResourceKey } from "@/lib/model";
import { fluidSwatchStyle } from "../fluid-swatch";
import type { FactoryStorage, Recipe, ResourceAmount } from "@/lib/model/types";
import { getFallbackFluidColor, ResourceIcon } from "@/components/nei/ResourceIcon";
import { useFactoryStore } from "@/store/factory-store";

/**
 * The drawer's picture, drawn as the card draws its ports (`CleanCard` PortIcon): a fluid is the mod's flat square in
 * the fluid's own colour, an item is its sprite at the card's zoom. A drawer made by a test or an old save may carry
 * no art of its own; then the same resource's art is borrowed from the plan's recipes, so a card and its drawer
 * always show one colour.
 */

const byRecipes = new WeakMap<Recipe[], Map<string, ResourceAmount>>();

/** The first recipe resource (input or output) of this kind and id that carries art, if any. */
function recipeArt(recipes: Recipe[], kind: string, id: string): ResourceAmount | undefined {
  let map = byRecipes.get(recipes);
  if (!map) {
    map = new Map();
    for (const recipe of recipes) {
      for (const resource of [...recipe.inputs, ...recipe.outputs]) {
        if (!resource.iconPath && !resource.iconAtlas && !resource.dominantColor) continue;
        const key = makeResourceKey(resource.kind, resource.id);
        if (!map.has(key)) map.set(key, resource);
      }
    }
    byRecipes.set(recipes, map);
  }
  return map.get(makeResourceKey(kind as ResourceAmount["kind"], id));
}

function hasArt(storage: Pick<FactoryStorage, "iconPath" | "iconAtlas" | "dominantColor">): boolean {
  return Boolean(storage.iconPath || storage.iconAtlas || storage.dominantColor);
}

export function DrawerIcon({
  storage,
  alternatives,
}: {
  storage: FactoryStorage;
  alternatives?: ResourceAmount["alternatives"];
}) {
  const borrowed = useFactoryStore((state) =>
    hasArt(storage) ? undefined : recipeArt(state.project.recipes, storage.kind, storage.resourceId),
  );
  const art = { ...storage, ...(borrowed ?? {}) };
  if (storage.kind === "power") return <span className="cd-icon cd-eu" aria-hidden />;
  if (storage.kind === "fluid") {
    const color =
      art.dominantColor ?? art.iconAtlas?.dominantColor ?? getFallbackFluidColor(storage.resourceId);
    return (
      <span
        className="cd-icon cd-swatch"
        role="img"
        aria-label={storage.displayName}
        style={fluidSwatchStyle({ id: storage.resourceId, dominantColor: color, iconAtlas: art.iconAtlas })}
      />
    );
  }
  return (
    <ResourceIcon
      resource={{
        ...art,
        id: storage.resourceId,
        amount: 1,
        alternatives,
      }}
      itemZoom={1.5}
      showAmount={false}
      bare
      tooltip={false}
      showConsumedState={false}
      className="cd-icon"
    />
  );
}
