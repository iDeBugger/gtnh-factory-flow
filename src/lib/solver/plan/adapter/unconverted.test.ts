import { describe, expect, it } from "vitest";
import type { FactoryNode, UnconvertedRecipe } from "../../../model/types";
import { calculateThroughput } from "../../throughput";
import { buildPlanModel } from "./model";
import { drawer, handle, node, project, recipe, wire } from "./test-kit";

/**
 * A card whose recipe was not converted to the plan's version (`FactoryNode.unconverted`) is out of the solve, and its
 * wires are the plan's edge: what it would feed a machine is an outside input, what a machine feeds it leaves the plan.
 */
const marker: UnconvertedRecipe = {
  fromGameVersion: "2.9",
  recipeId: "old",
  recipeName: "Old recipe",
  machineType: "Mock Machine",
};

const unconverted = (id: string, recipeId: string, extra: Partial<FactoryNode> = {}) =>
  node(id, recipeId, { unconverted: marker, ...extra });

const criticals = (result: ReturnType<typeof calculateThroughput>) =>
  result.bottlenecks.filter((issue) => issue.severity === "critical");

describe("an unconverted card stays out of the solve", () => {
  it("upstream: an unconverted card's output wire is an outside input", () => {
    // A(unconverted) -> B -> C(product 1/s): B runs at 1/s, its input imported through A's wire.
    const plan = project({
      recipes: [recipe("a", [["x", 1]], [["y", 1]]), recipe("b", [["y", 1]], [["z", 1]])],
      nodes: [unconverted("A", "a"), node("B", "b")],
      storages: [drawer("C", "z", { targetPerSecond: 1, targetMode: "at-least" })],
      edges: [wire("ab", "A", "B", "y"), wire("bc", "B", "C", "z", {}, { toDrawer: true })],
    });
    const result = calculateThroughput(plan, { generatedAt: "t" });
    expect(result.plan?.failure).toBeUndefined();
    expect(result.nodes["B"]!.theoreticalMachinesRequired).toBeCloseTo(1, 6);
    expect(result.edges["ab"]!.transferredPerSecond).toBeCloseTo(1, 6);
    expect(result.nodes["A"]).toMatchObject({ status: "missing-recipe", unconverted: true });
    // The card's warning names the version it is missing from and what its wires stand for.
    expect(result.nodes["A"]!.warnings).toEqual([
      "Not in GTNH 2.9, so it is left out of the solve. Its wires count as outside inputs and outputs.",
    ]);
  });

  it("downstream in Build: a machine feeding an unconverted card runs at its fed rate", () => {
    // S(source) -> B (count 2) -> A(unconverted): B runs full, and its output leaves the plan through A's wire.
    const plan = project({
      recipes: [recipe("a", [["y", 1]], [["w", 1]]), recipe("b", [["x", 1]], [["y", 1]])],
      nodes: [node("B", "b", { solvePin: 2 }), unconverted("A", "a")],
      storages: [drawer("S", "x")],
      edges: [wire("sb", "S", "B", "x", {}, { fromDrawer: true }), wire("ba", "B", "A", "y")],
    });
    const result = calculateThroughput(plan, { generatedAt: "t" });
    expect(result.plan?.failure).toBeUndefined();
    expect(result.nodes["B"]!.theoreticalMachinesRequired).toBeCloseTo(2, 6);
    expect(result.edges["ba"]!.transferredPerSecond).toBeCloseTo(2, 6);
    expect(result.edges["sb"]!.transferredPerSecond).toBeCloseTo(2, 6);
  });

  it("downstream in Solve: a machine feeding only an unconverted card has no demand", () => {
    const plan = project({
      recipes: [recipe("a", [["y", 1]], [["w", 1]]), recipe("b", [["x", 1]], [["y", 1]])],
      nodes: [node("B", "b"), unconverted("A", "a")],
      storages: [drawer("S", "x")],
      edges: [wire("sb", "S", "B", "x", {}, { fromDrawer: true }), wire("ba", "B", "A", "y")],
    });
    const result = calculateThroughput(plan, { generatedAt: "t" });
    expect(result.nodes["B"]!.theoreticalMachinesRequired).toBeCloseTo(0, 6);
    expect(result.edges["ba"]!.transferredPerSecond).toBeCloseTo(0, 6);
    expect(criticals(result)).toEqual([]);
  });

  it("downstream in Solve: the machine's count comes from its other demands", () => {
    // B makes y (to the unconverted card) and v (asked 1/s): B is sized by v, and its y leaves the plan.
    const plan = project({
      recipes: [
        recipe("a", [["y", 1]], [["w", 1]]),
        recipe("b", [["x", 1]], [
          ["y", 1],
          ["v", 1],
        ]),
      ],
      nodes: [node("B", "b"), unconverted("A", "a")],
      storages: [drawer("S", "x"), drawer("V", "v", { targetPerSecond: 1, targetMode: "at-least" })],
      edges: [
        wire("sb", "S", "B", "x", {}, { fromDrawer: true }),
        wire("ba", "B", "A", "y"),
        wire("bv", "B", "V", "v", {}, { toDrawer: true }),
      ],
    });
    const result = calculateThroughput(plan, { generatedAt: "t" });
    expect(result.plan?.failure).toBeUndefined();
    expect(result.nodes["B"]!.theoreticalMachinesRequired).toBeCloseTo(1, 6);
    expect(result.edges["ba"]!.transferredPerSecond).toBeCloseTo(1, 6);
  });

  it("a plan with an unconverted card is not reported unsolved", () => {
    // The marked card's recipe id still resolves (another card on it converted): it stays out all the same.
    const plan = project({
      recipes: [recipe("a", [["x", 1]], [["y", 1]]), recipe("b", [["y", 1]], [["z", 1]])],
      nodes: [unconverted("A", "a"), node("A2", "a"), node("B", "b", { solvePin: 1 })],
      storages: [drawer("X", "x"), drawer("Z", "z")],
      edges: [
        wire("xa2", "X", "A2", "x", {}, { fromDrawer: true }),
        wire("ab", "A", "B", "y"),
        wire("bz", "B", "Z", "z", {}, { toDrawer: true }),
      ],
    });
    const result = calculateThroughput(plan, { generatedAt: "t" });
    expect(result.plan?.failure).toBeUndefined();
    expect(criticals(result)).toEqual([]);
    expect(result.bottlenecks).toContainEqual(
      expect.objectContaining({ id: "missing-recipe:A", kind: "missing-recipe", severity: "warning" }),
    );
    expect(result.nodes["A"]).toMatchObject({
      status: "missing-recipe",
      unconverted: true,
      operationRatePerSecond: 0,
      inputs: {},
      outputs: {},
    });
    expect(result.nodes["B"]!.theoreticalMachinesRequired).toBeCloseTo(1, 6);
  });

  it("an unconverted section of a shared card is out, and its wires are outside inputs", () => {
    // Card K runs "k" (section 0) and "a" (section 1, unconverted, y out to B). B (count 1) is fed from outside.
    const plan = project({
      recipes: [
        recipe("k", [["p", 1]], [["q", 1]]),
        recipe("a", [["x", 1]], [["y", 1]]),
        recipe("b", [["y", 1]], [["z", 1]]),
      ],
      nodes: [
        node("K", "k", { solvePin: 1, extraRecipes: [{ recipeId: "a", unconverted: marker }] }),
        node("B", "b", { solvePin: 1 }),
      ],
      storages: [drawer("P", "p"), drawer("Q", "q"), drawer("Z", "z")],
      edges: [
        wire("pk", "P", "K", "p", {}, { fromDrawer: true }),
        wire("kq", "K", "Q", "q", {}, { toDrawer: true }),
        { ...wire("kb", "K", "B", "y"), sourceHandle: handle("output", "y", 1) },
        wire("bz", "B", "Z", "z", {}, { toDrawer: true }),
      ],
    });
    const result = calculateThroughput(plan, { generatedAt: "t" });
    expect(result.plan?.failure).toBeUndefined();
    expect(result.nodes["K#r1"]).toMatchObject({ status: "missing-recipe", unconverted: true });
    expect(result.nodes["K"]!.status).not.toBe("missing-recipe");
    expect(result.nodes["K"]!.theoreticalMachinesRequired).toBeCloseTo(1, 6);
    expect(result.nodes["B"]!.theoreticalMachinesRequired).toBeCloseTo(1, 6);
    expect(result.edges["kb"]!.transferredPerSecond).toBeCloseTo(1, 6);
  });

  it("the synthetic drawers live only in the plan model, one per wire, with rule ANY", () => {
    const plan = project({
      recipes: [
        recipe("a", [["y", 1]], [["y2", 1]]),
        recipe("b", [["x", 1]], [["y", 1]]),
        recipe("c", [["y2", 1]], [["z", 1]]),
      ],
      nodes: [node("B", "b", { solvePin: 1 }), unconverted("A", "a"), node("C", "c")],
      storages: [drawer("S", "x")],
      edges: [
        wire("sb", "S", "B", "x", {}, { fromDrawer: true }),
        wire("ba", "B", "A", "y"),
        wire("ac", "A", "C", "y2"),
      ],
    });
    const result = calculateThroughput(plan, { generatedAt: "t" });
    expect(Object.keys(result.storages)).toEqual(["S"]);
    expect(plan.storages!.map((storage) => storage.id)).toEqual(["S"]);
    const model = buildPlanModel({
      project: plan,
      nodes: calculateThroughputNodes(plan),
      storages: {},
      projectStorages: plan.storages ?? [],
      bottlenecks: [],
      options: {},
    });
    const synthetic = model.input.drawers.filter((entry) => entry.id.startsWith("unconverted:"));
    expect(synthetic.map(({ id, kind, rule }) => ({ id, kind, rule }))).toEqual([
      { id: "unconverted:ac", kind: "SOURCE", rule: "ANY" },
      { id: "unconverted:ba", kind: "PRODUCT", rule: "ANY" },
    ]);
    expect(model.unanchored).not.toContain("unconverted:ac");
  });
});

