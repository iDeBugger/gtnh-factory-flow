/** The one seam between the plan-mode workspace and the overview rail (flow/clean/rail). */
import { OverviewRail } from "./flow/clean/rail/OverviewRail";

/**
 * {@code side}: the side of the board the overview sits on (the settings' "Item browser" may put it on the right).
 * {@code open}: whether it shows, the window's fold on top of the player's (default: the player's); {@code onOpen}: a
 * click on its strip.
 */
export function PlanOverview({
  inDrawer = false,
  side = "left",
  open,
  onOpen,
}: {
  inDrawer?: boolean;
  side?: "left" | "right";
  open?: boolean;
  onOpen?: () => void;
}) {
  return (
    <div data-testid="plan-overview" className="h-full min-h-0 min-w-0">
      <OverviewRail forceOpen={inDrawer} side={side} open={open} onOpen={onOpen} />
    </div>
  );
}
