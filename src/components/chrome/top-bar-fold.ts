/**
 * The top bar is one row, and nothing in it hides in a menu. As the bar narrows the plan tabs give way first (the strip
 * scrolls; the open plan's tab and the + never go), then Plans, Share and Sign in become small icon keys like settings
 * and help, then the gaps tighten.
 *
 * Each step starts when the tab strip's measured room falls below what that step keeps for it. Stepping back is judged
 * by the room the previous dress would leave (what the step gave the tabs, measured when it was taken), so a bar resting
 * on an edge never flickers. All widths are the bar's own px (inside its zoom), the unit of `clientWidth`.
 */

/** The plan tab's widths and the strip's gap and + (`.mt-tab`, `.mt` and `.mt-plus` in chrome.css). */
export const TAB_LEAST_WIDTH = 48;
export const TAB_MOST_WIDTH = 120;
export const TAB_GAP = 2;
export const PLUS_WIDTH = 16;

/** Room for one full tab and the +; for two. */
export const TABS_ROOM_ONE = TAB_MOST_WIDTH + TAB_GAP + PLUS_WIDTH;
export const TABS_ROOM_TWO = 2 * TAB_MOST_WIDTH + 2 * TAB_GAP + PLUS_WIDTH;

/** A step is undone only this much roomier than it was taken at. */
export const TOP_BAR_HYSTERESIS = 12;

/** The dresses, widest first (`data-fit` on the bar): the labelled keys, the icon keys, the icon keys with tighter gaps. */
export const TOP_BAR_STEPS = ["roomy", "icons", "tight"] as const;
export type TopBarStep = 0 | 1 | 2;

/**
 * The room the tabs keep before the next step starts: two full tabs and the + before the keys become icons, one
 * before the gaps tighten. Below that the strip scrolls down to `TAB_LEAST_WIDTH` and the +.
 */
export const STEP_ROOM: readonly number[] = [TABS_ROOM_TWO, TABS_ROOM_ONE];

/** What a step gave the tab strip the moment it was taken (index: the step it left), as `topBarStep` reads it. */
export type StepSavings = readonly number[];

/**
 * The step the bar should be in, from the tab strip's width now. One step at a time: the bar renders the new dress and
 * asks again.
 */
export function topBarStep(step: TopBarStep, tabsWidth: number, savings: StepSavings): TopBarStep {
  const keeps = STEP_ROOM[step];
  if (keeps !== undefined && tabsWidth < keeps) return (step + 1) as TopBarStep;
  const kept = STEP_ROOM[step - 1];
  if (kept !== undefined && tabsWidth - (savings[step - 1] ?? 0) >= kept + TOP_BAR_HYSTERESIS) return (step - 1) as TopBarStep;
  return step;
}

/**
 * What a step gave the tabs, from the strip's width just before it and just after, with the bar's own width at both
 * (the strip grows with the bar one for one).
 */
export function stepSaving(before: { tabs: number; bar: number }, after: { tabs: number; bar: number }): number {
  return Math.max(0, after.tabs - before.tabs - (after.bar - before.bar));
}