describe("every wire of an unconverted card is the plan's edge, whatever the other end is", () => {
  const recipes = [
    recipe("a", [["x", 1]], [["y", 1]]),
    recipe("b", [["y", 1]], [["z", 1]]),
    recipe("s", [["w", 1]], [["x", 1]]),
  ];

  it("card -> buffer -> machine: the buffer's taker is fed from outside, in Build and in Solve", () => {
    const plan = (pin?: number, target?: number) =>
      project({
        recipes,
        nodes: [unconverted("A", "a"), node("B", "b", pin ? { solvePin: pin } : {})],
        storages: [
          drawer("buf", "y"),
          drawer("C", "z", target ? { targetPerSecond: target, targetMode: "at-least" } : {}),
        ],
        edges: [
          wire("ab", "A", "buf", "y", {}, { toDrawer: true }),
          wire("bb", "buf", "B", "y", {}, { fromDrawer: true }),
          wire("bc", "B", "C", "z", {}, { toDrawer: true }),
        ],
      });
    const solve = calculateThroughput(plan(undefined, 1), { generatedAt: "t" });
    expect(solve.plan?.failure).toBeUndefined();
    expect(criticals(solve)).toEqual([]);
    expect(solve.nodes["B"]!.theoreticalMachinesRequired).toBeCloseTo(1, 6);
    expect(solve.edges["ab"]!.transferredPerSecond).toBeCloseTo(1, 6);
    expect(solve.edges["bb"]!.transferredPerSecond).toBeCloseTo(1, 6);

    const build = calculateThroughput(plan(2), { generatedAt: "t" });
    expect(build.plan?.failure).toBeUndefined();
    expect(build.nodes["B"]!.theoreticalMachinesRequired).toBeCloseTo(2, 6);
    expect(build.edges["ab"]!.transferredPerSecond).toBeCloseTo(2, 6);
  });

  it("machine -> buffer -> card: the buffer's maker ships out of the plan in Build, and has no demand in Solve", () => {
    const plan = (pin?: number) =>
      project({
        recipes,
        nodes: [node("S", "s", pin ? { solvePin: pin } : {}), unconverted("A", "a")],
        storages: [drawer("W", "w"), drawer("buf", "x")],
        edges: [
          wire("ws", "W", "S", "w", {}, { fromDrawer: true }),
          wire("sb", "S", "buf", "x", {}, { toDrawer: true }),
          wire("ba", "buf", "A", "x", {}, { fromDrawer: true }),
        ],
      });
    const build = calculateThroughput(plan(2), { generatedAt: "t" });
    expect(build.plan?.failure).toBeUndefined();
    expect(build.nodes["S"]!.theoreticalMachinesRequired).toBeCloseTo(2, 6);
    expect(build.edges["sb"]!.transferredPerSecond).toBeCloseTo(2, 6);
    expect(build.edges["ba"]!.transferredPerSecond).toBeCloseTo(2, 6);

    const solve = calculateThroughput(plan(), { generatedAt: "t" });
    expect(criticals(solve)).toEqual([]);
    expect(solve.nodes["S"]!.theoreticalMachinesRequired).toBeCloseTo(0, 6);
  });

  it("card <-> source or product drawer: the drawer has no machine and is left out; the plan still solves", () => {
    // Build: B pinned at 1. Solve: B unpinned, Z asks 1/s.
    const plan = (pin?: number) =>
      project({
        recipes,
        nodes: [unconverted("A", "a"), node("B", "b", pin ? { solvePin: pin } : {})],
        storages: [
          drawer("X", "x"),
          drawer("P", "y"),
          drawer("Y", "y"),
          drawer("Z", "z", pin ? {} : { targetPerSecond: 1, targetMode: "at-least" }),
        ],
        edges: [
          wire("xa", "X", "A", "x", {}, { fromDrawer: true }),
          wire("ap", "A", "P", "y", {}, { toDrawer: true }),
          wire("yb", "Y", "B", "y", {}, { fromDrawer: true }),
          wire("bz", "B", "Z", "z", {}, { toDrawer: true }),
        ],
      });
    for (const pin of [1, undefined]) {
      const p = plan(pin);
      const result = calculateThroughput(p, { generatedAt: "t" });
      expect(result.plan?.failure).toBeUndefined();
      expect(criticals(result)).toEqual([]);
      expect(result.nodes["B"]!.theoreticalMachinesRequired).toBeCloseTo(1, 6);
      expect(result.edges["xa"]!.transferredPerSecond).toBe(0);
      expect(result.edges["ap"]!.transferredPerSecond).toBe(0);
      const model = buildPlanModel({
        project: p,
        nodes: calculateThroughputNodes(p),
        storages: {},
        projectStorages: p.storages ?? [],
        bottlenecks: [],
        options: {},
      });
      const ids = model.input.drawers.map((entry) => entry.id);
      expect(ids).not.toContain("X");
      expect(ids).not.toContain("P");
      expect(ids.filter((id) => id.startsWith("unconverted:"))).toEqual([]);
    }
  });
});

