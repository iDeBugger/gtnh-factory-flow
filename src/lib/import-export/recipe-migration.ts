import type { FactoryEdge, FactoryProject, Recipe, ResourceKind } from "@/lib/model/types";
import {
  makeResourceHandleId,
  parseResourceHandleId,
  sectionHandleId,
  splitSectionHandleId,
} from "@/components/flow/resource-handles";
import { sectionNodeView } from "@/lib/model/shared-machine";

/*
 * Moving a plan's cards and wires onto recipes that replaced the ones they were built on (an import's content
 * match, a conversion to another game version). Store-free, so any loader can use it.
 */

export function remapMigratedRecipeReferences(
  project: FactoryProject,
  recipeIdMigration: Map<string, string>,
): FactoryProject {
  if (recipeIdMigration.size === 0) {
    return project;
  }

  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe] as const));
  const nodes = project.nodes.map((node) => {
    const migratedId = recipeIdMigration.get(node.recipeId);
    const carried = migratedId
      ? carryNodeOntoMigratedRecipe(node, recipesById.get(migratedId))
      : node;
    // A shared machine's extra recipes migrate by id like the first.
    const extras = carried.extraRecipes?.map((extra) => {
      const extraId = recipeIdMigration.get(extra.recipeId);
      return extraId ? { ...extra, recipeId: extraId } : extra;
    });
    return extras ? { ...carried, extraRecipes: extras } : carried;
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const originalNodesById = new Map(project.nodes.map((node) => [node.id, node] as const));

  return {
    ...project,
    nodes,
    edges: project.edges.map((edge) =>
      remapMigratedRecipeEdgeHandles(
        project,
        nodesById,
        originalNodesById,
        recipeIdMigration,
        edge,
      ),
    ),
  };
}

export function refreshImportedProjectEdges(project: FactoryProject): FactoryProject {
  if (project.edges.length === 0) {
    return project;
  }

  const nodesById = new Map(project.nodes.map((node) => [node.id, node] as const));
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe] as const));
  const storagesById = new Map(
    (project.storages ?? []).map((storage) => [storage.id, storage] as const),
  );
  const edges = project.edges.map((edge) =>
    refreshImportedProjectEdgeHandles(edge, nodesById, recipesById, storagesById),
  );

  return { ...project, edges };
}

function refreshImportedProjectEdgeHandles(
  edge: FactoryEdge,
  nodesById: Map<string, FactoryProject["nodes"][number]>,
  recipesById: Map<string, Recipe>,
  storagesById: Map<string, NonNullable<FactoryProject["storages"]>[number]>,
): FactoryEdge {
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  const sourceRecipe = sectionRecipeAt(sourceNode, edge.sourceHandle, recipesById);
  const targetRecipe = sectionRecipeAt(targetNode, edge.targetHandle, recipesById);
  const sourceStorage = storagesById.get(edge.source);
  const targetStorage = storagesById.get(edge.target);

  return {
    ...edge,
    sourceHandle: sourceRecipe
      ? remapRecipeHandle(
          sourceRecipe,
          edge.sourceHandle,
          "output",
          edge.resourceKind,
          edge.resourceId,
        )
      : sourceStorage
        ? makeResourceHandleId("output", {
            kind: sourceStorage.kind,
            id: sourceStorage.resourceId,
          })
        : edge.sourceHandle,
    targetHandle: targetRecipe
      ? remapRecipeHandle(
          targetRecipe,
          edge.targetHandle,
          "input",
          edge.resourceKind,
          edge.resourceId,
        )
      : targetStorage
        ? makeResourceHandleId("input", {
            kind: targetStorage.kind,
            id: targetStorage.resourceId,
          })
        : edge.targetHandle,
  };
}

function remapMigratedRecipeEdgeHandles(
  project: FactoryProject,
  nodesById: Map<string, FactoryProject["nodes"][number]>,
  originalNodesById: Map<string, FactoryProject["nodes"][number]>,
  recipeIdMigration: Map<string, string>,
  edge: FactoryEdge,
): FactoryEdge {
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  const originalSourceNode = originalNodesById.get(edge.source);
  const originalTargetNode = originalNodesById.get(edge.target);
  const sourceRecipeMigrated = Boolean(
    originalSourceNode && recipeIdMigration.has(originalSourceNode.recipeId),
  );
  const targetRecipeMigrated = Boolean(
    originalTargetNode && recipeIdMigration.has(originalTargetNode.recipeId),
  );

  if (!sourceRecipeMigrated && !targetRecipeMigrated) {
    return edge;
  }

  const migratedRecipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe] as const));
  const sourceRecipe = sectionRecipeAt(sourceNode, edge.sourceHandle, migratedRecipesById);
  const targetRecipe = sectionRecipeAt(targetNode, edge.targetHandle, migratedRecipesById);

  return {
    ...edge,
    sourceHandle:
      sourceRecipeMigrated && sourceRecipe
        ? remapRecipeHandle(
            sourceRecipe,
            edge.sourceHandle,
            "output",
            edge.resourceKind,
            edge.resourceId,
          )
        : edge.sourceHandle,
    targetHandle:
      targetRecipeMigrated && targetRecipe
        ? remapRecipeHandle(
            targetRecipe,
            edge.targetHandle,
            "input",
            edge.resourceKind,
            edge.resourceId,
          )
        : edge.targetHandle,
  };
}

