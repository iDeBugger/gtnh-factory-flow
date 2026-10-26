import {
  PROJECT_SCHEMA_VERSION,
  type FactoryEdge,
  type FactoryNode,
  type FactoryProject,
  type FactoryStorage,
  type Recipe,
} from "../../../model/types";
import { CUSTOM_RATE_MACHINE_TYPE } from "../../../model/custom-rate";

/** Small hand-made plans for the adapter's tests: every recipe is 20 ticks, so craft rate = count. */
export type Slot = [item: string, amount: number];

export function recipe(id: string, inputs: Slot[], outputs: Slot[], machineType = "Mock Machine"): Recipe {
  return {
    id,
    name: id,
    machineType,
    minimumTier: "LV",
    durationTicks: 20,
    eut: 30,
    inputs: inputs.map(([item, amount]) => ({ kind: "item", id: item, amount, displayName: item })),
    outputs: outputs.map(([item, amount]) => ({ kind: "item", id: item, amount, displayName: item })),
  };
}

export function customRecipe(id: string, item: string, perSecond: number, mode: "supply" | "request"): Recipe {
  const r = recipe(id, mode === "request" ? [[item, perSecond]] : [], mode === "supply" ? [[item, perSecond]] : [], CUSTOM_RATE_MACHINE_TYPE);
  return { ...r, eut: 0, minimumTier: "NONE" };
}

export function node(id: string, recipeId: string, extra: Partial<FactoryNode> = {}): FactoryNode {
  return {
    id,
    recipeId,
    machineCount: 1,
    parallel: 1,
    overclockTier: "LV",
    enabled: true,
    position: { x: 0, y: 0 },
    ...extra,
  };
}

export function drawer(
  id: string,
  item: string,
  extra: Partial<FactoryStorage> = {},
): FactoryStorage {
  return { id, kind: "item", resourceId: item, displayName: item, position: { x: 0, y: 0 }, ...extra } as FactoryStorage;
}

export const handle = (side: "input" | "output", item: string, section = 0) =>
  `${section > 0 ? `r${section}:` : ""}${side}:item:${encodeURIComponent(item)}`;

/** machine -> machine wire (section numbers pick `r<n>:` handles on shared cards). */
export function wire(
  id: string,
  from: string,
  to: string,
  item: string,
  sections: { from?: number; to?: number } = {},
  drawers: { fromDrawer?: boolean; toDrawer?: boolean } = {},
): FactoryEdge {
  return {
    id,
    source: from,
    target: to,
    sourceHandle: drawers.fromDrawer ? undefined : handle("output", item, sections.from ?? 0),
    targetHandle: drawers.toDrawer ? undefined : handle("input", item, sections.to ?? 0),
    resourceKind: "item",
    resourceId: item,
  };
}

export function project(parts: {
  recipes: Recipe[];
  nodes: FactoryNode[];
  storages?: FactoryStorage[];
  edges?: FactoryEdge[];
  extra?: Partial<FactoryProject>;
}): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "p",
    name: "p",
    recipes: parts.recipes,
    nodes: parts.nodes,
    storages: parts.storages ?? [],
    edges: parts.edges ?? [],
    fuelProfiles: [],
    ...parts.extra,
  } as FactoryProject;
}
