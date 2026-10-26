import { afterEach, describe, expect, it } from "vitest";
import { sectionNodeView } from "../../../model/shared-machine";
import type { FactoryProject, ThroughputResult } from "../../../model/types";
import { calculateThroughput } from "../../throughput";
import { unanchored } from "../unanchored";
import type { Answer, DrawerReadout, SolutionView, SolveInput, UpToReadout } from "../types";
import { setSolveCore } from "./engine";
import type { PlanSolveInput } from "./model";
import { customRecipe, drawer, node, project, recipe, wire } from "./test-kit";

afterEach(() => setSolveCore(undefined));

const idle: DrawerReadout = { rates: {}, unmet: [], shortfalls: [], ports: {} };

function view(partial: Partial<SolutionView> = {}): SolutionView {
  return {
    extentsPerSecond: {},
    machineCounts: {},
    edgeFlowsPerSecond: {},
    gatedSources: [],
    gatedSinks: [],
    terminalInputs: [],
    terminalOutputs: [],
    unneeded: [],
    openGates: 0,
    externalQuantity: 0,
    totalInternalFlow: 0,
    notes: [],
    key: { gateAnchors: [] },
    drawers: idle,
    spares: [],
    ...partial,
  };
}

const solved = (partial: Partial<SolutionView>): Answer => ({
  kind: "solved",
  solution: view(partial),
  alternatives: { chosen: null, options: [], complete: true, notes: [] },
});

function run(
  p: FactoryProject,
  answer: (input: PlanSolveInput) => Answer = () => ({
    kind: "failed",
    failure: { message: "NO_PIN", args: [] },
    notes: [],
    drawers: idle,
  }),
): { input: PlanSolveInput; result: ThroughputResult } {
  let input!: PlanSolveInput;
  setSolveCore((i: SolveInput) => {
    input = i as PlanSolveInput;
    return answer(input);
  });
  const result = calculateThroughput(p, { generatedAt: "t" });
  return { input, result };
}

const recipes = [recipe("a", [["x", 1]], [["y", 1]]), recipe("b", [["y", 2]], [["z", 1]])];

describe("the model: a count rule becomes pools and pins", () => {
  it("an Up to card is a one-machine Up to pool and fixes no count", () => {
    const { input } = run(project({ recipes, nodes: [node("p", "a", { solvePin: 2.5 })] }));
    expect(input.pools).toEqual([{ machines: ["p"], capacity: 2.5, exact: false, upTo: true }]);
    const p = input.machines[0]!;
    expect(p.countFixed).toBe(false);
  });

  it("an Exactly card stays a fixed count and makes no pool", () => {
    const { input } = run(
      project({ recipes, nodes: [node("p", "a", { solvePin: 2.5, solvePinExact: true })] }),
    );
    expect(input.pools).toEqual([]);
    expect([input.machines[0]!.countFixed, input.machines[0]!.machineCount]).toEqual([true, 2.5]);
  });

  it("Any, and a pin of zero, make neither", () => {
    const { input } = run(
      project({ recipes, nodes: [node("p", "a"), node("z", "a", { solvePin: 0 })] }),
    );
    expect(input.pools).toEqual([]);
    expect(input.machines.every((m) => !m.countFixed)).toBe(true);
  });

  it("a custom rate card's pin is always Exactly", () => {
    const rate = customRecipe("rate", "x", 3, "supply");
    const { input } = run(
      project({ recipes: [rate], nodes: [node("c", "rate", { solvePin: 2 })] }),
    );
    expect(input.pools).toEqual([]);
    expect([input.machines[0]!.countFixed, input.machines[0]!.machineCount]).toEqual([true, 2]);
  });

  it("a fluid tank never has a pin, whatever its rule", () => {
    const tank = {
      ...recipe("tank", [["x", 1]], [["y", 1]], "Tank"),
      source: { recipeMap: "Tank" },
    };
    const { input } = run(
      project({ recipes: [tank], nodes: [node("t", "tank", { solvePin: 4 })] }),
    );
    expect(input.pools).toEqual([]);
    expect(input.machines[0]!.countFixed).toBe(false);
  });

  it("a shared card's pin is its group's pool: Up to by default, exact when Exactly", () => {
    const card = (extra = {}) => node("card", "a", { extraRecipes: [{ recipeId: "b" }], ...extra });
    const wires = [wire("e1", "card", "card", "y", { from: 0, to: 1 })];
    const upTo = run(project({ recipes, nodes: [card({ solvePin: 2 })], edges: wires })).input;
    expect(upTo.pools).toEqual([
      { machines: ["card", "card#r1"], capacity: 2, exact: false, upTo: true },
    ]);
    const exact = run(
      project({ recipes, nodes: [card({ solvePin: 2, solvePinExact: true })], edges: wires }),
    ).input;
    expect(exact.pools).toEqual([
      { machines: ["card", "card#r1"], capacity: 2, exact: true, upTo: false },
    ]);
    expect(upTo.machines.every((m) => !m.countFixed)).toBe(true);
  });

  it("pools come in a fixed order whatever the order of the cards", () => {
    const nodes = [
      node("b", "a", { solvePin: 1 }),
      node("c", "a", { solvePin: 2 }),
      node("a", "a", { solvePin: 3 }),
    ];
    const forward = run(project({ recipes, nodes })).input.pools.map((p) => p.machines[0]);
    const backward = run(project({ recipes, nodes: [...nodes].reverse() })).input.pools.map(
      (p) => p.machines[0],
    );
    expect(forward).toEqual(["a", "b", "c"]);
    expect(backward).toEqual(forward);
  });

  it("a section view carries neither the pin nor its flag", () => {
    const card = node("card", "a", {
      extraRecipes: [{ recipeId: "b" }],
      solvePin: 2,
      solvePinExact: true,
    });
    const section = sectionNodeView(card, 1);
    expect(section.solvePin).toBeUndefined();
    expect(section.solvePinExact).toBeUndefined();
  });
});

