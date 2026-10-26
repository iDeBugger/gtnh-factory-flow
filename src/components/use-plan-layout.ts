"use client";

import { useDeviceSettings } from "@/lib/device-settings";
import { useIsCompactViewport } from "@/lib/compact-view";

/**
 * Whether the items browser sits right of the board: unless the settings' "Item browser" puts it on the left (and
 * the overview on the right). A phone's drawers keep it on the right.
 */
export function useItemsOnRight(): boolean {
  const itemsLeft = useDeviceSettings().itemsLeft;
  const compact = useIsCompactViewport();
  return compact || !itemsLeft;
}
