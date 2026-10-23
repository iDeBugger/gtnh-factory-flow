import { describe, expect, it } from "vitest";
import { loadBiodieselDemoProject } from "@/examples";
import type { FactoryProject } from "../model/types";
import { noteRestorableRecipes } from "../datasets/restorable-recipes";
import { parseFactoryProjectJson, serializeFactoryProject } from "./factory-json";
import {
  decodePlanCode,
  encodePlanCode,
  planCodeLink,
  readPlanCodeFromHash,
  withoutRuntimeTables,
} from "./plan-code";

/** The demo, with a GregTech overclock table and a crop table on its recipes. */
function demoWithTables(): FactoryProject {
  const project = loadBiodieselDemoProject();
  const variant = { id: "lv", durationTicks: 100, eut: 30 };
  return {
    ...project,
    metadata: { ...project.metadata, communityPlanId: "post-123" },
    recipes: project.recipes.map((recipe, index) => ({
      ...recipe,
      source: { ...recipe.source, datasetVersionId: "local-2.9.0-rc-2" },
      runtimeCalculation: {
        sourceKind: index === 0 ? "passive-crop" : "gregtech-overclock-calculator",
        status: "computed",
        oracleEligible: true,
        variants: [variant],
      },
    })),
  };
}

describe("copied plans (plan codes)", () => {
  it("round-trips a plan through its code", async () => {
    const project = loadBiodieselDemoProject();
    const decoded = await decodePlanCode(await encodePlanCode(project));
    expect(decoded).toEqual(parseFactoryProjectJson(serializeFactoryProject(project)));
  });

  it("keeps the plan's game version, and an old code opens with none", async () => {
    const project = loadBiodieselDemoProject();
    expect((await decodePlanCode(await encodePlanCode({ ...project, gameVersion: "2.8.1" }))).gameVersion).toBe(
      "2.8.1",
    );
    // Made before plans carried a game version.
    const old =
      "gtnh1.lZHBTsMwEER_JdpzQGmREPKRQykSgkogLojDNp4WC8db2RsORPl3lJKkSTlx84zH-8Z2Q6n8QMWviMlJILPIyVkyJN5elGJBOQWuQIaevM16J6J0ByQyb-85BbHDMqlE3g-KQxBldRJ64yDlJ7QXsGNwV8NvouycPzrNb4MtwjfCpMDtaHQHVr529n4eRL1BfHCKSOZqWRRF1067oXT38rjO9giIrBKzbkL2xb7GJbX5QHRiHRL8hDmxzqiTnSl3sbz5LzcpuDoxn3s55w2hGev6DHQMZVrHrQsYOd3PwKNU2NXpqf_cooKyZWUyTdv-AA";
    const decoded = await decodePlanCode(old);
    expect(decoded.name).toBe("Old code");
    expect("gameVersion" in decoded).toBe(false);
  });

  it("opens a code whose game version is blank as one with none", async () => {
    const project = loadBiodieselDemoProject();
    for (const blank of ["", "   "]) {
      const decoded = await decodePlanCode(await encodePlanCode({ ...project, gameVersion: blank }));
      expect(decoded.gameVersion).toBeUndefined();
    }
  });

  it("opens from the link, and from a link a chat window broke over lines", async () => {
    const project = loadBiodieselDemoProject();
    const link = planCodeLink(await encodePlanCode(project), "https://gtnhplanner.com");
    expect(link.startsWith("https://gtnhplanner.com/#p=gtnh1.")).toBe(true);
    expect((await decodePlanCode(link)).name).toBe(project.name);
    const wrapped = `  ${link.slice(0, 40)}\n${link.slice(40, 90)}\r\n${link.slice(90)}  `;
    expect((await decodePlanCode(wrapped)).nodes).toHaveLength(project.nodes.length);
  });

  it("leaves out GregTech overclock tables and the community post, nothing else", async () => {
    // The dataset has been seen to carry these tables, so it can put them back.
    noteRestorableRecipes(demoWithTables().recipes, "local-2.9.0-rc-2");
    const decoded = await decodePlanCode(await encodePlanCode(demoWithTables()));
    expect(decoded.metadata?.communityPlanId).toBeUndefined();
    expect(decoded.recipes[0]?.runtimeCalculation?.sourceKind).toBe("passive-crop");
    expect(decoded.recipes.slice(1).every((recipe) => recipe.runtimeCalculation === undefined)).toBe(
      true,
    );
  });

  it("is far shorter than the JSON download", async () => {
    const project = demoWithTables();
    noteRestorableRecipes(project.recipes, "local-2.9.0-rc-2");
    const code = await encodePlanCode(project);
    expect(code.length * 5).toBeLessThan(serializeFactoryProject(project).length);
  });

  it("refuses anything that is not a whole copied plan, in plain words", async () => {
    await expect(decodePlanCode("hello")).rejects.toThrow(/not a copied plan/);
    const code = await encodePlanCode(loadBiodieselDemoProject());
    await expect(decodePlanCode(code.slice(0, code.length / 2))).rejects.toThrow(/cut short or damaged/);
    await expect(decodePlanCode("gtnh1.!!!")).rejects.toThrow(/cut short or damaged/);
  });

  it("reads the code out of an address fragment", () => {
    expect(readPlanCodeFromHash("#p=gtnh1.abc")).toBe("gtnh1.abc");
    expect(readPlanCodeFromHash("p=gtnh1.abc")).toBe("gtnh1.abc");
    expect(readPlanCodeFromHash("#somewhere")).toBeUndefined();
    expect(readPlanCodeFromHash("")).toBeUndefined();
  });
});

describe("withoutRuntimeTables (copied and account-synced plans)", () => {
  it("drops only the GregTech tables, and the plan stays valid", () => {
    const project = demoWithTables();
    const slim = withoutRuntimeTables(project, () => true);
    expect(slim.recipes[0]?.runtimeCalculation?.sourceKind).toBe("passive-crop");
    expect(slim.recipes.slice(1).every((recipe) => recipe.runtimeCalculation === undefined)).toBe(true);
    expect(slim.nodes).toBe(project.nodes);
    expect(slim.metadata).toBe(project.metadata);
    expect(() => parseFactoryProjectJson(JSON.stringify(slim))).not.toThrow();
  });

  it("keeps the table of a body that names no dataset", () => {
    // Nothing says which dataset would put it back, so it travels whole.
    const project = demoWithTables();
    const bare = { ...project, recipes: project.recipes.map(({ source, ...recipe }) => (void source, recipe)) };
    noteRestorableRecipes(project.recipes, "local-2.9.0-rc-2");
    const slim = withoutRuntimeTables(bare);
    expect(slim.recipes.every((recipe) => recipe.runtimeCalculation !== undefined)).toBe(true);
  });

  it("keeps a table the dataset cannot put back", () => {
    // An old plan's recipe the dataset no longer knows: its stored table is
    // the only copy there is.
    const project = demoWithTables();
    const unknown = project.recipes[1]!.id;
    const slim = withoutRuntimeTables(project, (recipe) => recipe.id !== unknown);
    expect(slim.recipes[1]?.runtimeCalculation?.sourceKind).toBe("gregtech-overclock-calculator");
    expect(slim.recipes[2]?.runtimeCalculation).toBeUndefined();
  });
});
