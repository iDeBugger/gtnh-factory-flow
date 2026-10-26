import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeLoadedProject } from "@/lib/model/project-normalize";
import { loadGolden, loadInput } from "../__fixtures__/load";
import { solveForTest } from "../__fixtures__/solve-entry";
import { calculateThroughput } from "../../throughput";
import type { SolveInput } from "../types";
import { setSolveCore } from "./engine";

/**
 * Parity of the adapter with the mod (spec-adapter 5, levels 1 to 3), on the
 * three plans the website and the mod share. The mod's corpus inputs were
 * built from in-game recipes, so names and some durations differ; every
 * difference is listed here, nothing is left to a tolerance.
 */

const FIXTURES = {
  alumina: ["../../../../components/flow/__fixtures__/alumina-line-shared-reactor.json", "alumina-line-shared-reactor"],
  titanium: ["../../../../components/flow/__fixtures__/titanium-line-chembath.json", "titanium-line-chembath"],
  "pa-cell": ["../../__fixtures__/pa-cell-loop-plan.json", "pa-cell-loop"],
} as const;

afterEach(() => setSolveCore(undefined));

/**
 * The mod's corpus dumps were made by an importer that joined every buffer drawer into wires; the adapter now passes a
 * buffer wired only to cards as a BUFFER drawer (`docs/buffer-drawers.md`). With rule Any the solver answers a buffer
 * exactly as those wires (the mod's `BufferDrawerTest.aBufferWithRuleAnyAnswersAsPlainWires`), so the comparison joins
 * them the same way: each maker wired to each user of the same ingredient.
 */
function joinBuffers(input: SolveInput): SolveInput {
  const byId = new Map(input.machines.map((m) => [m.id, m]));
  const edges = [...input.edges];
  for (const d of input.drawers) {
    if (d.kind !== "BUFFER") continue;
    expect(d.rule).toBe("ANY");
    for (const from of d.links)
      for (const to of d.takers ?? []) {
        if (byId.get(from.node)!.outputs[from.port]!.resource !== byId.get(to.node)!.inputs[to.port]!.resource) continue;
        edges.push({ id: `${d.id}>${from.node}>${to.node}`, source: from.node, sourceOutput: from.port, target: to.node, targetInput: to.port });
      }
  }
  return { ...input, edges, drawers: input.drawers.filter((d) => d.kind !== "BUFFER") };
}

/**
 * A converted Build plan's pins are Up to (docs/up-to.md), but the mod's corpus still has exact pins (the mod re-dump
 * follows the mod's Up to port). This reads the Up to pools the way the mod's inputs spell them: a one-machine Up to
 * pool is a fixed count at its capacity, a shared card's is an exact pool. Everything else compares as it was.
 */
function asExactPins(input: SolveInput): SolveInput {
  const single = new Map(input.pools.filter((p) => p.upTo && p.machines.length === 1).map((p) => [p.machines[0]!, p.capacity]));
  return {
    ...input,
    machines: input.machines.map((m) =>
      single.has(m.id) ? { ...m, countFixed: true, machineCount: single.get(m.id)! } : m,
    ),
    pools: input.pools
      .filter((p) => !(p.upTo && p.machines.length === 1))
      .map(({ upTo, ...p }) => (upTo ? { ...p, exact: true } : p)),
  };
}

function adapterInput(path: string): SolveInput {
  return joinBuffers(asExactPins(adapterInputWithBuffers(path)));
}

