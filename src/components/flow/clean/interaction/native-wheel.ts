import { useEffect, useRef } from "react";

/**
 * A wheel listener on `element` that may `preventDefault`: React's own wheel handlers are passive, so a control that
 * steps a value on the wheel needs this one, or Ctrl+wheel zooms the page under it. The handler is read at event
 * time, so it always sees the latest render.
 */
export function useNativeWheel(
  element: HTMLElement | null,
  onWheel: (event: WheelEvent) => void,
): void {
  const handler = useRef(onWheel);
  useEffect(() => {
    handler.current = onWheel;
  });
  useEffect(() => {
    if (!element) return undefined;
    const listener = (event: WheelEvent) => handler.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, [element]);
}
