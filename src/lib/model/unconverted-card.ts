import { planGameVersion } from "./game-version";
import { edgeSectionAt, listNodeSections, sectionNodeId } from "./shared-machine";
import type {
  FactoryEdge,
  FactoryNode,
  FactoryProject,
  Recipe,
  ResourceAmount,
  ResourceKind,
  UnconvertedRecipe,
} from "./types";

/**
 * A card whose recipe was not found when its plan was converted to another game version
 * (`FactoryNode.unconverted`, a section's `extraRecipes[i].unconverted`). It has no recipe body of the plan's version,
 * so the board draws it from its marker and its wires: the marker names the machine and the recipe, every wire is a
 * port. The solver leaves it out and reads its wires as outside inputs and outputs (`plan/adapter/model.ts`).
 */

/** The line a marked card wears; a press on it opens the recipe search seeded from the card's wires. */
export function unconvertedCardLine(version: string): string {
  return `Not in GTNH ${version}. Pick a recipe.`;
}

/** What the solve does with the wires of `count` marked cards, said by the notice and (for one) the card's tip. */
export function unconvertedWiresRule(count: number): string {
  return `${count === 1 ? "Its" : "Their"} wires count as outside inputs and outputs.`;
}

/** What the solve says about a marked card: why it is out, and what its wires stand for. */
export function unconvertedWarning(version: string): string {
  return `Not in GTNH ${version}, so it is left out of the solve. Its wires count as outside inputs and outputs.`;
}

/** The marker of section `section` of a card (0 is the card's own recipe). */
export function sectionMarker(node: FactoryNode, section: number): UnconvertedRecipe | undefined {
  return section === 0 ? node.unconverted : node.extraRecipes?.[section - 1]?.unconverted;
}

/** The sections of a card that are marked, in order. */
export function markedSections(node: FactoryNode): number[] {
  const sections: number[] = [];
  if (node.unconverted) sections.push(0);
  node.extraRecipes?.forEach((extra, index) => {
    if (extra.unconverted) sections.push(index + 1);
  });
  return sections;
}

export function isUnconvertedCard(node: FactoryNode): boolean {
  return node.unconverted !== undefined || (node.extraRecipes?.some((extra) => extra.unconverted) ?? false);
}

/** The id the card's line picks a recipe for: the first marked section (`card#rN` for a shared card's section). */
export function firstUnconvertedTarget(node: FactoryNode): string | undefined {
  const section = markedSections(node)[0];
  return section === undefined ? undefined : sectionNodeId(node.id, section);
}

type PlanParts = Pick<FactoryProject, "nodes" | "edges" | "recipes"> & Pick<Partial<FactoryProject>, "storages">;

/** The wires on one section of a card: what comes in and what goes out. */
export function sectionWires(
  edges: readonly FactoryEdge[],
  nodeId: string,
  section: number,
): { incoming: FactoryEdge[]; outgoing: FactoryEdge[] } {
  const incoming: FactoryEdge[] = [];
  const outgoing: FactoryEdge[] = [];
  for (const edge of edges) {
    if (edge.target === nodeId && edgeSectionAt(edge, nodeId, "target") === section) incoming.push(edge);
    else if (edge.source === nodeId && edgeSectionAt(edge, nodeId, "source") === section) outgoing.push(edge);
  }
  return { incoming, outgoing };
}

/**
 * The resource a wire carries, with its name and art taken from what is on its other end: that card's slot, or the
 * drawer. A wire carries only its kind and id.
 */
export function wireResource(project: PlanParts, edge: FactoryEdge, nodeId: string): ResourceAmount {
  const kind: ResourceKind = edge.resourceKind;
  const id = edge.resourceId;
  const otherId = edge.target === nodeId ? edge.source : edge.target;
  const fromCard = edge.target === nodeId;
  const other = project.nodes.find((entry) => entry.id === otherId);
  const slots = (recipe: Recipe | undefined) =>
    recipe ? (fromCard ? recipe.outputs : recipe.inputs) : [];
  const found: ResourceAmount | undefined =
    (other
      ? listNodeSections(other)
          .map(({ node }) => project.recipes.find((entry) => entry.id === node.recipeId))
          .flatMap(slots)
          .find((slot) => slot.kind === kind && slot.id === id)
      : undefined) ??
    project.recipes
      .flatMap((recipe) => [...recipe.inputs, ...recipe.outputs])
      .find((slot) => slot.kind === kind && slot.id === id);
  if (found) {
    return {
      kind,
      id,
      amount: 1,
      displayName: found.displayName,
      iconPath: found.iconPath,
      iconAtlas: found.iconAtlas,
      dominantColor: found.dominantColor,
      modId: found.modId,
      tooltip: found.tooltip,
    };
  }
  const storage = project.storages?.find((entry) => entry.kind === kind && entry.resourceId === id);
  return {
    kind,
    id,
    amount: 1,
    displayName: storage?.displayName ?? edge.label,
    iconPath: storage?.iconPath,
    iconAtlas: storage?.iconAtlas,
    dominantColor: storage?.dominantColor,
  };
}

