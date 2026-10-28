import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { parseRateInput } from "./rail-math";
import { LIVE_TYPE_MS } from "../clean-model";
import { tipProps, type TipContent } from "./rail-tip";
import { playEditSfx, sfxClick, sfxTick } from "@/lib/sound/sfx";

/**
 * The small controls every rail row shares: the rule key (`~ = >= <=`) and the
 * rate box with its inline editor. They look like the mod's drawer controls:
 * a dark key with the mark in the middle, a sunken box with the figure in gold.
 * Fonts live on spans (the global `button { font: inherit }` trap), the
 * controls are `div role=button`.
 */

export type WheelHandler = (direction: 1 | -1, ctrl: boolean, shift: boolean) => void;

const wheelHandlers = new WeakMap<Element, WheelHandler>();

/** The wheel handler of the control under `target`, if it is on one. */
export function wheelHandlerFor(target: EventTarget | null): WheelHandler | undefined {
  if (!(target instanceof Element)) return undefined;
  const control = target.closest("[data-wheel]");
  return control ? wheelHandlers.get(control) : undefined;
}

/**
 * Keeps a control's wheel handler for the rail's one wheel listener. Every step ticks first (up a little higher, down
 * a little lower) and claims the edit, so the board's change sound does not play on top.
 */
function wheelRef(handler: WheelHandler | undefined) {
  return (element: HTMLElement | null) => {
    if (!element || !handler) return;
    wheelHandlers.set(element, (direction, ctrl, shift) => {
      playEditSfx("ui.tick", 1, direction > 0 ? 1.12 : 0.9);
      handler(direction, ctrl, shift);
    });
  };
}

/** Stops the middle button from starting the browser's autoscroll. */
const noAutoscroll = (event: MouseEvent) => {
  if (event.button === 1) event.preventDefault();
};

