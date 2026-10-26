"use client";

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { useFactoryStore } from "@/store/factory-store";
import { storageRoleFor, type StorageRole } from "@/lib/model/storage-role";
import type { StorageFlowNode } from "../../board-node-types";
import { CleanDrawer } from "./CleanDrawer";

/**
 * Which sides of each drawer are wired, for the whole edge list at once (bit 1 an edge into it, bit 2 one out of
 * it). Every drawer asks this on every store update, which was a scan of every wire per drawer: 500 drawers and
 * 2,400 wires were a million comparisons for each hover. The list is replaced on every edit, so it is the key.
 */
const wiredSides = new WeakMap<object, Map<string, number>>();
function wiredSidesOf(edges: ReadonlyArray<{ source: string; target: string }>, id: string): number {
  let index = wiredSides.get(edges);
  if (!index) {
    index = new Map();
    for (const edge of edges) {
      index.set(edge.target, (index.get(edge.target) ?? 0) | 1);
      // (As the scan this replaces: an edge into the drawer from itself counts for the side in only.)
      if (edge.source !== edge.target) index.set(edge.source, (index.get(edge.source) ?? 0) | 2);
    }
    wiredSides.set(edges, index);
  }
  return index.get(id) ?? 0;
}

/**
 * The drawer of every board (source, product, byproduct, trash, buffer, and EU as a source or product), in the role
 * its wires give it. Registered as `storageNode` in FactoryFlow.
 */
function CleanStorageNodeComponent(props: NodeProps<StorageFlowNode>) {
  const { data, selected } = props;
  const { storage } = data;
  // Read off this drawer's own wires: the whole-board map would re-render every drawer whenever any other drawer's
  // wiring changed.
  const role = useFactoryStore((state): StorageRole => {
    const sides = wiredSidesOf(state.project.edges, storage.id);
    return storageRoleFor(storage, (sides & 1) !== 0, (sides & 2) !== 0, state.project.poolMode === true);
  });
  return <CleanDrawer data={data} selected={selected === true} role={role} />;
}

export const CleanStorageNode = memo(
  CleanStorageNodeComponent,
  (previous, next) => previous.data === next.data && previous.selected === next.selected,
);
