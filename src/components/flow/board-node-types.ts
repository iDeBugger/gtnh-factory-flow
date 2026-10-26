import type { Node } from "@xyflow/react";
import type {
  FactoryAnnotation,
  FactoryNode,
  FactoryPocket,
  FactoryStorage,
  NodeThroughputResult,
  Recipe,
  StorageThroughputResult,
} from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import type { GroupSummary } from "./clean/group/group-summary";

/** What FactoryFlow hands every node type it registers. */
export interface RecipeNodeData extends Record<string, unknown> {
  projectNode: FactoryNode;
  recipe: Recipe;
  result?: NodeThroughputResult;
}

export type RecipeFlowNode = Node<RecipeNodeData, "recipeNode">;

export interface StorageNodeData extends Record<string, unknown> {
  storage: FactoryStorage;
  result?: StorageThroughputResult;
}

export type StorageFlowNode = Node<StorageNodeData, "storageNode">;

/** An open group: its frame, whose members render inside it as React Flow children. */
export interface BoardNodeData extends Record<string, unknown> {
  pocket: FactoryPocket;
  /** Direct members in the frame: cards, drawers, ink, nested groups. */
  memberCount: number;
  /** Machines in the frame (docs/groups.md, "What the summary says"). */
  machines?: number;
}

export type BoardWindowFlowNode = Node<BoardNodeData, "boardNode">;

/** A collapsed group: its summary card. */
export interface PocketNodeData extends Record<string, unknown> {
  pocket: FactoryPocket;
  groupSummary?: GroupSummary;
}

export type PocketFlowNode = Node<PocketNodeData, "pocketNode">;

export interface AnnotationNodeData extends Record<string, unknown> {
  annotation: FactoryAnnotation;
}

export type AnnotationFlowNode = Node<AnnotationNodeData, "annotationNode">;

/** The title strip is the only place a drag can grab an open group's frame. */
export const BOARD_DRAG_HANDLE_CLASS = "board-window-grab";

/** An open group's frame line, in px: wires are kept off it like off a card's edge. */
export const BOARD_EDGE = 4;

/**
 * The inert anchors every wire crossing into a collapsed group lands on. React Flow needs an endpoint handle for an
 * edge to render at all; these have no size, take no pointer, and mean nothing beyond "the wire ends at this card".
 */
export const POCKET_CARD_TARGET_HANDLE = "board-card-in";
export const POCKET_CARD_SOURCE_HANDLE = "board-card-out";

/**
 * Drawings set `pointerEvents: none` on their node wrapper so the empty interior stays click-through (a box drawn
 * around machines must not swallow their clicks). Only elements carrying this class stay interactive, and the same
 * selector doubles as the React Flow `dragHandle`.
 */
export const ANNOTATION_DRAG_HANDLE_CLASS = "annotation-drag-handle";

/**
 * CHECKLIST MODE is a tally, not an editor: while it is on, every wheel knob on a card is dead and the port rows stop
 * lighting their flow; the board only shows what a click would mark (checklist.css). Read at event time, so no card
 * subscribes to the mode and nothing re-renders when it flips.
 */
export const checklistLocked = () => useFactoryStore.getState().checklistMode;
