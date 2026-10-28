import { Position } from "@xyflow/react";
import { carriedHome } from "./accept";

export type WireVerdict = "connect" | "spawn" | "refuse" | "dead";

/** The line's path: three orthogonal segments, the bend at max(sx + 16, (sx + mx) / 2) on the port's own side. */
export function verdictPath(
  from: { x: number; y: number; position: Position },
  to: { x: number; y: number },
): string {
  const dir = from.position === Position.Left ? -1 : 1;
  const mid = (from.x + to.x) / 2;
  const bend = dir > 0 ? Math.max(from.x + 16, mid) : Math.min(from.x - 16, mid);
  return `M${from.x},${from.y} H${bend} V${to.y} H${to.x}`;
}

const GO = "#22c55e";
const NO = "#ef4444";

/**
 * The wire in hand in the clean look (spec 5): 3 px, green where letting go
 * wires (solid) or makes a drawer (dotted), red where it does nothing (solid
 * over a card that refuses, dotted over the void with a drawer already there,
 * with its reason beside the pointer). The board's own line computes the
 * verdict; this draws it.
 */
export function CleanVerdictLine({
  from,
  to,
  pointer,
  verdict,
}: {
  from: { x: number; y: number; position: Position };
  to: { x: number; y: number };
  pointer: { x: number; y: number };
  verdict: WireVerdict;
}) {
  // A picked-up port carried back over its own card snaps home: shown just as it was, no line, no green.
  if (carriedHome()) return <g className="react-flow__connection" data-verdict="home" />;
  const color = verdict === "connect" || verdict === "spawn" ? GO : NO;
  const dotted = verdict === "spawn" || verdict === "dead";
  return (
    <g className="react-flow__connection" data-verdict={verdict}>
      <path
        d={verdictPath(from, to)}
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeLinecap={dotted ? "round" : "butt"}
        strokeDasharray={dotted ? "0.1 6" : undefined}
      />
      {verdict === "dead" ? (
        <text x={pointer.x + 8} y={pointer.y + 6 + 12} fill={NO} fontSize={12} fontFamily="var(--app-font, sans-serif)">
          Drawer already exists
        </text>
      ) : null}
    </g>
  );
}