/** One port per resource and side, in wire order. */
function portList(edges: readonly FactoryEdge[]): Array<{ kind: ResourceKind; id: string; edge: FactoryEdge }> {
  const seen = new Set<string>();
  const ports: Array<{ kind: ResourceKind; id: string; edge: FactoryEdge }> = [];
  for (const edge of edges) {
    const key = `${edge.resourceKind}:${edge.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({ kind: edge.resourceKind, id: edge.resourceId, edge });
  }
  return ports;
}

const placeholders = new Map<string, { key: string; recipe: Recipe }>();
const PLACEHOLDER_LIMIT = 2000;

/**
 * The stand-in recipe a marked section is drawn from: the marker's machine and recipe name, a port for every resource
 * its wires carry (inputs from the wires coming in, outputs from the wires going out), no numbers. Built once per card,
 * section, marker and port list, so the node's `data` keeps its identity across board rebuilds.
 */
export function unconvertedPlaceholderRecipe(
  project: PlanParts,
  node: FactoryNode,
  section: number,
): Recipe | undefined {
  const marker = sectionMarker(node, section);
  if (!marker) return undefined;
  const recipeId = section === 0 ? node.recipeId : (node.extraRecipes?.[section - 1]?.recipeId ?? marker.recipeId);
  const { incoming, outgoing } = sectionWires(project.edges, node.id, section);
  const ins = portList(incoming);
  const outs = portList(outgoing);
  const key = JSON.stringify([
    recipeId,
    marker.recipeName,
    marker.machineType,
    marker.reason ?? "",
    ins.map((port) => `${port.kind}:${port.id}`),
    outs.map((port) => `${port.kind}:${port.id}`),
  ]);
  const cacheId = sectionNodeId(node.id, section);
  const cached = placeholders.get(cacheId);
  if (cached && cached.key === key) return cached.recipe;
  // Ids from plans opened earlier in the session pile up here; content keys keep a stale entry from ever being
  // returned, and the bound keeps the pile small.
  if (placeholders.size >= PLACEHOLDER_LIMIT) placeholders.clear();
  const recipe: Recipe = {
    id: recipeId,
    name: marker.recipeName,
    machineType: marker.machineType,
    minimumTier: "DEMO",
    durationTicks: 20,
    eut: 0,
    inputs: ins.map((port) => wireResource(project, port.edge, node.id)),
    outputs: outs.map((port) => wireResource(project, port.edge, node.id)),
  };
  placeholders.set(cacheId, { key, recipe });
  return recipe;
}

/** The card's own (section 0) stand-ins for every marked card on the plan; one shared empty map when there are none. */
const NO_PLACEHOLDERS: ReadonlyMap<string, Recipe> = new Map();
// The last answer, handed back while every stand-in in it is the same object: a wire added elsewhere on the board
// then rebuilds no node data (FactoryFlow's node memo depends on this map).
let lastPlaceholders: ReadonlyMap<string, Recipe> = NO_PLACEHOLDERS;
export function unconvertedCardRecipes(project: PlanParts): ReadonlyMap<string, Recipe> {
  let map: Map<string, Recipe> | undefined;
  for (const node of project.nodes) {
    if (!node.unconverted) continue;
    const recipe = unconvertedPlaceholderRecipe(project, node, 0);
    if (!recipe) continue;
    (map ??= new Map()).set(node.id, recipe);
  }
  if (!map) return NO_PLACEHOLDERS;
  const previous = lastPlaceholders;
  if (previous.size === map.size && [...map].every(([id, recipe]) => previous.get(id) === recipe)) return previous;
  lastPlaceholders = map;
  return map;
}

/**
 * A marked card's name in a list: its machine and the recipe it had. Dataset recipe names lead with their map
 * ("Blast Furnace: Raw Silicon Ingot"); when that is the machine already leading the line, it is said once.
 */
export function unconvertedCardLabel(node: FactoryNode): string {
  const markers = markedSections(node)
    .map((section) => sectionMarker(node, section))
    .filter((marker): marker is UnconvertedRecipe => marker !== undefined);
  const first = markers[0];
  if (!first) return "";
  const lead = `${first.machineType}: `;
  const names = markers
    .map((marker) => (marker.recipeName.startsWith(lead) ? marker.recipeName.slice(lead.length) : marker.recipeName))
    .join(", ");
  return `${first.machineType}: ${names}`;
}

/** The version a marked card's recipe is missing from: the plan's own. */
export function unconvertedVersionOf(project: Pick<FactoryProject, "gameVersion">): string {
  return planGameVersion(project);
}
