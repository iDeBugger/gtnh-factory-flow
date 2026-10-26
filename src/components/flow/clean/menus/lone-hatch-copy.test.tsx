// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { FactoryNode, Recipe } from "@/lib/model/types";
import { PowerFactsPanel } from "./PowerInputPanel";
import { powerFacts } from "./power-facts";
import { workingLines } from "./working-lines";

/** A lone regular hatch works at 1A (setProcessingLogicPower); the power copy says so. */
const machine = (machineType: string): Recipe => ({
  id: machineType,
  name: machineType,
  machineType,
  minimumTier: "HV",
  durationTicks: 400,
  eut: 120,
  inputs: [],
  outputs: [],
  machineHandlers: [
    { id: machineType, label: machineType, machineType, minimumTier: "LV", kind: "multiblock" },
  ],
});
const card = (recipeId: string, hatchAmps: number): FactoryNode => ({
  id: "a",
  recipeId,
  overclockTier: "HV",
  hatchVoltageTier: "HV",
  hatchAmps,
  powerInputMode: "amps",
  machineCount: 1,
  parallel: 1,
  enabled: true,
  position: { x: 0, y: 0 },
});
const flat = (terms: Array<string | { text?: string; sup?: string }>) =>
  terms.map((term) => (typeof term === "string" ? term : (term.text ?? term.sup ?? ""))).join("");

afterEach(cleanup);

it("tells a 2A Large Chemical Reactor that one hatch works at 1A", () => {
  const r = machine("Large Chemical Reactor");
  const supply = workingLines(r, card(r.id, 2), "2.9").find((line) => line.label === "supply")!;
  expect(supply.result).toBe("512 EU/t");
  expect(flat(supply.math)).toBe("512 V · 2 A, one hatch works at 1 A");
  const panel = render(<PowerFactsPanel facts={powerFacts(r, card(r.id, 2), 0, false, "2.9")} />);
  expect(panel.container.textContent).toContain("1A ×HV= 512 EU/t");
  expect(panel.container.textContent).toContain("(one hatch works at 1A)");
});

it("says nothing of the sort for a Mega Blast Furnace or a 4A supply", () => {
  const mega = machine("Mega Blast Furnace");
  const megaFacts = render(
    <PowerFactsPanel facts={powerFacts(mega, card(mega.id, 2), 0, false, "2.9")} />,
  );
  expect(megaFacts.container.textContent).toContain("2A ×HV= 1.02k EU/t");
  expect(megaFacts.container.textContent).not.toContain("one hatch works");
  cleanup();
  const r = machine("Large Chemical Reactor");
  const four = workingLines(r, card(r.id, 4), "2.9").find((line) => line.label === "supply")!;
  expect(flat(four.math)).toBe("512 V · 4 A");
});
