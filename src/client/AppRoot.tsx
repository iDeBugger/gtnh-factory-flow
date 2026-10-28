import { AppFontRestore } from "@/components/AppFontRestore";
import { FactoryPlannerApp } from "@/components/FactoryPlannerApp";
import { GlobalTitleTooltip } from "@/components/nei/GlobalTitleTooltip";
import { WhatsNewGate } from "@/components/WhatsNewGate";
import { isModAndCommunityOn } from "@/lib/deployment-features";

/**
 * Everything the page renders inside <body> after the boot scripts, in this
 * order: the planner, the one paragraph a JS-less visitor (or crawler) gets,
 * the what's-new layer, the font restore and the planner's own tooltip. The
 * same tree is prerendered into the shell at build and hydrated in the
 * browser, so it reads nothing that differs between the two.
 */
export function AppRoot() {
  const community = isModAndCommunityOn();
  return (
    <>
      <FactoryPlannerApp />
      {/* Renders nothing at all when the app itself is going to. */}
      <noscript>
        <h1>GTNH Planner</h1>
        <p>
          A free factory planner and recipe calculator for GregTech: New Horizons. Draw production
          chains on an interactive flowchart with full recipe data for GTNH 2.9 and 2.8.1, balance
          machine ratios,
          {community
            ? " compute power and throughput, and share plans with the community."
            : " and compute power and throughput."}{" "}
          The planner needs JavaScript to run.
        </p>
      </noscript>
      {/* Above the app rather than inside it: what changed is a fact about
          the whole planner, not about whichever tab happens to be open. */}
      <div className="ui-zoom">
        <WhatsNewGate />
      </div>
      {/* Puts the saved font back if anything took it off after the boot
          script; see the component. */}
      <AppFontRestore />
      {/* Every `title` attribute in the app, worn as the planner's own
          tooltip: the browser's grey box never renders again. */}
      <GlobalTitleTooltip />
    </>
  );
}
