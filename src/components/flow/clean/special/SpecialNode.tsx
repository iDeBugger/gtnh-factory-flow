"use client";

import { memo } from "react";
import type { RecipeNodeData } from "../../board-node-types";
import { useRenderedHandles } from "../../use-rendered-handles";
import { SpecialCard } from "./SpecialCard";
import {
  useCropCardModel,
  useHolderCardModel,
  usePowerCardModel,
  useSharedCardModel,
  type SpecialModel,
} from "./use-special";
import type { SpecialKind } from "./special-model";

function Drawn({ model, data }: { model: SpecialModel; data: RecipeNodeData }) {
  // React Flow measures handles at mount; re-measure when the set of rendered ids changes.
  useRenderedHandles(data.projectNode.id, model.view.handleIds);
  return <SpecialCard model={model} recipe={data.recipe} node={data.projectNode} />;
}

function SharedNode({ data, selected }: { data: RecipeNodeData; selected: boolean }) {
  return <Drawn model={useSharedCardModel(data, selected)} data={data} />;
}

function PowerNode({ data, selected }: { data: RecipeNodeData; selected: boolean }) {
  return <Drawn model={usePowerCardModel(data, selected)} data={data} />;
}

function CustomRateNode({ data, selected }: { data: RecipeNodeData; selected: boolean }) {
  return <Drawn model={useHolderCardModel(data, selected, "custom-rate")} data={data} />;
}

function CropNode({ data, selected }: { data: RecipeNodeData; selected: boolean }) {
  return <Drawn model={useCropCardModel(data, selected)} data={data} />;
}

function TankNode({ data, selected }: { data: RecipeNodeData; selected: boolean }) {
  return <Drawn model={useHolderCardModel(data, selected, "tank")} data={data} />;
}

/** The clean card of a kind the plain one cannot be (`specialKindOf`). */
export const SpecialCleanNode = memo(function SpecialCleanNode({
  kind,
  data,
  selected,
}: {
  kind: SpecialKind;
  data: RecipeNodeData;
  selected: boolean;
}) {
  switch (kind) {
    case "shared":
      return <SharedNode data={data} selected={selected} />;
    case "power":
      return <PowerNode data={data} selected={selected} />;
    case "custom-rate":
      return <CustomRateNode data={data} selected={selected} />;
    case "tank":
      return <TankNode data={data} selected={selected} />;
    case "crop":
      return <CropNode data={data} selected={selected} />;
  }
});
