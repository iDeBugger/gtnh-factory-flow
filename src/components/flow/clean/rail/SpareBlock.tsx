import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ResourceIcon } from "@/components/nei/ResourceIcon";
import { formatCompact } from "@/lib/model/resources";
import { rateMultiplierForKind, rateSuffixForKind } from "@/lib/model/rate-unit";
import { useFactoryStore, useRateDisplayUnits } from "@/store/factory-store";
import { mixHex } from "../colors";
import { CC } from "../tokens";
import {
  clearSpare,
  currentProject,
  endSpareDrag,
  frameCards,
  previewSpare,
  putSpareAt,
  splitSpareEvenly,
} from "./rail-actions";
import { RailKey } from "./rail-controls";
import { nudged, SHARE_SHOWN, sameShares, shareAtX } from "./rail-math";
import { tipProps, type TipContent } from "./rail-tip";
import type { SpareBearerView, SpareView } from "./spare-model";

/**
 * One leftover and the places that could bear it (UI spec section 9; the mod's
 * `SpareBar`): a head "Forced" with Split and Auto keys, then a line per place
 * with its icon, name, what it bears and a bar of its share. A click on a line
 * puts all of it there; a press on the bar takes it, the share following the
 * pointer in fiftieths while the plan re-solves with no undo step, one undoable
 * edit when it is let go. Used in the overview and in the card's popup.
 */

export const SPARE_BAR_W = 62;

const SURFACE = CC.surface;

function inkOf(spare: SpareView): string {
  return spare.importing ? CC.source : CC.product;
}

/** Whether two places share a name (then the machine says which). */
function labelOf(spare: SpareView, b: SpareBearerView, here: string | undefined): string {
  const same = spare.bearers.filter((o) => o.name === b.name).length;
  return `${same > 1 ? b.machine : b.name}${b.key === here ? " (here)" : ""}`;
}

function amountOf(b: SpareBearerView, share: number): string {
  return formatCompact(share * b.max * rateMultiplierForKind(b.resource.kind));
}

export function setScopeOfPlace(b: SpareBearerView | undefined): void {
  const store = useFactoryStore.getState();
  if (!b) {
    store.setHoveredFlowScope(undefined);
    return;
  }
  const ports: Record<string, true> = {};
  const nodes: Record<string, true> = {};
  for (const port of b.ports) {
    ports[`${port.nodeId}|${port.handle}`] = true;
    nodes[port.nodeId] = true;
  }
  store.setHoveredFlowScope({ edges: {}, ports, nodes });
}

function placeTip(spare: SpareView, b: SpareBearerView, share: number, bar: boolean): TipContent {
  const choice = spare.bearers.length > 1;
  const unit = rateSuffixForKind(b.resource.kind).trim();
  return {
    title: `${b.name} at ${b.machine}`,
    sub: spare.importing ? "Forced input" : "Forced output",
    rows: [
      [spare.importing ? "Comes in here" : "Ships out here", `${amountOf(b, share)} ${unit}`],
      ["All of it would be", `${amountOf(b, 1)} ${unit}`],
    ],
    notes: [
      {
        text: spare.importing
          ? "The plan brings this in at a port with no drawer."
          : "The plan sends this out at a port with no drawer.",
        tone: "muted",
      },
    ],
    actions: [
      ...(choice
        ? [
            {
              input: "left" as const,
              label: bar
                ? "Fill the bar to here"
                : spare.importing
                  ? "Bring it all in here"
                  : "Ship it all out here",
            },
          ]
        : []),
      { input: "middle", label: "Go to its card" },
    ],
  };
}

function headTip(spare: SpareView): TipContent {
  const n = spare.bearers.length;
  const name = spare.bearers[0]?.name ?? "";
  return {
    title: spare.importing ? "Forced inputs" : "Forced outputs",
    sub: name,
    notes: [
      {
        text: spare.importing
          ? `The plan has to bring ${name} in, and ${n} places could take it.`
          : `The plan has ${name} to send out, and ${n} places could ship it.`,
        tone: "muted",
      },
      {
        text: "Pull the bars to choose, or Split it evenly. Auto goes back to the plan's own pick.",
        tone: "muted",
      },
    ],
  };
}

