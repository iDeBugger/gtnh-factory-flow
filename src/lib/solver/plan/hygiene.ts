import { canonicalizeResourceHandleId } from "../../model/edge-identity";
import { applyRecipeInputOverrides } from "../../model/recipe-input-overrides";
import { applyMachineHandlerToRecipe } from "../../model/recipe-rules";
import { isRecipeInputConsumed } from "../../model/resources";
import { getStorageRoles } from "../../model/storage-role";
import { hasStorageTarget } from "../../model/storage-target";
import {
  listNodeSections,
  parseSectionNodeId,
  sectionHandleId,
  sectionNodeId,
  splitSectionHandleId,
} from "../../model/shared-machine";
import type { FactoryEdge, FactoryNode, FactoryProject, Recipe } from "../../model/types";
import { getRuntimeCalculationOutputs } from "../runtime-calculation";
import { makeLeftoverKey, makePortKey, parsePortKey, splitLeftoverKey } from "./port-key";
import { type GameVersion, planGameVersion } from "@/lib/model/game-version";

/**
 * Keeping `portRates` (on a card, keyed by handle with a `r<n>:` section
 * prefix) and `spareShares` (on the project, keyed by PortKeys whose node id
 * is the solve node, `card#rN` for a section) true to the cards they name.
 * Pure functions on a project; each returns the same object when nothing
 * changed, because `touchProject` runs after every edit.
 */

type Rows = { input: Set<string>; output: Set<string> };

const handleOf = (side: "input" | "output", kind: string, id: string) =>
  `${side}:${kind}:${encodeURIComponent(id)}`;

/** The port rows a section of a card has, as canonical handles. */
function sectionRows(view: FactoryNode, recipe: Recipe | undefined, gameVersion: GameVersion): Rows | undefined {
  if (!recipe) {
    return undefined;
  }
  const effective = applyMachineHandlerToRecipe(applyRecipeInputOverrides(recipe, view, gameVersion), view, gameVersion);
  const rows: Rows = { input: new Set(), output: new Set() };
  for (const input of effective.inputs) {
    if (isRecipeInputConsumed(input)) {
      rows.input.add(handleOf("input", input.kind, input.id));
    }
  }
  for (const output of getRuntimeCalculationOutputs(effective, view, gameVersion) ?? effective.outputs) {
    rows.output.add(handleOf("output", output.kind, output.id));
  }
  return rows;
}

function canonical(handle: string): string {
  // `output:item:foo:3` -> `output:item:foo`
  const [side, kind, id] = handle.split(":");
  return side && kind && id ? `${side}:${kind}:${id}` : handle;
}

