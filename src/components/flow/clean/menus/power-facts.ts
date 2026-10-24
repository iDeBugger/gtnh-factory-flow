import type { FactoryNode, Recipe } from "@/lib/model/types";
import { getVoltageTierMaxEuT } from "@/lib/model/tiers";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import { getNodePowerReport } from "@/lib/solver/power-report";
import type { GameVersion } from "@/lib/model/game-version";

/** The most amps the chip takes (laser hatches go that far). */
export const MAX_AMPS = 1 << 24;

/** One run at a given number of amps: ticks, EU/t for all its parallels, parallels. */
export interface PowerRun {
  duration: number;
  eut: number;
  parallels: number;
  runsPerSecond: number;
}

/** What the power input panel shows (the mod's `PowerPanel.Facts`), worked out once per card state. */
export interface PowerFacts {
  amps: number;
  /** The amps the machine works at: 1 on a lone regular hatch whatever its supply. */
  workingAmps: number;
  tier: string;
  volt: number;
  now: PowerRun;
  nextAmps?: number;
  next?: PowerRun;
  overclocks: number;
  perfect: number;
  demand: number;
  shared: boolean;
}

function runAt(
  recipe: Recipe,
  node: FactoryNode,
  tier: FactoryNode["hatchVoltageTier"],
  volt: number,
  amps: number,
  gameVersion: GameVersion,
): PowerRun {
  const at: FactoryNode = { ...node, hatchVoltageTier: tier, hatchAmps: amps, powerInputMode: "amps", powerEuT: amps * volt };
  const report = getNodePowerReport(recipe, at, gameVersion);
  const stats = getOverclockedRecipeStats(recipe, at, gameVersion);
  const parallels = Math.max(1, report.parallels);
  const duration = Math.max(1e-9, stats.durationTicks);
  return { duration, eut: report.state === "ok" ? report.drawEuT : Math.abs(stats.eut) * parallels, parallels, runsPerSecond: (parallels * 20) / duration };
}

const faster = (a: PowerRun, b: PowerRun) => a.runsPerSecond > b.runsPerSecond * 1.0001;

/**
 * The next amp count that runs the card faster (past the one-tick floor more amps only draw more): double until one
 * does, then halve the gap back.
 */
export function nextFasterAmps(runAtAmps: (amps: number) => PowerRun, amps: number): { amps: number; run: PowerRun } | undefined {
  const now = runAtAmps(amps);
  let lo = amps;
  let hi = amps;
  while (hi < MAX_AMPS) {
    hi = Math.min(MAX_AMPS, hi * 2);
    if (faster(runAtAmps(hi), now)) break;
    lo = hi;
  }
  if (lo >= hi || !faster(runAtAmps(hi), now)) return undefined;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (!faster(runAtAmps(mid), now)) lo = mid;
    else hi = mid;
  }
  return { amps: hi, run: runAtAmps(hi) };
}

/** For a card; `recipe` is the node's recipe with its input overrides; `demand` its whole draw. */
export function powerFacts(
  recipe: Recipe,
  node: FactoryNode,
  demand: number,
  shared: boolean,
  gameVersion: GameVersion,
): PowerFacts {
  const report = getNodePowerReport(recipe, node, gameVersion);
  const stats = getOverclockedRecipeStats(recipe, node, gameVersion);
  const tier = report.tier;
  const volt = getVoltageTierMaxEuT(tier);
  const run = (amps: number) => runAt(recipe, node, tier as FactoryNode["hatchVoltageTier"], volt, amps, gameVersion);
  const now = run(report.amps);
  const next = nextFasterAmps(run, report.amps);
  return {
    amps: report.amps,
    workingAmps: report.workingAmps,
    tier,
    volt,
    now,
    nextAmps: next?.amps,
    next: next?.run,
    overclocks: stats.overclockSteps,
    perfect: stats.perfectOverclockSteps,
    demand,
    shared,
  };
}
