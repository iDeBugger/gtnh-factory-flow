"use client";
import { useState } from "react";
import type { FactoryStorage, StorageThroughputResult } from "@/lib/model/types";
import type { StorageRole } from "@/lib/model/storage-role";
import { isInputRate, storageTargetMode, type TargetMode } from "@/lib/model/storage-target";
import { trimTrailingDecimalZeros } from "@/lib/model";
import { rateMultiplierForKind } from "@/lib/model/rate-unit";
import { playBoardSound, suppressBoardSound } from "@/lib/board-sounds";
import { hasAnySolveNumbers } from "@/lib/solver/throughput";
import { useFactoryStore } from "@/store/factory-store";

/**
 * A rate rule and your rate, the way a source or product drawer sets them in
 * Solve: a rule BUTTON with a ▾ that opens the four rules in words, and your
 * rate in a sunken BOX you click and type into. Pool's Desired rates borrow
 * the rule button (`useTableRule`), with the word spelled out beside its
 * mark; their Target column keeps its own editor. The resources panel's
 * drawer rows use the drawer's own pair, the rule button wearing its word as
 * in Pool.
 */

/** The rule list, in the order the rule button's wheel steps through it. Any
 * is stored as "ignore": a number can wait there without applying. */
export const RULE_STEPS: TargetMode[] = ["ignore", "at-least", "exact", "at-most"];
export const RULE_MARK: Record<TargetMode, string> = { ignore: "~", "at-least": "≥", exact: "=", "at-most": "≤" };
export const RULE_NAME: Record<TargetMode, string> = { ignore: "Any", "at-least": "At least", exact: "Exactly", "at-most": "At most" };

/**
 * "2.5k" is a number: metric shorthand for the rate field, k / m / g for
 * thousand, million, billion, either case, spaces and commas forgiven.
 * Anything else is not a number and the caller falls back rather than guess.
 */
export function parseAmountWithSuffix(text: string): number | undefined {
  // A fraction of two such numbers is a number too: "1/3", "2.5k/3".
  const slash = text.split("/");
  if (slash.length === 2) {
    const top = parseAmountWithSuffix(slash[0]!);
    const bottom = parseAmountWithSuffix(slash[1]!);
    return top === undefined || bottom === undefined || bottom === 0 ? undefined : top / bottom;
  }
  const match = text
    .trim()
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/^−/, "-")
    .match(/^([+-]?[0-9]*\.?[0-9]+)\s*([kmg]?)$/);
  if (!match) {
    return undefined;
  }
  const multiplier = match[2] === "k" ? 1e3 : match[2] === "m" ? 1e6 : match[2] === "g" ? 1e9 : 1;
  return Number.parseFloat(match[1]!) * multiplier;
}

/** The mirror: a committed value is SHOWN in the same shorthand it was
 * typed in - 10000 reads back as 10k, never expanded under your cursor. */
export function formatAmountWithSuffix(value: number): string {
  if (value < 0) return "-" + formatAmountWithSuffix(-value);
  if (value >= 1e9) {
    return `${trimTrailingDecimalZeros((value / 1e9).toFixed(2))}g`;
  }
  if (value >= 1e6) {
    return `${trimTrailingDecimalZeros((value / 1e6).toFixed(2))}m`;
  }
  if (value >= 1e3) {
    return `${trimTrailingDecimalZeros((value / 1e3).toFixed(2))}k`;
  }
  return trimTrailingDecimalZeros(value.toFixed(4));
}

export function trimFlow(value: number) {
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return trimTrailingDecimalZeros(value.toFixed(decimals));
}

/** A field value in the board's rate unit and the typed shorthand. */
function draftFor(perSecond: number, kind: string): string {
  const shown = Math.abs(perSecond * rateMultiplierForKind(kind));
  return shown < 1
    ? shown.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 6 })
    : formatAmountWithSuffix(shown);
}

type ClickLike = { button: number; preventDefault: () => void; stopPropagation: () => void };

/**
 * One drawer's rule and rate, and every way to change them. `flowing` is the
 * real rate's size, which a rule picked on an Any drawer starts from. In Pool
 * rates are SIGNED as typed (a minus makes an input); on the board the
 * drawer's own direction decides and the box shows sizes.
 */