/**
 * A shared machine's section prefix (`r2:`) rides through the remap untouched:
 * the handle behind it is repaired against that section's recipe and the
 * prefix put back.
 */
function remapRecipeHandle(
  recipe: Recipe,
  prefixedHandleId: string | undefined,
  expectedSide: "input" | "output",
  resourceKind: ResourceKind,
  resourceId: string,
): string | undefined {
  const { section, handleId } = splitSectionHandleId(prefixedHandleId);
  const bare = remapBareRecipeHandle(recipe, handleId, expectedSide, resourceKind, resourceId);
  return bare === undefined ? undefined : sectionHandleId(section, bare);
}

/** The recipe a wire's end reads at a card: the section its handle names. */
function sectionRecipeAt(
  node: FactoryProject["nodes"][number] | undefined,
  handleId: string | undefined,
  recipesById: Map<string, Recipe>,
): Recipe | undefined {
  if (!node) {
    return undefined;
  }
  const view = sectionNodeView(node, splitSectionHandleId(handleId).section);
  return recipesById.get(view.recipeId);
}

function remapBareRecipeHandle(
  recipe: Recipe,
  handleId: string | undefined,
  expectedSide: "input" | "output",
  resourceKind: ResourceKind,
  resourceId: string,
): string | undefined {
  const handle = parseResourceHandleId(handleId);
  const resources = expectedSide === "input" ? recipe.inputs : recipe.outputs;
  const handleResourceKind = handle?.kind ?? resourceKind;
  const handleResourceId = handle?.resourceId ?? resourceId;
  const slotIndex = parseResourceHandleSlotIndex(handleId);

  if (
    handle?.side === expectedSide &&
    resources.some(
      (resource, index) =>
        resource.kind === handleResourceKind &&
        resource.id === handleResourceId &&
        makeResourceHandleId(expectedSide, resource, index) === handleId,
    )
  ) {
    return handleId;
  }

  if (slotIndex !== undefined) {
    const indexedResource = resources[slotIndex];
    if (indexedResource?.kind === handleResourceKind && indexedResource.id === handleResourceId) {
      return makeResourceHandleId(expectedSide, indexedResource, slotIndex);
    }
  }

  const nextIndex = resources.findIndex(
    (resource) => resource.kind === resourceKind && resource.id === resourceId,
  );
  if (nextIndex !== -1) {
    return makeResourceHandleId(expectedSide, resources[nextIndex], nextIndex);
  }

  const matchingHandleIndex = resources.findIndex(
    (resource) => resource.kind === handleResourceKind && resource.id === handleResourceId,
  );
  return matchingHandleIndex === -1
    ? handleId
    : makeResourceHandleId(expectedSide, resources[matchingHandleIndex], matchingHandleIndex);
}

function parseResourceHandleSlotIndex(handleId: string | undefined): number | undefined {
  const rawIndex = handleId?.split(":")[3];
  if (rawIndex === undefined) {
    return undefined;
  }

  const index = Number(rawIndex);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * A node whose recipe was migrated keeps only the choices the new recipe
 * can honour: a handler id the new recipe does not list is dropped (the
 * card falls back to its first handler, as a dataset load would leave it),
 * and slot overrides move from the old recipe's slot numbers to the slot
 * holding the same resource on the new one, since the exporter's slot
 * order is not part of what makes two recipes the same.
 */
export function carryNodeOntoMigratedRecipe(
  node: FactoryProject["nodes"][number],
  recipe: Recipe | undefined,
): FactoryProject["nodes"][number] {
  if (!recipe) {
    return node;
  }
  const carried: FactoryProject["nodes"][number] = { ...node, recipeId: recipe.id };
  if (
    node.machineHandlerId &&
    !(recipe.machineHandlers ?? []).some((handler) => handler.id === node.machineHandlerId)
  ) {
    delete carried.machineHandlerId;
  }
  const overrides = node.recipeInputOverrides;
  if (overrides) {
    const claimed = new Set<number>();
    const rekeyed: NonNullable<typeof overrides> = {};
    for (const override of Object.values(overrides)) {
      if (!override) {
        continue;
      }
      const index = recipe.inputs.findIndex(
        (input, inputIndex) =>
          !claimed.has(inputIndex) &&
          input.kind === override.kind &&
          (input.id === override.id ||
            input.alternatives?.some((alternative) => alternative.id === override.id)),
      );
      if (index === -1) {
        continue;
      }
      claimed.add(index);
      rekeyed[String(index)] = override;
    }
    if (Object.keys(rekeyed).length > 0) {
      carried.recipeInputOverrides = rekeyed;
    } else {
      delete carried.recipeInputOverrides;
    }
  }
  return carried;
}
