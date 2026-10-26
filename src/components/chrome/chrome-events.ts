/**
 * Doors the bar knocks on that another part of the app answers. Each is a window event, so a feature that lands
 * later (the tour) listens without the bar importing it; the bar says whether anyone answered.
 */
export const OPEN_TOUR_EVENT = "gtnh-factory-flow:open-tour";
export const OPEN_SCREENSHOT_EVENT = "gtnh-factory-flow:open-screenshot";
export const OPEN_SETTINGS_EVENT = "gtnh-factory-flow:open-settings";
export const OPEN_CONTROLS_EVENT = "gtnh-factory-flow:open-controls";

/**
 * Fires a door's event. The answering part calls `event.preventDefault()` to say it took the knock; the return value
 * is whether it did, so a caller can fall back when nothing answers.
 */
export function knock(name: string): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent(name, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
