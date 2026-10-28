// Before any module builds a schema (zod-jitless.ts).
import "../../zod-jitless";
import { createRoot } from "react-dom/client";
import { AppFontRestore } from "@/components/AppFontRestore";
import { GlobalTitleTooltip } from "@/components/nei/GlobalTitleTooltip";
import { WhatsNewGate } from "@/components/WhatsNewGate";
import "../../globals.css";
import "../../fonts.css";
import { CleanCardHarness } from "./CleanCardHarness";

/*
 * `/dev/clean-card`, served by the dev server only (src/server/dev.ts): the page's own tree (AppRoot.tsx) with
 * the harness in the planner's place and no JS-less paragraph. Production never builds or routes it.
 */
createRoot(document.getElementById("root")!).render(
  <>
    <CleanCardHarness />
    <div className="ui-zoom">
      <WhatsNewGate />
    </div>
    <AppFontRestore />
    <GlobalTitleTooltip />
  </>,
);