export function RuleKey({
  mark,
  tone,
  tip,
  onClick,
  onContext,
  onMiddle,
  onWheel,
  label,
}: {
  mark: string;
  /** gold = a rule in force, muted = Any / the plan decides */
  tone: "gold" | "muted";
  tip: () => TipContent;
  onClick?: (event: MouseEvent) => void;
  onContext?: (event: MouseEvent) => void;
  onMiddle?: (event: MouseEvent) => void;
  onWheel?: WheelHandler;
  label: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className="rail-rule"
      data-tone={tone}
      data-wheel={onWheel ? "" : undefined}
      // Sounds for itself: its click here, its wheel steps in wheelRef.
      data-sfx-own=""
      ref={wheelRef(onWheel)}
      {...tipProps(`rule|${label}`, tip)}
      onMouseDown={noAutoscroll}
      onClick={(event) => {
        // A control on a row is its own thing: the row's click (walk the cards) is not for it.
        event.stopPropagation();
        if (onClick) sfxClick();
        onClick?.(event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContext?.(event);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.stopPropagation();
        if (!onMiddle) return;
        // A clear: the board's unpin sound when a rule was in force, claimed so its change sound does not double it.
        if (tone === "gold") playEditSfx("board.unpin");
        onMiddle(event);
      }}
    >
      <span>{mark}</span>
    </div>
  );
}

export function RateBox({
  text,
  placeholder = "Set",
  gold,
  unmet,
  editing,
  initial,
  onStartEdit,
  onCommit,
  onCancel,
  onMiddle,
  onWheel,
  onWheelDraft,
  onLive,
  onRevert,
  tip,
  label,
  width,
}: {
  /** What the box shows when it has a value (final string). */
  text: string;
  placeholder?: string;
  /** A value is in force: shown in gold. Otherwise the placeholder in grey. */
  gold: boolean;
  unmet?: boolean;
  editing: boolean;
  /** The text the editor starts with. */
  initial: string;
  onStartEdit: () => void;
  /** Called with the parsed number; 0 for an empty field (clear). Not called for unparseable text. */
  onCommit: (value: number) => void;
  onCancel: () => void;
  onMiddle?: () => void;
  onWheel?: WheelHandler;
  /** The wheel over the open box: the text it holds after one step (set when the box is let go of, or at once with `onLive`). */
  onWheelDraft?: DraftWheel;
  /**
   * Sets what the open box holds as it goes: each wheel step at once, typing once it rests, never an emptied box
   * (that is a number being retyped). Without it nothing is set until the box is let go of.
   */
  onLive?: (value: number) => void;
  /** Escape after `onLive` has set something: put back what was there when the box opened. */
  onRevert?: () => void;
  tip: () => TipContent;
  label: string;
  width?: number;
}) {
  const style = width ? { width } : undefined;
  if (editing) {
    return (
      <RateEditor
        initial={initial}
        onCommit={onCommit}
        onCancel={onCancel}
        onWheelDraft={onWheelDraft}
        onLive={onLive}
        onRevert={onRevert}
        style={style}
        label={label}
      />
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className="rail-box"
      data-set={gold ? "" : undefined}
      data-unmet={unmet ? "" : undefined}
      data-wheel={onWheel ? "" : undefined}
      // Sounds for itself: its click here, its wheel steps in wheelRef.
      data-sfx-own=""
      style={style}
      ref={wheelRef(onWheel)}
      {...tipProps(`box|${label}`, tip)}
      onMouseDown={noAutoscroll}
      onClick={(event) => {
        event.stopPropagation();
        sfxClick();
        onStartEdit();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.stopPropagation();
        if (!onMiddle) return;
        // A clear: the board's unpin sound when a value was set, claimed so its change sound does not double it.
        if (gold) playEditSfx("board.unpin");
        onMiddle();
      }}
    >
      <span>{gold ? text : placeholder}</span>
    </div>
  );
}

/** One wheel step over an open box: the text it holds now, to the text it holds after. */
export type DraftWheel = (text: string, direction: 1 | -1, ctrl: boolean, shift: boolean) => string;

function RateEditor({
  initial,
  onCommit,
  onCancel,
  onWheelDraft,
  onLive,
  onRevert,
  style,
  label,
}: {
  initial: string;
  onCommit: (value: number) => void;
  onCancel: () => void;
  onWheelDraft?: DraftWheel;
  onLive?: (value: number) => void;
  onRevert?: () => void;
  style?: { width: number };
  label: string;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // Read through refs: the wheel handler and the typing timer outlive the render that made them.
  const text = useRef(initial);
  const live = useRef({ onLive, onWheelDraft });
  live.current = { onLive, onWheelDraft };
  const sent = useRef(false);
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);
  const send = (raw: string, clear: boolean) => {
    const set = live.current.onLive;
    if (!set) return;
    const trimmed = raw.trim();
    const parsed = trimmed === "" ? 0 : parseRateInput(trimmed);
    if (parsed === undefined || !(parsed >= 0) || (parsed === 0 && !clear)) return;
    sent.current = true;
    set(parsed);
  };
  // The rail's one wheel listener finds the open box by `data-wheel` and steps what it holds. With `onLive` each step
  // is set at once; without it nothing is set until the box is let go of, and Escape drops the steps with the typing.
  useEffect(() => {
    const element = input.current;
    if (!element || !onWheelDraft) return undefined;
    wheelHandlers.set(element, (direction, ctrl, shift) => {
      sfxTick(direction > 0);
      clearTimeout(typing.current);
      const next = live.current.onWheelDraft!(text.current, direction, ctrl, shift);
      text.current = next;
      setValue(next);
      send(next, true);
    });
    return () => {
      wheelHandlers.delete(element);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWheelDraft !== undefined]);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    clearTimeout(typing.current);
    if (!commit) {
      if (sent.current) onRevert?.();
      onCancel();
      return;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      onCommit(0);
      return;
    }
    const parsed = parseRateInput(trimmed);
    if (parsed === undefined || !(parsed >= 0)) onCancel();
    else onCommit(parsed);
  };
  return (
    <input
      ref={input}
      className="rail-box rail-box-edit"
      style={style}
      aria-label={`${label} (type a number: 2.5k, 1M, 1/3)`}
      value={value}
      inputMode="decimal"
      spellCheck={false}
      data-wheel={onWheelDraft ? "" : undefined}
      onChange={(event) => {
        const next = event.target.value;
        text.current = next;
        setValue(next);
        if (!onLive) return;
        clearTimeout(typing.current);
        typing.current = setTimeout(() => send(next, false), LIVE_TYPE_MS);
      }}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
    />
  );
}

/** A flat key (Split, Auto, Avg, Peak, fold). */
export function RailKey({
  children,
  onClick,
  onContext,
  disabled,
  tip,
  label,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  onContext?: () => void;
  disabled?: boolean;
  tip?: () => TipContent;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={`rail-key ${className}`}
      data-disabled={disabled ? "" : undefined}
      {...(tip ? tipProps(`key|${label}`, tip) : {})}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick?.();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) (onContext ?? onClick)?.();
      }}
    >
      <span>{children}</span>
    </div>
  );
}