describe("unanchored: an Up to pin sets its part of the plan", () => {
  const chain = (pin: Partial<{ solvePin: number; solvePinExact: boolean }>) =>
    project({
      recipes: [recipe("a", [["x", 1]], [["y", 1]]), recipe("b", [["y", 1]], [["z", 1]])],
      nodes: [node("a", "a", pin), node("b", "b")],
      edges: [wire("ab", "a", "b", "y")],
    });

  it("Up to and Exactly anchor, Any does not", () => {
    expect(run(chain({ solvePin: 1 })).result.plan!.unanchored).toEqual([]);
    expect(run(chain({ solvePin: 1, solvePinExact: true })).result.plan!.unanchored).toEqual([]);
    expect([...run(chain({})).result.plan!.unanchored].sort()).toEqual(["a", "b"]);
  });

  it("a shared card's Up to pin anchors the plan it sits in", () => {
    const card = node("card", "a", { extraRecipes: [{ recipeId: "b" }], solvePin: 2 });
    const { result } = run(
      project({
        recipes,
        nodes: [card],
        edges: [wire("e1", "card", "card", "y", { from: 0, to: 1 })],
      }),
    );
    expect(result.plan!.unanchored).toEqual([]);
  });

  it("the graph form: a node with an Up to pin anchors its part", () => {
    const graph = (upTo: boolean) => ({
      nodes: [
        { id: "a", countFixed: false, upTo },
        { id: "b", countFixed: false },
      ],
      edges: [{ source: "a", target: "b" }],
      drawers: [],
      groups: [],
    });
    expect([...unanchored(graph(true))]).toEqual([]);
    expect([...unanchored(graph(false))].sort()).toEqual(["a", "b"]);
  });
});

describe("the answer: Up to read-outs and shortfalls reach the extras by card id", () => {
  const p = () =>
    project({
      recipes: [
        recipe("a", [["x", 1]], [["y", 1]]),
        recipe("b", [["y", 1]], [["z", 1]]),
        recipe("c", [["y", 2]], [["w", 1]]),
      ],
      nodes: [
        node("a", "a", { solvePin: 4 }),
        node("b", "b", { solvePin: 3 }),
        node("s", "a", { extraRecipes: [{ recipeId: "c" }], solvePin: 2 }),
      ],
      storages: [drawer("out", "z")],
      edges: [wire("ab", "a", "b", "y"), wire("bz", "b", "out", "z", {}, { toDrawer: true })],
    });

  const readouts: UpToReadout[] = [
    {
      node: "a",
      machines: ["a"],
      capacity: 4,
      reached: 4,
      reason: "BOTTLENECK",
      wants: 6,
    },
    {
      node: "b",
      machines: ["b"],
      capacity: 3,
      reached: 1.5,
      reason: "STARVED",
      port: { node: "b", port: 0, input: true },
      tied: [{ node: "b", port: 0, input: true }],
      upstream: ["a"],
    },
    {
      node: "s",
      machines: ["s", "s#r1"],
      capacity: 2,
      reached: 1,
      reason: "CLOGGED",
      port: { node: "s#r1", port: 0, input: false },
      upstream: ["s#r1", "s"],
    },
    { node: "x-missing", machines: [], capacity: 1, reached: 0, reason: null },
  ];

  it("maps each read-out to its card, its rows to port keys and resources, and drops nothing it can name", () => {
    const { result } = run(p(), () =>
      solved({
        machineCounts: { a: 4, b: 1.5, s: 1, "s#r1": 0 },
        extentsPerSecond: { a: 4, b: 1.5, s: 1, "s#r1": 0 },
        upTo: readouts.slice(0, 3),
      }),
    );
    const upTo = result.plan!.upTo!;
    expect(Object.keys(upTo).sort()).toEqual(["a", "b", "s"]);
    expect(upTo["a"]).toEqual({ capacity: 4, reached: 4, reason: "BOTTLENECK", wants: 6 });
    expect(upTo["b"]).toEqual({
      capacity: 3,
      reached: 1.5,
      reason: "STARVED",
      portKey: "b|i|input:item:y",
      resourceKey: "item:y",
      tied: ["b|i|input:item:y"],
      upstream: ["a"],
    });
    // a shared card's pool is one entry under the card's id, its upstream in card ids, once each
    expect(upTo["s"]).toMatchObject({
      reason: "CLOGGED",
      portKey: "s#r1|o|output:item:w",
      resourceKey: "item:w",
      upstream: ["s"],
    });
  });

  it("a shared card's recipes keep their own counts: the pool's reached is not section 0's", () => {
    const { result } = run(p(), () =>
      solved({
        machineCounts: { a: 4, b: 1.5, s: 0.75, "s#r1": 0.25 },
        extentsPerSecond: { a: 4, b: 1.5, s: 0.75, "s#r1": 0.25 },
        upTo: readouts.slice(0, 3),
      }),
    );
    expect(result.nodes["s"]!.theoreticalMachinesRequired).toBeCloseTo(0.75, 9);
    expect(result.nodes["s#r1"]!.theoreticalMachinesRequired).toBeCloseTo(0.25, 9);
    // a single card takes what its read-out reached
    expect(result.nodes["b"]!.theoreticalMachinesRequired).toBe(1.5);
  });

  it("omits upTo and shortfalls when the answer has none", () => {
    const { result } = run(p(), () => solved({}));
    expect(result.plan!.upTo).toBeUndefined();
    expect(result.plan!.shortfalls).toBeUndefined();
  });

  it("maps every shortfall's limiting machines to deduplicated card ids, in order", () => {
    const { result } = run(p(), () =>
      solved({
        drawers: {
          rates: {},
          unmet: ["out"],
          shortfalls: [
            {
              drawer: "out",
              rule: "AT_LEAST",
              target: 5,
              reachable: 3,
              limitingNodes: ["s#r1", "b", "s", "b"],
              limitingDrawers: ["other"],
              limitingGroups: 0,
            },
          ],
          ports: {},
        },
      }),
    );
    expect(result.plan!.shortfalls).toEqual([
      {
        drawerId: "out",
        rule: "AT_LEAST",
        target: 5,
        reachable: 3,
        limitingCards: ["s", "b"],
        limitingDrawers: ["other"],
      },
    ]);
  });
});

