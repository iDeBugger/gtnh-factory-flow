import { useDeferredValue, useMemo } from "react";
import type { FactoryProject, ThroughputResult } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { buildRailModel, type RailModel } from "./rail-model";
import { buildSpares, type SpareView } from "./spare-model";

/**
 * The rail's and the popup's data for one (project, solve), worked out once
 * and shared: the overview, the spare popup and the notices all read the same
 * model, and a plan of hundreds of cards makes it a real cost.
 */
export interface RailData {
  rail: RailModel;
  spares: SpareView[];
}

let cache:
  | { project: FactoryProject; result: ThroughputResult | undefined; data: RailData }
  | undefined;

export function railData(project: FactoryProject, result: ThroughputResult | undefined): RailData {
  if (cache && cache.project === project && cache.result === result) return cache.data;
  const rail = buildRailModel(project, result);
  const data: RailData = { rail, spares: buildSpares(project, result, rail) };
  cache = { project, result, data };
  return data;
}

export function useRailData(): RailData {
  // Deferred: an edit paints on the board first and the rail follows in a render of its own (its model is about
  // 100 ms of a 1,000-card edit, which kept the click's first paint waiting).
  const liveProject = useFactoryStore((state) => state.project);
  const liveResult = useFactoryStore((state) => state.lastResult);
  const project = useDeferredValue(liveProject);
  const result = useDeferredValue(liveResult);
  return useMemo(() => railData(project, result), [project, result]);
}
