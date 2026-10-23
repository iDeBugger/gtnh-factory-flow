"use client";

import { memo, useMemo } from "react";
import { unservedPlanVersion } from "@/lib/datasets/dataset-cache";
import { servedGameVersions } from "@/lib/datasets/new-plan-version";
import { useFactoryStore } from "@/store/factory-store";
import { planVersionNotice, type BoardNotice } from "./clean/rail/notices";

/**
 * The Convert key's action. Undefined keeps the key hidden: the notice offers no key that does
 * nothing. Conversion to another version sets it.
 */
const convertToDefault: (() => void) | undefined = undefined;

/**
 * The notice on a plan whose game version this site has no recipes for, while that plan is open.
 * The plan keeps its stored recipe bodies and nothing refreshes them (`datasetServesPlan`).
 */
export function usePlanVersionNotice(): BoardNotice | undefined {
  const unserved = useFactoryStore(unservedPlanVersion);
  const manifest = useFactoryStore((state) => state.datasetManifest);
  return useMemo(() => planVersionNotice(unserved, servedGameVersions(manifest), convertToDefault), [manifest, unserved]);
}

/**
 * The version notice in the notice stack's dress, for boards without the notices bar. Plan boards
 * say it in the bar (clean/rail/NoticeBar), as PlanConversionNotice does.
 */
export const PlanVersionNotice = memo(function PlanVersionNotice() {
  const notice = usePlanVersionNotice();
  const inBar = useFactoryStore((state) => state.project.planMode === true);
  if (!notice || inBar) {
    return null;
  }
  return (
    <div
      role="status"
      data-plan-version-notice
      className="nodrag pointer-events-auto flex max-w-[min(calc(94*var(--ui-vw)),760px)] flex-wrap items-center justify-center gap-x-3 gap-y-1 border-2 border-[#d8a64a] bg-[#2a2416] px-3 py-2 font-mono text-[13px] text-[#f1e3c2] shadow-[inset_2px_2px_0_#6b5527,inset_-2px_-2px_0_#17130b,4px_4px_0_rgba(0,0,0,0.35)]"
    >
      <span>{notice.text}</span>
      {notice.action ? (
        <button
          type="button"
          onClick={notice.action.onSelect}
          className="shrink-0 border border-[#d8a64a] bg-[#4a3c1f] px-2 py-0.5 text-[#fff1cf] hover:bg-[#5c4b27]"
        >
          {notice.action.label}
        </button>
      ) : null}
    </div>
  );
});
