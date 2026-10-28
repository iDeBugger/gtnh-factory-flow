import { useDesignStore } from "@/store/design-store";
import { useLibraryTab } from "@/lib/library/library-tab";
import { useWelcomeTab } from "@/lib/welcome/welcome-tab";

/**
 * Whether a page (Welcome or the library shelf) covers the board, by the same
 * rule as the workspace's: Welcome when its tab is on, the shelf when its tab
 * is on or no design is open. Things that float over the board from outside it
 * (the items search field at the bottom of the screen) hide under either.
 */
export function useBoardCovered(): boolean {
  const welcome = useWelcomeTab();
  const shelf = useLibraryTab();
  const isHydrated = useDesignStore((state) => state.isHydrated);
  const hasActiveDesign = useDesignStore(
    (state) => state.activeDesignId !== undefined || state.publicView !== undefined,
  );
  return welcome.active || shelf.active || (isHydrated && !hasActiveDesign);
}
