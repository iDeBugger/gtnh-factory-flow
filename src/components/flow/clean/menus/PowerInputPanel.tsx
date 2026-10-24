"use client";

import "./menus.css";

import { forwardRef, useMemo, type CSSProperties } from "react";
import { formatCompact } from "@/lib/model";
import { applyRecipeInputOverrides } from "@/lib/model";
import { useFactoryStore } from "@/store/factory-store";
import { tierChipColors } from "../tokens";
import { powerFacts, type PowerFacts } from "./power-facts";
import { planGameVersion } from "@/lib/model/game-version";

const compact = (value: number) => formatCompact(value);
const amps = (value: number) => `${compact(value)}A`;
const seconds = (ticks: number) => `${compact(ticks / 20)} s`;

function Tag({ tier }: { tier: string }) {
  const colors = tierChipColors(tier);
  const style = colors
    ? ({ "--tag-bg": colors.background, "--tag-border": colors.border, "--tag-ink": colors.ink } as CSSProperties)
    : undefined;
  return (
    <span className="pw-tag" style={style}>
      {tier}
    </span>
  );
}

function overclockText(facts: PowerFacts): string {
  if (facts.overclocks === 0) return "none";
  if (facts.perfect === 0) return String(facts.overclocks);
  return `${facts.perfect} perfect, ${facts.overclocks - facts.perfect}`;
}

function Box({ label, unit, before, after }: { label: string; unit: string; before: string; after: string }) {
  return (
    <div className="pw-box">
      <span>
        {label} <small>{unit}</small>
      </span>
      <b>
        {before} <span style={{ display: "inline", color: "#a3a3a3" }}>→</span> {after}
      </b>
    </div>
  );
}

/** From nothing to the next step: the bar filled to what is supplied, ticks where the draw and the supply are. */
function Scale({ facts }: { facts: PowerFacts }) {
  const next = facts.nextAmps!;
  const supplied = facts.amps;
  const draw = facts.volt > 0 ? facts.now.eut / facts.volt : 0;
  const ps = Math.min(1, supplied / next);
  const pd = Math.min(1, draw / next);
  const slide = (p: number): CSSProperties => ({ left: `${p * 100}%`, transform: `translateX(-${p * 100}%)` });
  return (
    <div className="pw-scale">
      <span className="pw-mark pw-subtle" style={{ left: 0, top: 0 }}>
        0A
      </span>
      <span className="pw-mark" style={{ right: 0, top: 0 }}>
        {amps(next)} next
      </span>
      <span className="pw-mark" style={{ ...slide(ps), top: 15 }}>
        {amps(supplied)} supplied
      </span>
      <div className="pw-bar">
        <div className="pw-fill" style={{ width: `calc((100% - 2px) * ${ps})` }} />
        <i className="pw-tick" style={{ left: `calc(1px + (100% - 2px) * ${ps})`, top: -4, height: 17 }} />
        <i className="pw-tick" style={{ left: `calc(1px + (100% - 2px) * ${pd})`, top: 0, height: 9 }} />
        <i className="pw-tick" style={{ left: "calc(100% - 2px)", top: -4, height: 17 }} />
      </div>
      <span className="pw-mark" style={{ ...slide(pd), top: 44 }}>
        {amps(draw)} draw
      </span>
    </div>
  );
}

