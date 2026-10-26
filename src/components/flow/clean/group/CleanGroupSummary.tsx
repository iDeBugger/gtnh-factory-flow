"use client";

import "../clean.css";
import "./group.css";
import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { formatCompact } from "@/lib/model/resources";
import { powerDisplayFromEuT, powerDisplaySuffix, rateMultiplierForKind, rateSuffixForKind } from "@/lib/model/rate-unit";
import { useFactoryStore, useRateDisplayUnits } from "@/store/factory-store";
import { POCKET_CARD_SOURCE_HANDLE, POCKET_CARD_TARGET_HANDLE, type PocketFlowNode } from "../../board-node-types";
import { useClickSlop } from "../interaction/click-slop";
import { tipAttrs } from "../interaction/tip-spec";
import { ResourceGlyph } from "../rail/OverviewRail";
import { groupStyle, GroupName } from "./CleanGroupFrame";
import { GROUP, groupColorTag, groupColors, machinesText } from "./group-model";
import type { GroupFlow, GroupSummary } from "./group-summary";

/** A rate as the overview prints it: the board's unit, the same number format. */
function rateText(flow: GroupFlow): string {
  const shown = flow.perSecond * rateMultiplierForKind(flow.kind);
  return `${formatCompact(shown)}${rateSuffixForKind(flow.kind)}`;
}

function Cell({ flow, side }: { flow: GroupFlow; side: "in" | "out" }) {
  return (
    <div
      className={`cg-cell cg-${side}`}
      {...tipAttrs({
        id: `group|${side}|${flow.key}`,
        title: flow.resource.displayName ?? flow.resourceId,
        sub: side === "in" ? `Goes in: ${rateText(flow)}` : `Comes out: ${rateText(flow)}`,
      })}
    >
      <ResourceGlyph line={{ resource: flow.resource, energy: false }} />
      <span>{rateText(flow)}</span>
    </div>
  );
}

/**
 * A COLLAPSED group on a plan board (docs/groups.md): a summary card a card wide at the frame's corner. The title strip
 * (name, machines, the expand key), a line with the machines and EU/t, then what goes in (left) and comes out (right),
 * all from the plan-wide solve. Wires between its members and the rest dock on it (the old minimized board's inert
 * handles), so the router and the edge building are unchanged.
 */
function CleanGroupSummaryComponent({ data, selected }: NodeProps<PocketFlowNode>) {
  useRateDisplayUnits();
  const { pocket } = data;
  const summary = data.groupSummary as GroupSummary | undefined;
  const expandPocket = useFactoryStore((state) => state.expandPocket);
  const slop = useClickSlop();
  const colors = groupColors(groupColorTag(pocket));
  const machines = summary?.machines ?? 0;
  const count = machinesText(machines);
  const eu = summary && summary.euT > 0 ? `${formatCompact(powerDisplayFromEuT(summary.euT))} ${powerDisplaySuffix()}` : "";
  const line = [count || "No machines", eu].filter(Boolean).join("  ");
  const inputs = summary?.inputs ?? [];
  const outputs = summary?.outputs ?? [];
  const rows = Math.max(inputs.length, outputs.length);

  return (
    <div
      className="cg-sum"
      data-group-summary={pocket.id}
      data-node-glance-root=""
      data-selected={selected ? "" : undefined}
      style={{ width: GROUP.width, ...groupStyle(colors) }}
      onPointerDownCapture={slop.onPointerDownCapture}
    >
      <Handle
        id={POCKET_CARD_TARGET_HANDLE}
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="cg-anchor"
      />
      <Handle
        id={POCKET_CARD_SOURCE_HANDLE}
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="cg-anchor"
      />
      <div
        className="cg-strip"
        data-group-strip=""
        {...tipAttrs({
          id: `${pocket.id}|strip`,
          title: pocket.name,
          ...(count ? { sub: count } : {}),
          actions: [
            { input: "drag", label: "Move the group" },
            { input: "left", label: "Rename (on the name)" },
            { input: "right", label: "Group menu" },
          ],
        })}
      >
        <GroupName pocketId={pocket.id} name={pocket.name} wasClick={slop.wasClick} />
        <div
          role="button"
          aria-label="Expand"
          className="cg-key"
          data-plus=""
          data-group-key="expand"
          {...tipAttrs({ id: `${pocket.id}|expand`, title: "Expand", actions: [{ input: "left", label: "Expand" }] })}
          onClick={(event) => {
            if (!slop.wasClick(event)) return;
            event.stopPropagation();
            expandPocket(pocket.id);
          }}
        />
      </div>
      <div className="cg-line">{line}</div>
      <div className="cg-rows">
        {rows === 0 ? <div className="cg-cell cg-empty">Nothing goes in or out.</div> : null}
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} style={{ display: "contents" }}>
            {inputs[index] ? <Cell flow={inputs[index]!} side="in" /> : <div className="cg-cell cg-in" />}
            {outputs[index] ? <Cell flow={outputs[index]!} side="out" /> : <div className="cg-cell cg-out" />}
          </div>
        ))}
      </div>
    </div>
  );
}

export const CleanGroupSummary = memo(
  CleanGroupSummaryComponent,
  (previous, next) => previous.data === next.data && previous.selected === next.selected,
);
