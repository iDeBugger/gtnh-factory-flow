import { useMemo } from "react";
import { unservedPlanVersion } from "@/lib/datasets/dataset-cache";
import { servedGameVersions } from "@/lib/datasets/new-plan-version";
import { convertingLabel, convertOpenPlan, usePendingConversion } from "@/lib/datasets/convert-action";
import { DEFAULT_GAME_VERSION } from "@/lib/model/game-version";
import { useFactoryStore } from "@/store/factory-store";
import { planVersionNotice, type BoardNotice } from "./clean/rail/notices";

/** The Convert key: a copy of the plan for the default version opens as a new plan (convert-action). */
function convertToDefault(): void {
  void convertOpenPlan(DEFAULT_GAME_VERSION);
}

/**
 * The notice on a plan whose game version this site has no recipes for, while that plan is open.
 * The plan keeps its stored recipe bodies and nothing refreshes them (`datasetServesPlan`).
 */
export function usePlanVersionNotice(): BoardNotice | undefined {
  const unserved = useFactoryStore(unservedPlanVersion);
  const manifest = useFactoryStore((state) => state.datasetManifest);
  const converting = usePendingConversion();
  return useMemo(() => {
    const served = servedGameVersions(manifest);
    // The key shows only while this site serves the default version: a key that cannot convert is not offered.
    const notice = planVersionNotice(unserved, served, served.includes(DEFAULT_GAME_VERSION) ? convertToDefault : undefined);
    // While a conversion runs the key says so, and a second press does nothing.
    return notice?.action && converting
      ? { ...notice, action: { label: convertingLabel(converting.target), onSelect: () => undefined } }
      : notice;
  }, [converting, manifest, unserved]);
}
