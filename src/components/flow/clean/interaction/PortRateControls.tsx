import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import { startPromptClock } from "../../virtual/prompt-phase";
import { formatSlotRateBare } from "../../flow-explainers";
import { rateMultiplierForKind } from "@/lib/model/rate-unit";
import { useFactoryStore } from "@/store/factory-store";
import { formatAmountWithSuffix } from "../../rate-rule";
import type { CleanPortView } from "../clean-model";
import { parseRateText, portRatePatch, stepShownRate } from "./port-rate";
import { openBoxTip, openKeyTip } from "./tips";
import { tipAttrs } from "./tip-spec";
import { playEditSfx } from "@/lib/sound/sfx";
import { wheelChangesValues } from "@/lib/device-settings";

function locked(): boolean {
  const state = useFactoryStore.getState();
  return state.isReadOnly || state.checklistMode;
}

/** Sets or clears the rate an open port is held to. */
export function setPortRate(nodeId: string, handleId: string, perSecond: number | undefined): void {
  if (locked()) return;
  const state = useFactoryStore.getState();
  const node = state.project.nodes.find((entry) => entry.id === nodeId);
  if (!node) return;
  state.updateNode(nodeId, portRatePatch(node, handleId, perSecond));
}

/**
 * The rule key and rate box of an unwired port (spec 2.5): a port with no wire
 * and no drawer is an end of the plan. The key goes Any <-> `=` (at the rate it
 * runs at now), the box types a rate (`2.5k`, `1/3`), the wheel steps it, a
 * middle click clears. The plan holds the port to its rate (`portRates`).
 */
export function PortRateControls({
  p,
  unset,
  wasClick,
}: {
  p: CleanPortView;
  unset: boolean;
  wasClick: (event: MouseEvent) => boolean;
}) {
  const [draft, setDraft] = useState<string>();
  const cancelled = useRef(false);
  const kind = p.port.kind;
  const pinned = p.rate !== undefined;
  const scale = rateMultiplierForKind(kind);
  const now = Math.max(0, p.port.currentPerSecond);
  const prompting = !pinned && unset;
  // The prompt blinks off the board's one clock (virtual/prompt-phase.ts).
  useEffect(() => {
    if (prompting) startPromptClock();
  }, [prompting]);

  const commit = () => {
    if (draft === undefined) return;
    const text = draft;
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(undefined);
      return;
    }
    setDraft(undefined);
    if (text.trim() === "") {
      if (pinned) setPortRate(p.nodeId, p.handleId, undefined);
      return;
    }
    const shown = parseRateText(text);
    if (shown !== undefined) setPortRate(p.nodeId, p.handleId, shown / scale);
  };
  const beginEdit = () => {
    if (locked()) return;
    cancelled.current = false;
    setDraft(pinned ? formatAmountWithSuffix(p.rate! * scale) : "");
  };
  const toggle = () => {
    if (locked()) return;
    if (pinned) setPortRate(p.nodeId, p.handleId, undefined);
    else if (now > 0) setPortRate(p.nodeId, p.handleId, Number(now.toPrecision(6)));
    else beginEdit();
  };
  // The middle button clears the rate. On the click itself: the board's own pointerdown can swallow the mousedown.
  const clearOnMiddle = (event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    setDraft(undefined);
    if (pinned && !locked()) {
      // The board's unpin sound, claimed so its change sound does not play it again.
      playEditSfx("board.unpin");
      setPortRate(p.nodeId, p.handleId, undefined);
    }
  };
  // Never the browser's autoscroll.
  const noAutoscroll = (event: MouseEvent) => {
    if (event.button === 1) event.preventDefault();
  };
  const wheelBox = (event: WheelEvent) => {
    if (locked() || !wheelChangesValues()) return;
    event.stopPropagation();
    const shown = (pinned ? p.rate! : now) * scale;
    const next = stepShownRate(shown, event.deltaY < 0, event);
    // Scrolling down on an empty box asks for nothing.
    if (!pinned && next === undefined) return;
    setPortRate(p.nodeId, p.handleId, next === undefined ? undefined : next / scale);
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="cc-prk nowheel"
        data-wheel-value=""
        data-side={p.side}
        data-mode={pinned ? "exact" : "any"}
        aria-label={pinned ? "Rate set: exactly" : "Rate: any"}
        {...tipAttrs(openKeyTip(p, pinned))}
        onClick={(event) => {
          event.stopPropagation();
          if (wasClick(event)) toggle();
        }}
        onMouseDown={noAutoscroll}
        onAuxClick={clearOnMiddle}
        onWheel={(event) => {
          if (!wheelChangesValues()) return;
          event.stopPropagation();
          if (!locked() && event.deltaY !== 0) toggle();
        }}
      />
      <div
        role="button"
        tabIndex={0}
        className="cc-prb nowheel"
        data-wheel-value=""
        data-side={p.side}
        data-set={pinned ? "" : undefined}
        data-prompt={!pinned && unset ? "" : undefined}
        data-editing={draft !== undefined ? "" : undefined}
        data-unit={pinned ? p.unit : undefined}
        {...tipAttrs(openBoxTip(p, pinned))}
        onClick={(event) => {
          event.stopPropagation();
          if (draft === undefined && wasClick(event)) beginEdit();
        }}
        onMouseDown={noAutoscroll}
        onAuxClick={clearOnMiddle}
        onWheel={wheelBox}
      >
        {draft !== undefined ? (
          <input
            autoFocus
            value={draft}
            aria-label={`Rate of ${p.name}`}
            className="nodrag"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onFocus={(event) => event.currentTarget.select()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                cancelled.current = true;
                setDraft(undefined);
              }
              event.stopPropagation();
            }}
          />
        ) : pinned ? (
          formatSlotRateBare(p.rate!, kind)
        ) : (
          "Set"
        )}
      </div>
    </>
  );
}
