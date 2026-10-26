"use client";

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import type { AnnotationFlowNode } from "../../board-node-types";
import { CleanDrawing } from "./CleanDrawing";
import { StickyNote, type StickyNoteFlowNode } from "./StickyNote";

/**
 * What FactoryFlow registers as `annotationNode`: a text annotation is a sticky note, drawn as the mod draws it, and
 * a box, zone or arrow is `CleanDrawing` (docs/annotations.md). A picture is kept in the data and shown nowhere.
 */
function AnnotationSwitchComponent(props: NodeProps<AnnotationFlowNode>) {
  if (props.data.annotation.kind === "text") {
    return <StickyNote {...(props as unknown as NodeProps<StickyNoteFlowNode>)} />;
  }
  if (props.data.annotation.kind === "image") {
    return null;
  }
  return <CleanDrawing {...props} />;
}

export const AnnotationSwitch = memo(AnnotationSwitchComponent);