export function useRateRule({
  storage,
  role,
  result,
  flowing,
}: {
  storage: FactoryStorage;
  role: StorageRole | undefined;
  result: StorageThroughputResult | undefined;
  flowing: number;
}) {
  const setStorageTarget = useFactoryStore((state) => state.setStorageTarget);
  const setStorageTargetMode = useFactoryStore((state) => state.setStorageTargetMode);
  const setStorageRule = useFactoryStore((state) => state.setStorageRule);
  const locked = useFactoryStore((state) => state.isReadOnly || state.checklistMode);
  const mode = storageTargetMode(storage, role);
  const target = storage.targetPerSecond;
  const any = target === undefined || mode === "ignore";
  const input = isInputRate(storage, role);
  // While the solver has NOTHING to solve for - no amount, no pin, anywhere -
  // every empty box pulses the ask, in step with the board's notice.
  const ask = useFactoryStore((state) => target === undefined && mode !== "ignore" && !hasAnySolveNumbers(state.project));
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // A rule picked on an empty drawer with nothing flowing yet waits here for
  // the number the box is about to ask for.
  const [pendingMode, setPendingMode] = useState<TargetMode | undefined>(undefined);
  const kind = storage.kind;
  const shownMode: TargetMode = any ? "ignore" : mode;

  const beginEdit = (perSecond: number | undefined, nextMode?: TargetMode) => {
    if (locked) return;
    setOpen(false);
    setPendingMode(nextMode);
    setDraft(perSecond === undefined ? "" : draftFor(perSecond, kind));
    setEditing(true);
  };
  const cancelEdit = () => {
    setPendingMode(undefined);
    setEditing(false);
  };
  // Picking a rule. From Any with no number yet, the rule starts from what
  // flows now; with nothing flowing, the box asks for the number.
  const choose = (next: TargetMode) => {
    const state = useFactoryStore.getState();
    setOpen(false);
    if (state.isReadOnly || state.checklistMode || next === shownMode) return;
    if (next === "ignore") {
      if (target !== undefined) setStorageTargetMode(storage.id, "ignore");
      return;
    }
    if (target === undefined) {
      const pinned = Number(Math.abs(flowing).toPrecision(4));
      if (pinned > 0) setStorageRule(storage.id, next, pinned);
      else beginEdit(undefined, next);
      return;
    }
    setStorageTargetMode(storage.id, next);
  };
  const stepRule = (by: 1 | -1) => {
    const index = RULE_STEPS.indexOf(shownMode);
    choose(RULE_STEPS[Math.min(RULE_STEPS.length - 1, Math.max(0, index + by))]!);
  };

  // Scrolling the box walks your rate, like the machine count: by 1 in the
  // board's rate unit, Ctrl (or Cmd) by 10, Shift by 100, landing on whole
  // steps. From Any it starts at what flows now, under the role's default
  // rule. Never below zero, and never across it: the sign stays the row's.
  // `add` is the mod's wheel (DrawerCard.stepRate): the shown figure rounded, then plus or minus the step, not a landing on
  // whole steps.
  const stepRate = (up: boolean, modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; add?: boolean }) => {
    const state = useFactoryStore.getState();
    if (state.isReadOnly || state.checklistMode) return;
    const step = modifiers.shiftKey ? 100 : modifiers.ctrlKey || modifiers.metaKey ? 10 : 1;
    const unitScale = rateMultiplierForKind(kind);
    const shown = (any ? Math.abs(flowing) : Math.abs(target!)) * unitScale;
    const next = modifiers.add
      ? Math.max(0, Math.round(shown) + (up ? step : -step))
      : Math.max(0, up ? Math.floor(shown / step + 1e-9) * step + step : Math.ceil(shown / step - 1e-9) * step - step);
    if (!any && Math.abs(next - shown) < 1e-9) return;
    // Scrolling down on an empty box asks for nothing: no zero rule appears.
    if (any && next === 0) return;
    const perSecond = next / unitScale;
    // The tick and the hush go FIRST: the write below is a project change,
    // and the board's sound watcher answers it with its own adjust tap the
    // moment it lands - one step, two sounds, if the hush comes after.
    playBoardSound("dialRate", { step: Math.min(6, Math.log10(Math.max(1, next)) * 2) });
    suppressBoardSound("adjust", 150);
    if (any) setStorageRule(storage.id, input ? "exact" : "at-least", perSecond);
    else setStorageTarget(storage.id, perSecond);
  };

  const commit = () => {
    setEditing(false);
    const wasPending = pendingMode !== undefined;
    setPendingMode(undefined);
    const text = draft.trim();
    if (text === "") {
      if (target !== undefined) setStorageTarget(storage.id, undefined);
      return;
    }
    const value = parseAmountWithSuffix(text);
    // Not a number, or a minus: the box keeps what it held. The board shows sizes and the direction is the drawer's.
    if (value === undefined || !Number.isFinite(value) || value < 0) return;
    const rule = pendingMode ?? (any ? (input ? "exact" : "at-least") : mode);
    // Nor a number this rule cannot mean.
    if (value === 0 && rule !== "exact" && rule !== "at-most") return;
    const perSecond = value / rateMultiplierForKind(kind);
    if (any || wasPending) setStorageRule(storage.id, rule, perSecond);
    else setStorageTarget(storage.id, perSecond);
  };
  // Middle click clears the rate from the rule button or the box.
  const clear = (event: ClickLike) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    if (locked) return;
    setEditing(false);
    setPendingMode(undefined);
    if (target !== undefined) setStorageTarget(storage.id, undefined);
  };

  return {
    storage, result, flowing, kind, mode, target, any, input, ask, locked, shownMode,
    open, setOpen, editing, draft, setDraft, beginEdit, cancelEdit, choose, stepRule, stepRate, commit, clear,
  };
}

export type RateRule = ReturnType<typeof useRateRule>;