export function PowerFactsPanel({ facts }: { facts: PowerFacts }) {
  const { now, next } = facts;
  const hatchAmps = facts.amps === 1 ? 1 : 2;
  const hatches = facts.amps / hatchAmps;
  const stats: Array<[string, string]> = [
    ["Overclocks", overclockText(facts)],
    ["Parallels", String(now.parallels)],
    ["Time / recipe", seconds(now.duration)],
    ["Recipes / second", compact(now.runsPerSecond)],
    ["EU / recipe", compact(now.eut * now.duration)],
    ["Draw", `${compact(now.eut)} EU/t`],
  ];
  return (
    <div className="pw" data-power-panel="">
      <div className="pw-title">Power input</div>
      <div className="pw-line">
        <span>
          {compact(facts.workingAmps)}A ×<Tag tier={facts.tier} />= {compact(facts.volt * facts.workingAmps)} EU/t
        </span>
        <span>
          {compact(hatches)}
          <Tag tier={facts.tier} />
          {facts.amps <= hatchAmps ? "hatch" : "hatches"}
          <span className="pw-subtle">
            {facts.workingAmps !== facts.amps ? "(one hatch works at 1A)" : `(${hatchAmps}A each)`}
          </span>
        </span>
      </div>
      <div className="pw-rule" />
      <div className="pw-stats">
        {stats.map(([label, value]) => (
          <div key={label} className="pw-stat">
            <span>{label}</span>
            <span>{value}</span>
          </div>
        ))}
      </div>
      <div className="pw-rule" />
      {next && facts.nextAmps !== undefined ? (
        <>
          <div className="pw-line">
            <span>Next improvement</span>
            <span>
              +{amps(facts.nextAmps - facts.amps)}
              <Tag tier={facts.tier} />
            </span>
          </div>
          <div className="pw-boxes">
            <Box label="Output" unit="recipes/s" before={compact(now.runsPerSecond)} after={compact(next.runsPerSecond)} />
            <Box label="Time" unit="per recipe" before={seconds(now.duration)} after={seconds(next.duration)} />
            <Box label="Draw" unit="EU/t" before={compact(now.eut)} after={compact(next.eut)} />
          </div>
          <Scale facts={facts} />
        </>
      ) : (
        <div className="pw-line">
          <span>Next improvement</span>
          <span className="pw-subtle">none: more amps buy nothing</span>
        </div>
      )}
      <div className="pw-rule" />
      <div className="pw-line">
        <span className="pw-subtle">Demand for this card</span>
        <span>{compact(facts.demand)} EU/t</span>
      </div>
      <div className="pw-subtle">{facts.shared ? "All recipes, across the required machines." : "Across the required machines."}</div>
    </div>
  );
}

/** What the mouse does on the amps and tier chips; the section for the chip under the mouse is marked. */
export function PowerGuide({ part }: { part?: "amps" | "tier" | "power" }) {
  const amp: Array<[string, string]> = [
    ["Type amps", "Click"],
    ["-1", "Right click"],
    ["+1 / -1", "Wheel"],
    ["+10 / -10", "Ctrl+Wheel"],
    ["×4 or ÷4", "Shift+Wheel"],
  ];
  const tier: Array<[string, string]> = [
    ["Up", "Click, wheel up"],
    ["Down", "Right click, wheel down"],
  ];
  const section = (title: string, rows: Array<[string, string]>, on: boolean) => (
    <div className="pw-guide-sec" data-on={on ? "" : undefined}>
      <div className="pw-title">{title}</div>
      {rows.map(([what, how]) => (
        <div key={what} className="pw-guide-row">
          <span>{what}</span>
          <span>{how}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div className="pw pw-guide" data-power-guide="">
      {section("Amps", amp, part === "amps")}
      {section("Tier", tier, part === "tier")}
    </div>
  );
}

/** The panel for a card, read from the store: it re-reads on every solve. */
export const PowerInputPanel = forwardRef<HTMLDivElement, { nodeId: string; part?: "amps" | "tier" | "power"; style?: CSSProperties }>(
  function PowerInputPanel({ nodeId, part, style }, ref) {
    const project = useFactoryStore((state) => state.project);
    const lastResult = useFactoryStore((state) => state.lastResult);
    const node = project.nodes.find((entry) => entry.id === nodeId);
    const recipe = project.recipes.find((entry) => entry.id === node?.recipeId);
    const result = lastResult?.nodes[nodeId];
    const gameVersion = planGameVersion(project);
    const facts = useMemo(() => {
      if (!node || !recipe) return undefined;
      const demand = node.enabled && result?.theoreticalMachinesRequired ? (result.euT ?? 0) : 0;
      return powerFacts(
        applyRecipeInputOverrides(recipe, node, gameVersion),
        node,
        demand,
        Boolean(node.extraRecipes?.length),
        gameVersion,
      );
    }, [node, recipe, result, gameVersion]);
    if (!facts) return null;
    return (
      <div ref={ref} className="pw-wrap ui-zoom" data-clean-tip="" data-tip-panel="power" style={style}>
        <PowerFactsPanel facts={facts} />
        <PowerGuide part={part} />
      </div>
    );
  },
);
