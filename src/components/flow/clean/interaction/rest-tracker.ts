/**
 * The mod's tooltip wait (`Tip.Wait`): a tip shows once the pointer has rested
 * on the SAME thing for 0.8 s. Moving about on the thing keeps the wait; moving
 * to another thing, or off everything, resets it to zero (no quick re-show).
 * Pure: the clock is an argument, so the rule is tested without timers.
 */
export const TIP_WAIT_MS = 800;

export interface RestTracker {
  /** The pointer is over `target` (or over nothing) at `now`. */
  point(target: string | undefined, now: number): void;
  /** Forget the wait: the thing stays, the clock starts again from `now`. */
  restart(now: number): void;
  /** True once the pointer has rested on the current target for the wait. */
  ready(now: number): boolean;
  /** Milliseconds still to wait (0 when ready, Infinity with no target). */
  remaining(now: number): number;
  target(): string | undefined;
}

export function createRestTracker(waitMs: number = TIP_WAIT_MS): RestTracker {
  let target: string | undefined;
  let since = 0;
  return {
    point(next, now) {
      if (next !== target) {
        target = next;
        since = now;
      }
    },
    restart(now) {
      since = now;
    },
    ready(now) {
      return target !== undefined && now - since >= waitMs;
    },
    remaining(now) {
      return target === undefined ? Number.POSITIVE_INFINITY : Math.max(0, waitMs - (now - since));
    },
    target: () => target,
  };
}

/**
 * What the pointer holds: a wire, a lifted port, a carried card, drawer or
 * note, a box selection, a pan, a spare in hand. While any is held no tip shows
 * and none is waited for. Each holder names itself so it can let go on its own.
 */
const held = new Set<string>();
const listeners = new Set<() => void>();

export function setHandHeld(holder: string, on: boolean): void {
  const before = held.size;
  if (on) held.add(holder);
  else held.delete(holder);
  if (held.size !== before) for (const listener of listeners) listener();
}

export function handFull(): boolean {
  return held.size > 0;
}

export function onHandChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The wait every tooltip uses (the mod's `Tip.Wait`); tests set their own. */
let activeWait = TIP_WAIT_MS;

export function setRestWait(ms: number): void {
  activeWait = ms;
}

export function restWait(): number {
  return activeWait;
}
