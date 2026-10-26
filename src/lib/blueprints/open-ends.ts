import { isRecipeInputConsumed, makeResourceKey } from "@/lib/model/resources";
import { applyRecipeInputOverrides } from "@/lib/model/recipe-input-overrides";
import { applyMachineHandlerToRecipe } from "@/lib/model/recipe-rules";
import type { FactoryProject, FactoryStorage, ResourceKey } from "@/lib/model/types";
import { getRuntimeCalculationOutputs } from "@/lib/solver/runtime-calculation";
import { planGameVersion } from "@/lib/model/game-version";

/**
 * A captured selection as a plan of its own: a SOURCE drawer on every consumed input slot with no wire on it and a
 * DRAIN drawer on every output slot with none. The capture severed every wire that crossed the selection's edge, and
 * the plan is closed (a bare slot is a hard zero), so without these each cut would stop its machine dead. The drawers
 * read as the selection's needs and outputs in the books (balances.ts reads boundary drawers).
 */
export function openSelectionEnds(project: FactoryProject): FactoryProject {
  const gameVersion = planGameVersion(project);
  const storages: FactoryStorage[] = [...(project.storages ?? [])];
  const edges = [...project.edges];
  const storageIds = new Set(storages.map((storage) => storage.id));

  // Every slot that already has a wire on it, keyed by node and side, read from the selection's own wires.
  const playerWired = new Set<string>();
  for (const edge of project.edges) {
    const key = makeResourceKey(edge.resourceKind, edge.resourceId);
    playerWired.add(`${edge.target}|in|${key}`);
    playerWired.add(`${edge.source}|out|${key}`);
  }
  // What this function has already put down, so a recipe listing one resource
  // in two slots gets one drawer rather than two.
  const attached = new Set<string>();
  const needsDrawer = (nodeId: string, side: "in" | "out", key: ResourceKey) => {
    const slot = `${nodeId}|${side}|${key}`;
    if (attached.has(slot)) {
      return false;
    }
    if (playerWired.has(slot)) {
      return false;
    }
    attached.add(slot);
    return true;
  };

  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const nodesById = new Map(project.nodes.map((node) => [node.id, node]));
  // Stacked beside the machine they serve rather than piled on the origin:
  // sources off to its left, drains off to its right, which is the direction
  // the board already reads in. On grid, so the router keeps its endpoints.
  const placed = new Map<string, number>();
  const positionFor = (nodeId: string, side: "in" | "out") => {
    const anchor = nodesById.get(nodeId)?.position ?? { x: 0, y: 0 };
    const lane = `${nodeId}|${side}`;
    const index = placed.get(lane) ?? 0;
    placed.set(lane, index + 1);
    return {
      x: anchor.x + (side === "in" ? -260 : 460),
      y: anchor.y + index * 160,
    };
  };

  let seq = 0;
  const attach = (
    nodeId: string,
    side: "in" | "out",
    kind: FactoryStorage["kind"],
    resourceId: string,
  ) => {
    seq += 1;
    let id = `boundary-${side}-${seq}`;
    while (storageIds.has(id)) {
      seq += 1;
      id = `boundary-${side}-${seq}`;
    }
    storageIds.add(id);
    storages.push({ id, kind, resourceId, position: positionFor(nodeId, side) });
    edges.push({
      id: `boundary-edge-${side}-${seq}`,
      source: side === "in" ? id : nodeId,
      target: side === "in" ? nodeId : id,
      resourceKind: kind,
      resourceId,
    });
  };

  for (const node of project.nodes) {
    if (node.enabled === false) {
      continue;
    }
    const recipe = recipesById.get(node.recipeId);
    if (!recipe) {
      continue;
    }
    // The node's REAL ports, not the raw recipe's: an oredict slot pinned to
    // a concrete item consumes that item, and a handler or a runtime variant
    // can change what comes out. A drawer on a port the solve does not have
    // is an edge the solve drops (a silent starve). Only the keys matter, not
    // rates, so this can run before the solver.
    const nodeRecipe = applyRecipeInputOverrides(recipe, node, gameVersion);
    const effectiveRecipe = applyMachineHandlerToRecipe(nodeRecipe, node, gameVersion);
    const outputs = getRuntimeCalculationOutputs(effectiveRecipe, node, gameVersion) ?? effectiveRecipe.outputs;
    // Non-consumed inputs are not ingredients and never need a feeder.
    for (const input of nodeRecipe.inputs) {
      if (!isRecipeInputConsumed(input) || (input.amount ?? 0) <= 0) {
        continue;
      }
      const key = makeResourceKey(input.kind, input.id);
      if (needsDrawer(node.id, "in", key)) {
        attach(node.id, "in", input.kind as FactoryStorage["kind"], input.id);
      }
    }
    for (const output of outputs) {
      if ((output.amount ?? 0) <= 0) {
        continue;
      }
      const key = makeResourceKey(output.kind, output.id);
      if (needsDrawer(node.id, "out", key)) {
        attach(node.id, "out", output.kind as FactoryStorage["kind"], output.id);
      }
    }
  }

  return { ...project, storages, edges };
}
