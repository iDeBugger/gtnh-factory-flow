import { describe, expect, it } from "vitest";
import { PROJECT_SCHEMA_VERSION, type FactoryProject } from "../model/types";
import { calculateThroughput } from "./throughput";
import { parseFactoryProjectJson, serializeFactoryProject } from "../import-export/factory-json";

function fixture(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "rates",
    name: "Rates",
    fuelProfiles: [],
    recipes: [
      {
        id: "smelt",
        name: "Smelt",
        machineType: "Test",
        durationTicks: 20,
        eut: 0,
        minimumTier: "NONE",
        inputs: [{ kind: "item", id: "ore", amount: 2 }],
        outputs: [{ kind: "item", id: "ingot", amount: 1 }],
      },
    ],
    nodes: [
      {
        id: "smelt",
        recipeId: "smelt",
        machineCount: 1,
        enabled: true,
        parallel: 1,
        overclockTier: "NONE",
        position: { x: 160, y: 0 },
      },
    ],
    storages: [
      {
        id: "ore",
        kind: "item",
        resourceId: "ore",
        position: { x: 0, y: 0 },
        targetPerSecond: -10,
        targetMode: "exact",
      },
      { id: "ingot", kind: "item", resourceId: "ingot", position: { x: 320, y: 0 } },
    ],
    edges: [
      { id: "in", source: "ore", target: "smelt", resourceKind: "item", resourceId: "ore" },
      { id: "out", source: "smelt", target: "ingot", resourceKind: "item", resourceId: "ingot" },
    ],
  };
}
describe("drawer rates", () => {
  it("sizes machinery from a source alone", () => {
    const p = fixture();
    const r = calculateThroughput(p);
    expect(r.nodes.smelt.theoreticalMachinesRequired).toBeCloseTo(5);
    expect(r.storages.ore.consumedPerSecond).toBeCloseTo(10);
    expect(r.storages.ingot.producedPerSecond).toBeCloseTo(5);
  });
  it("allows unused supply under an input ceiling", () => {
    const p = fixture();
    p.storages![0].targetMode = "at-most";
    p.storages![1].targetPerSecond = 3;
    const r = calculateThroughput(p);
    expect(r.storages.ore.consumedPerSecond).toBeCloseTo(6);
    expect(r.storages.ingot.producedPerSecond).toBeCloseTo(3);
    expect(r.storages.ingot.targetUnreachable).not.toBe(true);
  });
  it("holds an output at its ceiling and reports the exact input it cannot take", () => {
    const p = fixture();
    p.storages![1].targetMode = "at-most";
    p.storages![1].targetPerSecond = 3;
    const r = calculateThroughput(p);
    expect(r.storages.ingot.producedPerSecond).toBeCloseTo(3);
    expect(r.storages.ore.consumedPerSecond).toBeCloseTo(6);
    expect(r.storages.ore.targetUnreachable).toBe(true);
  });
  it("runs an Up to pin at what an input ceiling feeds, and says the pin is starved", () => {
    const p = fixture();
    p.storages![0].targetMode = "at-most";
    p.nodes[0].solvePin = 6;
    const r = calculateThroughput(p);
    expect(r.storages.ore.consumedPerSecond).toBeCloseTo(10);
    expect(r.nodes.smelt.theoreticalMachinesRequired).toBeCloseTo(5);
    expect(r.plan?.upTo?.smelt).toMatchObject({ capacity: 6, reason: "STARVED" });
  });
  it("keeps an exact pin above an input ceiling and names the pin as what breaks the ceiling", () => {
    const p = fixture();
    p.storages![0].targetMode = "at-most";
    p.nodes[0].solvePin = 6;
    p.nodes[0].solvePinExact = true;
    const r = calculateThroughput(p);
    expect(r.storages.ore.consumedPerSecond).toBeCloseTo(12);
    expect(r.plan?.shortfalls).toEqual([
      expect.objectContaining({ drawerId: "ore", rule: "AT_MOST", target: 10, reachable: 12, limitingCards: ["smelt"] }),
    ]);
  });
  it("permits zero output ceilings", () => {
    const p = fixture();
    p.storages![1].targetMode = "at-most";
    p.storages![1].targetPerSecond = 0;
    const r = calculateThroughput(p);
    expect(r.storages.ingot.producedPerSecond).toBe(0);
    expect(r.storages.ore.consumedPerSecond).toBe(0);
    expect(r.storages.ore.targetUnreachable).toBe(true);
  });
  it("does not turn a ceiling into a production demand", () => {
    const p = fixture();
    p.storages![0].targetMode = "at-most";
    expect(calculateThroughput(p).nodes.smelt.theoreticalMachinesRequired).toBe(0);
  });
  it("enforces a zero input", () => {
    const p = fixture();
    p.storages![0].targetPerSecond = 0;
    p.storages![0].targetMode = "at-most";
    p.storages![1].targetPerSecond = 3;
    const r = calculateThroughput(p);
    expect(r.storages.ore.consumedPerSecond).toBe(0);
    expect(r.storages.ingot.targetUnreachable).toBe(true);
  });
  it("allows input above a minimum", () => {
    const p = fixture();
    p.storages![0].targetMode = "at-least";
    p.storages![1].targetPerSecond = 8;
    const r = calculateThroughput(p);
    expect(r.storages.ore.consumedPerSecond).toBeCloseTo(16);
    expect(r.storages.ingot.targetUnreachable).not.toBe(true);
  });
  it("ignores a source rate while keeping the source available", () => {
    const p = fixture();
    p.storages![0].targetMode = "ignore";
    p.storages![1].targetPerSecond = 8;
    const r = calculateThroughput(p);
    expect(r.storages.ore.consumedPerSecond).toBeCloseTo(16);
    expect(r.storages.ore.targetUnreachable).not.toBe(true);
    expect(p.storages![0].targetPerSecond).toBe(-10);
  });
  it("reports a conflicting exact output and input", () => {
    const p = fixture();
    p.storages![1].targetPerSecond = 3;
    p.storages![1].targetMode = "exact";
    const r = calculateThroughput(p);
    expect(r.storages.ore.targetUnreachable).toBe(true);
    expect(r.storages.ingot.producedPerSecond).toBeCloseTo(3);
  });
  it("ignores an output target", () => {
    const p = fixture();
    p.storages![0].targetPerSecond = undefined;
    p.storages![1].targetPerSecond = 100;
    p.storages![1].targetMode = "ignore";
    expect(calculateThroughput(p).nodes.smelt.theoreticalMachinesRequired).toBe(0);
  });
});
it("preserves rates, rules and wires through JSON", () => {
  const p = fixture();
  p.storages![0].targetMode = "at-most";
  p.storages![1].targetPerSecond = 3;
  const loaded = parseFactoryProjectJson(serializeFactoryProject(p));
  expect(calculateThroughput(loaded).storages.ore.consumedPerSecond).toBeCloseTo(6);
  expect(loaded.edges).toEqual(p.edges);
});
