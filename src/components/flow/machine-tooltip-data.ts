import type { FactoryNode, MachineHandler, NodeThroughputResult, Recipe } from "@/lib/model/types";
import {
  applyMachineHandlerToRecipe,
  getRecipeMachineConfigTierControls,
  type MachineConfigTierControl,
} from "@/lib/model/recipe-rules";
import { formatCompact } from "@/lib/model";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import {
  getNodePowerReport,
  getNodeSteamReport,
  hasPowerReport,
  describePowerStall,
} from "@/lib/solver/power-report";
import { getMachineParallelMultiplier, getMachineSettingWarning } from "@/lib/solver/machine-effects";
import { isMultiblockRecipe } from "@/lib/solver/power";
import { getMachineBehaviour, getMachineTableControls } from "@/lib/machines/machine-table";
import { pinRuleOf } from "@/lib/model/pin-rule";
import type { PlanUpTo } from "@/lib/solver/plan/types";
import type { RecipeTooltipView, TooltipMode } from "./recipe-tooltip-data";
import type { GameVersion } from "@/lib/model/game-version";

const number = (value: number) =>
  value > 0 && value < 0.001
    ? "<0.001"
    : value.toLocaleString(undefined, { maximumFractionDigits: 3 });

export function buildMachineTooltip(
  recipe: Recipe,
  handler: MachineHandler,
  node: FactoryNode,
  mode: TooltipMode,
  gameVersion: GameVersion,
  // Named, so no string next to the version can be passed in its place.
  { result, title, upTo }: { result?: NodeThroughputResult; title?: string; upTo?: PlanUpTo } = {},
): RecipeTooltipView {
  const selectedNode = { ...node, machineHandlerId: handler.id };
  const effective = applyMachineHandlerToRecipe(recipe, selectedNode, gameVersion);
  const stats = getOverclockedRecipeStats(recipe, selectedNode, gameVersion);
  const steam = getNodeSteamReport(recipe, selectedNode, gameVersion);
  const power =
    !steam && hasPowerReport(effective) ? getNodePowerReport(recipe, selectedNode, gameVersion) : undefined;
  const parallels = power?.parallels ?? getMachineParallelMultiplier(effective, selectedNode, gameVersion);
  const rule = pinRuleOf(node, recipe);
  const running =
    rule === "upTo" ? (upTo?.reached ?? result?.theoreticalMachinesRequired) : undefined;
  const count =
    mode === "build"
      ? node.machineCount
      : (running ?? node.solvePin ?? result?.theoreticalMachinesRequired);
  const countLabel =
    mode === "build"
      ? "Installed machines"
      : rule === "upTo"
        ? "Machines running"
        : rule === "exact"
          ? "Exact machines"
          : "Required machines";
  const rows = [
    { label: countLabel, value: count === undefined ? "Unavailable" : number(count) },
    ...(mode !== "build" && rule === "upTo" && node.solvePin
      ? [{ label: "Up to", value: number(node.solvePin) }]
      : []),
    ...(power ? [{ label: "Configured tier", value: stats.tier }] : []),
    {
      label: "Time per operation",
      value: stats.durationTicks > 0 ? `${number(stats.durationTicks / 20)} s` : "Instant",
    },
    ...(steam
      ? [{ label: "Steam per machine", value: `${formatCompact(steam.drawSteamPerTick * 20)} L/s` }]
      : power
        ? [{ label: "Draw per machine", value: `${formatCompact(power.drawEuT)} EU/t` }]
        : []),
    ...(parallels > 1 ? [{ label: "Parallel operations", value: number(parallels) }] : []),
  ];
  return {
    title: title ?? handler.label,
    subtitle: isMultiblockRecipe(effective, gameVersion) ? "Multiblock" : "Machine",
    mode,
    rows,
    requirement:
      [
        getMachineBehaviour(effective.machineType, gameVersion)?.note,
        getMachineSettingWarning(effective, selectedNode, gameVersion),
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    reason: power && power.state !== "ok" ? describePowerStall(power) : undefined,
  };
}

/** Show effective configuration values, never tooltip-scraped effect claims. */
export function buildConfigTooltip(
  recipe: Recipe,
  node: FactoryNode,
  control: MachineConfigTierControl,
  gameVersion: GameVersion,
): RecipeTooltipView {
  const effective = applyMachineHandlerToRecipe(recipe, node, gameVersion);
  const stats = getOverclockedRecipeStats(recipe, node, gameVersion);
  const steam = getNodeSteamReport(recipe, node, gameVersion);
  const power = !steam && hasPowerReport(effective) ? getNodePowerReport(recipe, node, gameVersion) : undefined;
  const selected =
    getRecipeMachineConfigTierControls(effective, node, gameVersion).find((c) => c.id === control.id) ?? control;
  // Only curated control notes: arbitrary scraped tooltips can claim effects
  // the machine never receives. These explain source/glass requirements too.
  const curatedControl = getMachineTableControls(effective.machineType, undefined, gameVersion).find(
    (c) => c.id === control.id,
  );
  // A typed number never matches a listed rung; its one rung carries the help.
  const curatedOption =
    curatedControl?.tiers.find((t) => t.key === selected.current.key) ??
    (control.numeric ? curatedControl?.tiers[0] : undefined);
  return {
    title: control.label,
    subtitle: selected.current.label,
    bullets: curatedOption?.resource.tooltip,
    rows: [
      ...(control.numeric
        ? [
            {
              label: "Range",
              value:
                control.numeric.max === undefined
                  ? `${control.numeric.min} or more`
                  : `${control.numeric.min} to ${control.numeric.max}`,
            },
          ]
        : []),
      {
        label: "Time per operation",
        value: stats.durationTicks > 0 ? `${number(stats.durationTicks / 20)} s` : "Instant",
      },
      ...(steam
        ? [
            {
              label: "Steam per machine",
              value: `${formatCompact(steam.drawSteamPerTick * 20)} L/s`,
            },
          ]
        : power
          ? [{ label: "Draw per machine", value: `${formatCompact(power.drawEuT)} EU/t` }]
          : []),
      {
        label: "Parallel operations",
        value: number(power?.parallels ?? getMachineParallelMultiplier(effective, node, gameVersion)),
      },
    ],
    reason: power && power.state !== "ok" ? describePowerStall(power) : undefined,
    actions: control.numeric
      ? [
          { gesture: "left", label: "Type a value" },
          { gesture: "wheel", label: "Step" },
        ]
      : control.tiers.length > 1
        ? [{ gesture: "left", label: "Change setting" }]
        : [],
  };
}