describe("the nodes: an Up to card's utilization and status", () => {
  const p = () =>
    project({
      recipes: [recipe("a", [["x", 1]], [["y", 1]])],
      nodes: [
        node("full", "a", { solvePin: 4 }),
        node("short", "a", { solvePin: 4 }),
        node("wide", "a", { solvePin: 4 }),
        node("any", "a"),
      ],
    });
  const answer = () =>
    solved({
      machineCounts: { full: 4, short: 1, wide: 4, any: 2 },
      extentsPerSecond: { full: 4, short: 1, wide: 4, any: 2 },
      upTo: [
        { node: "full", machines: ["full"], capacity: 4, reached: 4, reason: "FULL" },
        { node: "short", machines: ["short"], capacity: 4, reached: 1, reason: "STARVED" },
        {
          node: "wide",
          machines: ["wide"],
          capacity: 4,
          reached: 4,
          reason: "BOTTLENECK",
          wants: 7,
        },
      ],
    });

  it("a running card is fully used at what it reached, the count is what was reached, the status follows the reason", () => {
    const { result } = run(p(), answer);
    const n = result.nodes;
    expect([
      n["full"]!.utilization,
      n["full"]!.status,
      n["full"]!.theoreticalMachinesRequired,
    ]).toEqual([1, "balanced", 4]);
    // Its flows are at the reached count already: readers scale flows by utilization, so it stays 1.
    expect([
      n["short"]!.utilization,
      n["short"]!.status,
      n["short"]!.theoreticalMachinesRequired,
    ]).toEqual([1, "underutilized", 1]);
    expect([n["wide"]!.utilization, n["wide"]!.status]).toEqual([1, "bottleneck"]);
    // a card with no rule keeps what it had
    expect([
      n["any"]!.utilization,
      n["any"]!.status,
      n["any"]!.theoreticalMachinesRequired,
    ]).toEqual([1, "balanced", 2]);
  });
});

describe("pins", () => {
  it("a pin is Up to unless it is exact: each card a pool of its own at its count", () => {
    const { input } = run(
      project({
        recipes: [recipe("a", [["x", 1]], [["y", 1]])],
        nodes: [node("a", "a", { solvePin: 3 }), node("b", "a", { solvePin: 2 })],
      }),
    );
    expect(
      input.pools.map((pool) => [pool.machines[0], pool.capacity, pool.exact, pool.upTo]),
    ).toEqual([
      ["a", 3, false, true],
      ["b", 2, false, true],
    ]);
    expect(input.machines.every((m) => !m.countFixed)).toBe(true);
  });

  it("a custom rate card stays exact beside an Up to pin", () => {
    const rate = customRecipe("rate", "x", 3, "supply");
    const { input } = run(
      project({
        recipes: [recipe("a", [["x", 1]], [["y", 1]]), rate],
        nodes: [node("a", "a", { solvePin: 2 }), node("c", "rate")],
      }),
    );
    expect(input.pools.map((pool) => pool.machines[0])).toEqual(["a"]);
    const c = input.machines.find((m) => m.id === "c")!;
    expect([c.countFixed, c.machineCount]).toEqual([true, 1]);
  });
});
