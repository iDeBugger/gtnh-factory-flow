import { describe, expect, it } from "vitest";
import { parseFactoryProjectJson, serializeFactoryProject } from "@/lib/import-export/factory-json";
import { decodePlanCode, encodePlanCode } from "@/lib/import-export/plan-code";
import { mockLeftovers } from "@/lib/solver/plan/__fixtures__/mock-extras";
import { boardSelectionPayloadSchema, factoryNodeSchema, factoryProjectSchema } from "./schemas";
import { normalizeLoadedProject } from "./project-normalize";
import type { FactoryProject } from "./types";

/**
 * Plan mode's new persisted fields (`planMode`, `spareShares`, node
 * `portRates`) must survive every path a project takes: the schemas strip
 * unknown keys, so an undeclared field silently disappears on that path.
 */

const NODE_RATES = { "output:item:Bronze%20Ingot": 2.5, "r1:input:fluid:water": 40 };

function planProject(): FactoryProject {
  const base = mockLeftovers.project;
  return {
    ...base,
    nodes: base.nodes.map((node, i) => (i === 0 ? { ...node, portRates: NODE_RATES } : node)),
  };
}

function expectFields(project: FactoryProject) {
  expect(project.planMode).toBe(true);
  expect(project.solveMode).toBe(true);
  expect(project.spareShares).toEqual(mockLeftovers.project.spareShares);
  expect(project.nodes[0]!.portRates).toEqual(NODE_RATES);
  expect(project.nodes[1]!.portRates).toBeUndefined();
}

describe("plan mode fields survive every path", () => {
  it("the project schema keeps them", () => {
    expectFields(factoryProjectSchema.parse(JSON.parse(JSON.stringify(planProject()))) as FactoryProject);
  });

  it("JSON export and import", () => {
    expectFields(parseFactoryProjectJson(serializeFactoryProject(planProject())));
  });

  it("plan code and link", async () => {
    expectFields(await decodePlanCode(await encodePlanCode(planProject())));
  });

  // The community post routes (create and edit) and the account library sync
  // each parse the uploaded plan with
  // factoryProjectSchema and store/forward `parsed.data`; the request body is
  // JSON. Round-trip exactly that.
  it("community post and library sync bodies", () => {
    const body = JSON.parse(JSON.stringify({ plan: planProject() }));
    const parsed = factoryProjectSchema.safeParse(body.plan);
    expect(parsed.success).toBe(true);
    expectFields(parsed.data as FactoryProject);
  });

  it("blueprint and clipboard payloads carry a card's port rates", () => {
    const project = planProject();
    const parsed = boardSelectionPayloadSchema.parse({
      productionGroups: [],
      nodes: project.nodes,
      storages: project.storages ?? [],
      annotations: [],
      pockets: [],
      edges: project.edges,
      recipes: project.recipes,
    });
    expect(parsed.nodes[0]!.portRates).toEqual(NODE_RATES);
  });

  it("loading a plan-mode project that lost solveMode puts it back, and drops pool", () => {
    const loaded = normalizeLoadedProject({ ...planProject(), solveMode: undefined, poolMode: true });
    expect(loaded.solveMode).toBe(true);
    expect(loaded.poolMode).toBeUndefined();
    expect(loaded.planMode).toBe(true);
    // A project not in plan mode is untouched.
    // A pool project is converted: there is one mode.
    const classic = normalizeLoadedProject({ ...planProject(), planMode: undefined, poolMode: true });
    expect(classic.poolMode).toBeUndefined();
    expect(classic.planMode).toBe(true);
  });

  it("keeps the old shape: a project without the fields parses without them", () => {
    const { planMode: _p, spareShares: _s, ...old } = planProject();
    void _p;
    void _s;
    const parsed = factoryProjectSchema.parse(JSON.parse(JSON.stringify(old)));
    expect(parsed.planMode).toBeUndefined();
    expect(parsed.spareShares).toBeUndefined();
  });
});

describe("plan mode field bounds", () => {
  const node = JSON.parse(JSON.stringify(mockLeftovers.project.nodes[0]));

  it("a port rate must be positive and finite", () => {
    expect(factoryNodeSchema.safeParse({ ...node, portRates: { a: 0 } }).success).toBe(false);
    expect(factoryNodeSchema.safeParse({ ...node, portRates: { a: -1 } }).success).toBe(false);
    expect(factoryNodeSchema.safeParse({ ...node, portRates: { "": 1 } }).success).toBe(false);
    expect(factoryNodeSchema.safeParse({ ...node, portRates: { a: 1 } }).success).toBe(true);
  });

  it("a hand-made plan cannot carry a huge map", () => {
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, 1]));
    expect(factoryNodeSchema.safeParse({ ...node, portRates: many }).success).toBe(false);
  });

  it("a spare share is a fraction", () => {
    const plan = JSON.parse(JSON.stringify(planProject()));
    expect(factoryProjectSchema.safeParse({ ...plan, spareShares: { k: { b: 1.5 } } }).success).toBe(false);
    expect(factoryProjectSchema.safeParse({ ...plan, spareShares: { k: { b: -0.1 } } }).success).toBe(false);
    expect(factoryProjectSchema.safeParse({ ...plan, spareShares: { k: { b: 0.5 } } }).success).toBe(true);
  });
});