function sameRecord(a: Record<string, number> | undefined, b: Record<string, number>): boolean {
  if (!a) {
    return false;
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** A card's port rates, handles mapped by `mapSection` (undefined drops the entry). */
function mapPortRates(
  rates: Record<string, number>,
  mapSection: (section: number) => number | undefined,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [handleId, value] of Object.entries(rates)) {
    const { section, handleId: bare } = splitSectionHandleId(handleId);
    const to = mapSection(section);
    if (to === undefined || !bare) {
      continue;
    }
    next[sectionHandleId(to, bare)] = value;
  }
  return next;
}

function withPortRates(node: FactoryNode, rates: Record<string, number>): FactoryNode {
  if (sameRecord(node.portRates, rates)) {
    return node;
  }
  const { portRates: _old, ...rest } = node;
  void _old;
  return Object.keys(rates).length > 0 ? { ...rest, portRates: rates } : rest;
}

/** Spare splits with each bearer's node id mapped (undefined drops the bearer). */
function mapSpareShares(
  spare: FactoryProject["spareShares"],
  mapNode: (nodeId: string) => string | undefined,
): FactoryProject["spareShares"] {
  if (!spare) {
    return spare;
  }
  const next: Record<string, Record<string, number>> = {};
  for (const [key, shares] of Object.entries(spare)) {
    const mapped = new Map<string, string>();
    for (const portKey of new Set([...splitLeftoverKey(key), ...Object.keys(shares)])) {
      const parsed = parsePortKey(portKey);
      const nodeId = parsed ? mapNode(parsed.nodeId) : undefined;
      if (parsed && nodeId !== undefined) {
        mapped.set(portKey, makePortKey(nodeId, parsed.side, parsed.handle));
      }
    }
    const kept = [...new Set(splitLeftoverKey(key).flatMap((k) => mapped.get(k) ?? []))];
    // A leftover with one possible place is never stored.
    if (kept.length < 2) {
      continue;
    }
    const split: Record<string, number> = {};
    for (const [portKey, share] of Object.entries(shares)) {
      const to = mapped.get(portKey);
      if (to !== undefined) {
        split[to] = share;
      }
    }
    next[makeLeftoverKey(kept)] = split;
  }
  const same =
    Object.keys(next).length === Object.keys(spare).length &&
    Object.entries(next).every(([key, value]) => sameRecord(spare[key], value));
  return same ? spare : next;
}

function withSpare(project: FactoryProject, spare: FactoryProject["spareShares"]): FactoryProject {
  if (spare === project.spareShares) {
    return project;
  }
  const { spareShares: _old, ...rest } = project;
  void _old;
  return spare && Object.keys(spare).length > 0 ? { ...rest, spareShares: spare } : rest;
}

/**
 * Drops what no longer names anything: port rates on a section the card lost
 * or a row its recipe lacks (or not a positive number), spare bearers on a
 * card, section or row that is gone, and spare splits left with fewer than two
 * bearers. Cheap: only cards with port rates and bearers are looked at.
 */
export function prunePlanFields(project: FactoryProject): FactoryProject {
  const gameVersion = planGameVersion(project);
  const hasRates = project.nodes.some((node) => node.portRates);
  if (!hasRates && !project.spareShares) {
    return project;
  }
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const nodesById = new Map(project.nodes.map((node) => [node.id, node]));
  // "gone": the card or section does not exist. "unknown": it does but its
  // recipe is not in the plan (mid-refresh), so nothing about its rows is
  // known and nothing is dropped for it.
  const rowsCache = new Map<string, Rows | "gone" | "unknown">();
  const rowsOf = (solveId: string): Rows | "gone" | "unknown" => {
    const cached = rowsCache.get(solveId);
    if (cached) {
      return cached;
    }
    const { nodeId, section } = parseSectionNodeId(solveId);
    const card = nodesById.get(nodeId);
    const view = card ? listNodeSections(card).find((s) => s.section === section)?.node : undefined;
    const rows = view ? (sectionRows(view, recipesById.get(view.recipeId), gameVersion) ?? "unknown") : "gone";
    rowsCache.set(solveId, rows);
    return rows;
  };
  const hasRow = (solveId: string, side: "input" | "output", handle: string): boolean => {
    const rows = rowsOf(solveId);
    return rows === "unknown" || (rows !== "gone" && rows[side].has(canonical(handle)));
  };

  let changed = false;
  const nodes = project.nodes.map((node) => {
    if (!node.portRates) {
      return node;
    }
    const kept: Record<string, number> = {};
    for (const [handleId, value] of Object.entries(node.portRates)) {
      const { section, handleId: bare } = splitSectionHandleId(handleId);
      const side = bare?.startsWith("output:") ? "output" : bare?.startsWith("input:") ? "input" : undefined;
      if (
        !(value > 0) ||
        !Number.isFinite(value) ||
        !bare ||
        !side ||
        !hasRow(sectionNodeId(node.id, section), side, bare)
      ) {
        continue;
      }
      kept[handleId] = value;
    }
    const next = withPortRates(node, kept);
    changed ||= next !== node;
    return next;
  });

  const spare = mapSpareShares(project.spareShares, (solveId) => {
    const parsed = parseSectionNodeId(solveId);
    return nodesById.has(parsed.nodeId) && rowsOf(solveId) !== "gone" ? solveId : undefined;
  });
  // A bearer whose row is gone: check the handle too.
  const rowChecked = pruneSpareRows(spare, hasRow);

  if (!changed && rowChecked === project.spareShares) {
    return project;
  }
  return withSpare(changed ? { ...project, nodes } : project, rowChecked);
}

function pruneSpareRows(
  spare: FactoryProject["spareShares"],
  hasRow: (solveId: string, side: "input" | "output", handle: string) => boolean,
): FactoryProject["spareShares"] {
  if (!spare) {
    return spare;
  }
  const next: Record<string, Record<string, number>> = {};
  let dropped = false;
  for (const [key, shares] of Object.entries(spare)) {
    const live = splitLeftoverKey(key).filter((portKey) => {
      const parsed = parsePortKey(portKey);
      return parsed && hasRow(parsed.nodeId, parsed.side === "i" ? "input" : "output", parsed.handle);
    });
    if (live.length === splitLeftoverKey(key).length) {
      next[key] = shares;
      continue;
    }
    dropped = true;
    if (live.length < 2) {
      continue;
    }
    const split: Record<string, number> = {};
    for (const portKey of live) {
      if (shares[portKey] !== undefined) {
        split[portKey] = shares[portKey]!;
      }
    }
    next[makeLeftoverKey(live)] = split;
  }
  return dropped ? next : spare;
}

/**
 * A card's port just wired to a drawer (`edge`, either way round, already in the project): the rate set on that port
 * goes to the drawer, as the mod's placePortDrawer and dropPortOnDrawer carry it. A source or product drawer with no
 * rule takes it exactly, the port's own rule; the port's own goes either way, since a wired port has no box to show or
 * clear it and would hold the card to it unseen. The same project when the port has no rate.
 */
export function movePortRateToDrawer(
  project: FactoryProject,
  edge: Pick<
    FactoryEdge,
    "source" | "target" | "sourceHandle" | "targetHandle" | "resourceKind" | "resourceId"
  >,
): FactoryProject {
  const storages = project.storages ?? [];
  const into = storages.find((storage) => storage.id === edge.target);
  const from = storages.find((storage) => storage.id === edge.source);
  const drawer = into ?? from;
  if (!drawer || (into && from)) {
    return project;
  }
  const output = Boolean(into);
  const cardId = output ? edge.source : edge.target;
  const wired =
    canonicalizeResourceHandleId(output ? edge.sourceHandle : edge.targetHandle) ??
    handleOf(output ? "output" : "input", edge.resourceKind, edge.resourceId);
  const rates = project.nodes.find((node) => node.id === cardId)?.portRates;
  const key = Object.keys(rates ?? {}).find(
    (handle) => canonicalizeResourceHandleId(handle) === wired,
  );
  if (!rates || key === undefined) {
    return project;
  }
  const { [key]: rate, ...kept } = rates;
  const next = updateCard(project, cardId, (node) => withPortRates(node, kept));
  const role = getStorageRoles(next).get(drawer.id);
  if (role !== (output ? "product" : "source") || hasStorageTarget(drawer, role) || !(rate! > 0)) {
    return next;
  }
  return {
    ...next,
    storages: storages.map((storage) =>
      // A source on the board keeps its rate negative.
      storage.id === drawer.id
        ? { ...storage, targetMode: "exact" as const, targetPerSecond: output ? rate : -rate! }
        : storage,
    ),
  };
}

function updateCard(
  project: FactoryProject,
  cardId: string,
  update: (node: FactoryNode) => FactoryNode,
): FactoryProject {
  let changed = false;
  const nodes = project.nodes.map((node) => {
    if (node.id !== cardId) {
      return node;
    }
    const next = update(node);
    changed ||= next !== node;
    return next;
  });
  return changed ? { ...project, nodes } : project;
}

/**
 * A recipe section was removed from a card (`removeRecipeSection`): its rates
 * and spare bearers go, later sections move down one (section 0 removed makes
 * section 1 the card's own).
 */
export function renumberAfterSectionRemoved(
  project: FactoryProject,
  cardId: string,
  removed: number,
): FactoryProject {
  const mapSection = (section: number) =>
    section === removed ? undefined : section > removed ? section - 1 : section;
  const next = updateCard(project, cardId, (node) =>
    node.portRates ? withPortRates(node, mapPortRates(node.portRates, mapSection)) : node,
  );
  return withSpare(
    next,
    mapSpareShares(next.spareShares, (solveId) => {
      const { nodeId, section } = parseSectionNodeId(solveId);
      if (nodeId !== cardId) {
        return solveId;
      }
      const to = mapSection(section);
      return to === undefined ? undefined : sectionNodeId(cardId, to);
    }),
  );
}

/** Two sections of a card swapped places (`moveRecipeSection`). */
export function renumberAfterSectionsSwapped(
  project: FactoryProject,
  cardId: string,
  a: number,
  b: number,
): FactoryProject {
  const swap = (section: number) => (section === a ? b : section === b ? a : section);
  const next = updateCard(project, cardId, (node) =>
    node.portRates ? withPortRates(node, mapPortRates(node.portRates, swap)) : node,
  );
  return withSpare(
    next,
    mapSpareShares(next.spareShares, (solveId) => {
      const { nodeId, section } = parseSectionNodeId(solveId);
      return nodeId === cardId ? sectionNodeId(cardId, swap(section)) : solveId;
    }),
  );
}

/**
 * Cards were combined into a host (`combineNodesIntoMachine`): `moved` maps
 * each absorbed card to where its sections went on the host. Their rates and
 * spare bearers follow. Call it with the project from BEFORE the combine, then
 * apply the combine to the result (the absorbed cards must still be there to
 * read their rates).
 */
export function rehomeSectionFields(
  project: FactoryProject,
  hostId: string,
  moved: ReadonlyMap<string, ReadonlyMap<number, number>>,
): FactoryProject {
  let next = project;
  const carried: Record<string, number> = {};
  for (const node of project.nodes) {
    const sectionMap = moved.get(node.id);
    if (!sectionMap || !node.portRates) {
      continue;
    }
    for (const [handleId, value] of Object.entries(node.portRates)) {
      const { section, handleId: bare } = splitSectionHandleId(handleId);
      const to = sectionMap.get(section);
      if (to !== undefined && bare) {
        carried[sectionHandleId(to, bare)] = value;
      }
    }
  }
  if (Object.keys(carried).length > 0) {
    next = updateCard(next, hostId, (host) => withPortRates(host, { ...host.portRates, ...carried }));
  }
  return withSpare(
    next,
    mapSpareShares(next.spareShares, (solveId) => {
      const { nodeId, section } = parseSectionNodeId(solveId);
      const sectionMap = moved.get(nodeId);
      if (!sectionMap) {
        return solveId;
      }
      const to = sectionMap.get(section);
      return to === undefined ? undefined : sectionNodeId(hostId, to);
    }),
  );
}
