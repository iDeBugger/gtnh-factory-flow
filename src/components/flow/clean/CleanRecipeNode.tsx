import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import type { RecipeFlowNode, RecipeNodeData } from "../board-node-types";
import { useRenderedHandles } from "../use-rendered-handles";
import { CleanCard } from "./CleanCard";
import { useCleanCardModel } from "./clean-model";
import { CardShell, DrawnSync, useVirtualPhase } from "../virtual/VirtualCard";
import { useCardFace, useCardLayoutKey } from "../virtual/use-card-face";
import { SpecialCleanNode } from "./special/SpecialNode";
import { specialKindOf } from "./special/special-model";

/** The card itself; it exists only while the card is near the screen (virtual/VirtualCard.tsx). */
function MountedCleanCard({ data, selected }: { data: RecipeNodeData; selected: boolean }) {
  const { view, actions, context } = useCleanCardModel(data, selected);
  // React Flow measures handles at mount; re-measure when the set of rendered ids changes.
  useRenderedHandles(data.projectNode.id, context.handleIds);
  const layoutKey = useCardLayoutKey(data);
  return (
    <>
      <CleanCard view={view} actions={actions} context={context} recipe={data.recipe} node={data.projectNode} />
      <DrawnSync nodeId={data.projectNode.id} layoutKey={layoutKey} />
    </>
  );
}

/** A card away from the screen: its shell, from the light face (no rails, no verdict). */
function ShellOfCleanCard({ data, selected, far }: { data: RecipeNodeData; selected: boolean; far: boolean }) {
  const { face, layoutKey } = useCardFace(data, selected);
  return <CardShell nodeId={data.projectNode.id} face={face} layoutKey={layoutKey} far={far} />;
}

function CleanRecipeNodeComponent({ data, selected }: { data: RecipeNodeData; selected: boolean }) {
  const phase = useVirtualPhase(data.projectNode.id, selected);
  return phase === 2 ? (
    <MountedCleanCard data={data} selected={selected} />
  ) : (
    <ShellOfCleanCard data={data} selected={selected} far={phase === 0} />
  );
}

/**
 * The recipe card of every board: always the clean look. A node the plain card cannot be (shared machines,
 * generators, the custom rate and fluid tank holders) is `SpecialCleanNode`; everything else is the plain card.
 * Registered as `recipeNode` in FactoryFlow.
 */
function RecipeNodeSwitchComponent(props: NodeProps<RecipeFlowNode>) {
  const { data, selected } = props;
  const kind = specialKindOf(data.recipe, data.projectNode);
  if (kind) return <SpecialCleanNode kind={kind} data={data} selected={selected === true} />;
  return <CleanRecipeNodeComponent data={data} selected={selected === true} />;
}

export const RecipeNodeSwitch = memo(
  RecipeNodeSwitchComponent,
  (previous, next) => previous.data === next.data && previous.selected === next.selected,
);