function adapterInputWithBuffers(path: string): SolveInput {
  const project = normalizeLoadedProject(JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")));
  let got: SolveInput | undefined;
  setSolveCore((input) => {
    got = input;
    return {
      kind: "failed",
      failure: { message: "NO_PIN", args: [] },
      notes: [],
      drawers: { rates: {}, unmet: [], shortfalls: [], ports: {} },
    };
  });
  calculateThroughput(project, { generatedAt: "t" });
  setSolveCore(undefined);
  return got!;
}

// The game spells it "Phosphorus"; the website's data "Phosphorous".
const norm = (name: string) => name.replace(/Phosphorous/g, "Phosphorus");

function signatures(input: SolveInput, withTimes: boolean) {
  const byId = new Map(input.machines.map((m) => [m.id, m]));
  const machineSig = (id: string) => {
    const m = byId.get(id)!;
    const times = withTimes ? `D${m.durationTicks}/T${m.throughputFactor}/` : "";
    const pin = m.countFixed ? `pin${m.machineCount}` : "free";
    return norm(
      `${times}${m.inputs.map((p) => p.name).sort().join("+")}=>${m.outputs.map((p) => p.name).sort().join("+")}/${pin}`,
    );
  };
  const machines = input.machines.map((m) => machineSig(m.id)).sort();
  const edges = input.edges
    .map((e) => {
      const s = byId.get(e.source)!;
      const t = byId.get(e.target)!;
      return norm(`${machineSig(e.source)}.${s.outputs[e.sourceOutput]!.name}>${machineSig(e.target)}.${t.inputs[e.targetInput]!.name}`);
    })
    .sort();
  // one entry per link, so a drawer the website split in two and the game joined compares equal
  const links = input.drawers
    .flatMap((d) =>
      d.links.map((l) => {
        const m = byId.get(l.node)!;
        const port = (d.kind === "SOURCE" ? m.inputs : m.outputs)[l.port]!;
        return norm(`${d.kind}/${d.rule}:${machineSig(l.node)}.${port.name}`);
      }),
    )
    .sort();
  const pools = input.pools.map((p) => `${p.machines.length}x${p.capacity}${p.exact ? "=" : "<="}`).sort();
  return { machines, edges, links, pools };
}

describe("adapter vs the mod's corpus: structure (level 2)", () => {
  for (const [name, [path, corpus]] of Object.entries(FIXTURES)) {
    const mine = () => adapterInput(path);
    const theirs = () => loadInput(corpus);

    it(`${name}: same sizes`, () => {
      const a = mine();
      const b = theirs();
      expect(a.machines.length).toBe(b.machines.length);
      expect(a.edges.length).toBe(b.edges.length);
      expect(a.pools.map((p) => [p.machines.length, p.capacity, p.exact])).toEqual(
        b.pools.map((p) => [p.machines.length, p.capacity, p.exact]),
      );
      expect(a.machines.filter((m) => m.countFixed).length).toBe(b.machines.filter((m) => m.countFixed).length);
      const links = (i: SolveInput) => i.drawers.reduce((n, d) => n + d.links.length, 0);
      expect(links(a)).toBe(links(b));
    });

    it(`${name}: same machines, wires, drawer links and pins (ports and pins, not times)`, () => {
      const a = signatures(mine(), false);
      const b = signatures(theirs(), false);
      expect(a.machines).toEqual(b.machines);
      expect(a.edges).toEqual(b.edges);
      expect(a.links).toEqual(b.links);
      expect(a.pools).toEqual(b.pools);
    });
  }

  it("titanium and pa-cell match to the last duration and parallel", () => {
    for (const name of ["titanium", "pa-cell"] as const) {
      const [path, corpus] = FIXTURES[name];
      expect(signatures(adapterInput(path), true)).toEqual(signatures(loadInput(corpus), true));
    }
  });

  for (const [name, [path, corpus]] of Object.entries(FIXTURES)) {
    it(`${name}: every pin of the mod's input is an Up to pool of the same capacity`, () => {
      const mine = adapterInputWithBuffers(path);
      const theirs = loadInput(corpus);
      // The converted plan fixes no count of its own: each built count is an Up to pool.
      expect(mine.machines.filter((m) => m.countFixed)).toEqual([]);
      const caps = (pools: SolveInput["pools"]) => pools.map((p) => [p.machines.length, p.capacity]);
      const singles = mine.pools.filter((p) => p.upTo && p.machines.length === 1);
      expect(singles.map((p) => p.capacity).sort((x, y) => x - y)).toEqual(
        theirs.machines.filter((m) => m.countFixed).map((m) => m.machineCount).sort((x, y) => x - y),
      );
      const shared = mine.pools.filter((p) => !(p.upTo && p.machines.length === 1));
      expect(caps(shared)).toEqual(caps(theirs.pools));
      expect(shared.every((p) => p.upTo && !p.exact)).toBe(true);
    });
  }

  it("alumina differs in exactly the three machines the settings differ on", () => {
    // Website: Calcite -> Quicklime LCR D0.5 x1, Sodium Aluminate -> Alumina Hydroxide D0.5 x1, Mixer D25.
    // Game dump: D1 x2, D1 x2, D66 (a lower tier). Same craft rate per machine for the first two.
    const [path, corpus] = FIXTURES.alumina;
    const a = adapterInput(path);
    const b = loadInput(corpus);
    const times = (i: SolveInput) =>
      i.machines.map((m) => `${m.durationTicks}/${m.throughputFactor}`).sort();
    const ta = times(a);
    const tb = times(b);
    const diff = ta.filter((t) => !tb.includes(t));
    expect(diff.sort()).toEqual(["0.5/1", "0.5/1", "25/40"]);
    expect(tb.filter((t) => !ta.includes(t)).sort()).toEqual(["1/2", "1/2", "66/40"]);
    // The game joins the two Water inputs of the aluminate and hydroxide machines in one drawer.
    expect(a.drawers.length).toBe(b.drawers.length + 1);
  });
});

describe("buffers the website plans carry", () => {
  it("come over as buffer drawers, each joined to cards on both sides", () => {
    for (const name of ["titanium", "pa-cell"] as const) {
      const buffers = adapterInputWithBuffers(FIXTURES[name][0]).drawers.filter((d) => d.kind === "BUFFER");
      expect(buffers.length, name).toBeGreaterThan(0);
      for (const b of buffers) {
        expect(b.links.length).toBeGreaterThan(0);
        expect(b.takers!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe.skipIf(solveForTest === null)("adapter + solver vs the mod's goldens (level 3)", () => {
  it("solved with its buffers as buffer drawers, each plan sizes its machines as the golden does", async () => {
    for (const name of ["titanium", "pa-cell"] as const) {
      const [path, corpus] = FIXTURES[name];
      const answer = await solveForTest!(asExactPins(adapterInputWithBuffers(path)));
      expect(answer.kind).toBe("solved");
      if (answer.kind !== "solved") return;
      const golden = loadGolden(corpus).solution as { machineCounts: Record<string, number> };
      const sortNums = (xs: number[]) => xs.map((x) => Math.round(x * 1e6) / 1e6).sort((p, q) => p - q);
      expect(sortNums(Object.values(answer.solution.machineCounts)), name).toEqual(
        sortNums(Object.values(golden.machineCounts)),
      );
    }
  });

  for (const name of ["titanium", "pa-cell"] as const) {
    it(`${name}: a plan that is all pins answers with the golden's counts and flows`, async () => {
      const [path, corpus] = FIXTURES[name];
      const a = adapterInput(path);
      const answer = await solveForTest!(a);
      expect(answer.kind).toBe("solved");
      if (answer.kind !== "solved") return;
      const golden = loadGolden(corpus).solution as {
        machineCounts: Record<string, number>;
        edgeFlowsPerSecond: Record<string, number>;
      };
      const sortNums = (xs: number[]) => xs.map((x) => Math.round(x * 1e6) / 1e6).sort((p, q) => p - q);
      expect(sortNums(Object.values(answer.solution.machineCounts))).toEqual(sortNums(Object.values(golden.machineCounts)));
      expect(sortNums(Object.values(answer.solution.edgeFlowsPerSecond))).toEqual(
        sortNums(Object.values(golden.edgeFlowsPerSecond)),
      );
    });
  }
});