describe("a shared card whose section 0 is unconverted", () => {
  // Card K: section 0 runs "k" (unconverted), section 1 runs "b" (y -> z), fed from Y and shipping to Z.
  const plan = (extra: Partial<FactoryNode>) =>
    project({
      recipes: [recipe("k", [["p", 1]], [["q", 1]]), recipe("b", [["y", 1]], [["z", 1]])],
      nodes: [unconverted("K", "k", { extraRecipes: [{ recipeId: "b" }], ...extra })],
      storages: [drawer("Y", "y"), drawer("Z", "z")],
      edges: [
        { ...wire("yk", "Y", "K", "y", {}, { fromDrawer: true }), targetHandle: handle("input", "y", 1) },
        { ...wire("kz", "K", "Z", "z", {}, { toDrawer: true }), sourceHandle: handle("output", "z", 1) },
      ],
    });

  it("the card's pin still holds its other sections", () => {
    const result = calculateThroughput(plan({ solvePin: 3, solvePinExact: true }), { generatedAt: "t" });
    expect(result.plan?.failure).toBeUndefined();
    expect(result.nodes["K"]).toMatchObject({ status: "missing-recipe", unconverted: true });
    expect(result.nodes["K#r1"]!.unconverted).toBeUndefined();
    expect(result.nodes["K#r1"]!.theoreticalMachinesRequired).toBeCloseTo(3, 6);
    expect(result.edges["kz"]!.transferredPerSecond).toBeCloseTo(3, 6);
  });

  it("the card's port rate on another section is honoured", () => {
    const result = calculateThroughput(plan({ portRates: { [handle("output", "z", 1)]: 2 } }), { generatedAt: "t" });
    expect(result.plan?.failure).toBeUndefined();
    expect(result.nodes["K#r1"]!.theoreticalMachinesRequired).toBeCloseTo(2, 6);
    expect(result.edges["kz"]!.transferredPerSecond).toBeCloseTo(2, 6);
  });
});

/** The nameplate reports `calculateThroughput` hands the adapter. */
function calculateThroughputNodes(plan: ReturnType<typeof project>) {
  return calculateThroughput(plan, { generatedAt: "t" }).nodes;
}