export function SpareBlock({
  spare,
  here,
  popup = false,
  width,
  onHoverPlace,
}: {
  spare: SpareView;
  /** The place whose row was clicked on a card, marked "(here)". */
  here?: string;
  popup?: boolean;
  width?: number;
  onHoverPlace?: (index: number | null) => void;
}) {
  useRateDisplayUnits();
  const ink = inkOf(spare);
  const drag = useRef<{
    index: number;
    shares: number[];
    start: number[];
    base: ReturnType<typeof currentProject>;
    left: number;
    width: number;
  } | null>(null);
  const [dragShares, setDragShares] = useState<number[] | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const shares = dragShares ?? spare.shares;

  const hover = (index: number | null) => {
    setHot(index);
    setScopeOfPlace(index === null ? undefined : spare.bearers[index]);
    onHoverPlace?.(index);
  };

  const follow = (event: ReactPointerEvent, index: number) => {
    const state = drag.current;
    if (!state) return;
    const share = shareAtX(event.clientX, state.left, state.width);
    if (Math.abs(share - state.shares[index]!) < 1e-9) return;
    state.shares = nudged(state.shares, index, share - state.shares[index]!);
    setDragShares(state.shares);
    previewSpare(spare, state.shares);
  };

  const vars = {
    "--sp-ink": ink,
    "--sp-fill": mixHex(ink, SURFACE, 0.45),
    "--sp-hi": mixHex(ink, SURFACE, 0.7),
    "--sp-tint": `${ink}0D`,
    ...(width ? { width } : {}),
  } as CSSProperties;

  return (
    <div
      className="rail-spare"
      data-popup={popup ? "" : undefined}
      style={vars}
      data-spare={spare.key}
    >
      <div className="rail-spare-head">
        <span
          className="rail-spare-title"
          {...tipProps(`spare-head|${spare.key}`, () => headTip(spare))}
        >
          Forced
        </span>
        <RailKey
          label="Split"
          onClick={() => splitSpareEvenly(spare)}
          tip={() => ({
            title: "Split",
            actions: [{ input: "left", label: "Share it evenly between them" }],
          })}
        >
          Split
        </RailKey>
        <RailKey
          label="Auto"
          disabled={!spare.custom}
          onClick={() => clearSpare(spare)}
          tip={() => ({
            title: "Auto",
            actions: [{ input: "left", label: "Back to the plan's own pick" }],
          })}
        >
          Auto
        </RailKey>
      </div>
      {spare.bearers.map((b, i) => {
        const share = shares[i] ?? 0;
        const on = share > SHARE_SHOWN;
        const unit = rateSuffixForKind(b.resource.kind);
        const energy = b.energy;
        return (
          <div
            key={b.key}
            className="rail-spare-row"
            data-hot={hot === i ? "" : undefined}
            data-off={on ? undefined : ""}
            {...tipProps(`spare|${spare.key}|${b.key}`, () => placeTip(spare, b, share, false), {
              enter: () => hover(i),
              leave: () => hover(null),
            })}
            onClick={() => {
              if (drag.current) return;
              putSpareAt(spare, i);
            }}
            onAuxClick={(event) => {
              if (event.button === 1) frameCards([b.nodeId]);
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
          >
            <span className="rail-spare-icon">
              <ResourceIcon
                resource={{ ...b.resource, amount: 1 }}
                size="sm"
                showAmount={false}
                bare
                tooltip={false}
                className="!h-full !w-full"
              />
            </span>
            <span className="rail-spare-name">{labelOf(spare, b, here)}</span>
            {on ? (
              <span className="rail-spare-amount">
                {spare.importing ? "-" : "+"}
                {amountOf(b, share)}
                {energy ? <i> EU/t</i> : null}
              </span>
            ) : null}
            <div
              className="rail-spare-bar"
              data-unit={unit}
              {...tipProps(`spare-bar|${spare.key}|${b.key}`, () =>
                placeTip(spare, b, share, true),
              )}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                drag.current = {
                  index: i,
                  shares: [...spare.shares],
                  start: [...spare.shares],
                  base: currentProject(),
                  left: rect.left,
                  width: rect.width,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                follow(event, i);
              }}
              onPointerMove={(event) => follow(event, i)}
              onPointerUp={(event) => {
                const state = drag.current;
                if (!state) return;
                event.currentTarget.releasePointerCapture(event.pointerId);
                const moved = !sameShares(state.shares, state.start);
                endSpareDrag(state.base, moved);
                // Let go after the click that follows the release has passed.
                setTimeout(() => {
                  drag.current = null;
                }, 0);
                setDragShares(null);
              }}
              onPointerCancel={() => {
                const state = drag.current;
                if (state) endSpareDrag(state.base, false);
                drag.current = null;
                setDragShares(null);
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {on ? <span style={{ width: Math.max(2, share * SPARE_BAR_W) }} /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
