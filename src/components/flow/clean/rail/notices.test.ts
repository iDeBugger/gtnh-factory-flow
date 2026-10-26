import { describe, expect, it, vi } from "vitest";
import { mockForced, mockUnneeded } from "@/lib/solver/plan/__fixtures__/mock-extras";
import type { Recipe, ThroughputResult } from "@/lib/model/types";
import type { DatasetManifest, DatasetVersion } from "@/lib/datasets/types";
import { unservedPlanVersion } from "@/lib/datasets/dataset-cache";
import { servedGameVersions } from "@/lib/datasets/new-plan-version";
import { startLandingRefresh } from "@/lib/datasets/refresh-project-recipes";
import type { PlanNote, PlanSolveExtras } from "@/lib/solver/plan/types";
import { buildNotices, byUrgency, planVersionNotice, unconvertedNotice } from "./notices";
import type { FactoryNode, UnconvertedRecipe } from "@/lib/model/types";

const withExtras = (
  mock: typeof mockForced,
  extras: Partial<PlanSolveExtras>,
): ThroughputResult => ({
  ...mock.result,
  plan: { ...mock.result.plan!, ...extras },
});

const note = (message: PlanNote["message"], ...args: PlanNote["args"]): PlanNote => ({
  message,
  args,
});

describe("the notices' sentences", () => {
  it("says what a drawer asked and what the plan does instead", () => {
    const notices = buildNotices(mockUnneeded.project, mockUnneeded.result);
    expect(notices).toEqual([
      {
        id: "unmet:steel",
        severity: "warn",
        text: "The Steel Plate drawer wants 10 /s, but the plan can only make 6 /s",
        focus: ["steel"],
      },
    ]);
  });

  it("names exactly, and the supply wording for a source", () => {
    const exact = withExtras(mockUnneeded, {
      notes: [note("DRAWER_UNMET", "Steel Plate", note("RULE_EXACTLY"), 10, 6)],
    });
    expect(buildNotices(mockUnneeded.project, exact)[0]!.text).toBe(
      "The Steel Plate drawer wants exactly 10 /s, but the plan can only make 6 /s",
    );
    const over = withExtras(mockUnneeded, {
      notes: [note("DRAWER_UNMET", "Steel Plate", note("RULE_AT_MOST"), 6, 10)],
    });
    expect(buildNotices(mockUnneeded.project, over)[0]!.text).toBe(
      "The Steel Plate drawer allows at most 6 /s, but the plan makes 10 /s",
    );
    const supply = withExtras(mockUnneeded, {
      unmetDrawers: ["iron"],
      notes: [note("DRAWER_UNMET", "Iron Ingot", note("RULE_AT_MOST"), 12, 15)],
    });
    expect(buildNotices(mockUnneeded.project, supply)[0]).toMatchObject({
      text: "The Iron Ingot supply allows at most 12 /s, but the plan needs 15 /s",
      focus: ["iron"],
    });
    const short = withExtras(mockUnneeded, {
      unmetDrawers: ["iron"],
      notes: [note("DRAWER_UNMET", "Iron Ingot", note("RULE_EXACTLY"), 12, 9)],
    });
    expect(buildNotices(mockUnneeded.project, short)[0]!.text).toBe(
      "The Iron Ingot supply should give exactly 12 /s, but the plan can only use 9 /s",
    );
  });

  it("names what holds a short drawer back", () => {
    const machine = mockUnneeded.project.recipes.find(
      (r) => r.id === mockUnneeded.project.nodes.find((n) => n.id === "comp")!.recipeId,
    )!.machineType;
    const full = withExtras(mockUnneeded, {
      shortfalls: [
        {
          drawerId: "steel",
          rule: "AT_LEAST",
          target: 10,
          reachable: 6,
          limitingCards: ["comp"],
          limitingDrawers: [],
        },
      ],
      upTo: { comp: { capacity: 6, reached: 6, reason: "FULL" } },
    });
    expect(buildNotices(mockUnneeded.project, full)[0]).toMatchObject({
      text: `The Steel Plate drawer gets 6 /s of 10 /s. The ${machine} is full.`,
      focus: ["steel", "comp"],
    });
    const starved = withExtras(mockUnneeded, {
      shortfalls: [
        {
          drawerId: "steel",
          rule: "AT_LEAST",
          target: 10,
          reachable: 6,
          limitingCards: ["comp"],
          limitingDrawers: ["iron"],
        },
      ],
      upTo: { comp: { capacity: 8, reached: 6, reason: "STARVED" } },
    });
    expect(buildNotices(mockUnneeded.project, starved)[0]!.text).toBe(
      `The Steel Plate drawer gets 6 /s of 10 /s. The ${machine} is starved. The Iron Ingot drawer's rate holds it back.`,
    );
  });

  it("says a drawer with a rate that does nothing", () => {
    const result = withExtras(mockUnneeded, {
      unmetDrawers: [],
      notes: [
        note("DRAWER_NOT_CONNECTED", "Plank", "planks"),
        note("DRAWER_WIRED_IGNORED", "Log", "logs"),
      ],
    });
    const notices = buildNotices(mockUnneeded.project, result);
    expect(notices.map((n) => n.text)).toEqual([
      "The Plank drawer has a rate, but nothing is wired to it",
      "The Log drawer's rate does nothing: the ports it's on are wired",
    ]);
    expect(notices.map((n) => n.focus)).toEqual([["planks"], ["logs"]]);
  });

  it("reports a made-past-target output with the card to show", () => {
    const result = withExtras(mockForced, {
      notes: [note("OVERSHOOTS_TARGET", "Furnace", "Iron Ingot", 3, 2, "furn")],
    });
    expect(buildNotices(mockForced.project, result)).toEqual([
      {
        id: "overshoot:furn:Iron Ingot",
        severity: "warn",
        text: "The Furnace makes 3 /s of Iron Ingot, more than its 2 /s target, because another of its outputs needs more",
        focus: ["furn"],
      },
    ]);
  });

  it("reports a stored choice that no longer fits", () => {
    const result = withExtras(mockForced, { notes: [note("CHOICE_NO_LONGER_FITS")] });
    expect(buildNotices(mockForced.project, result)[0]).toMatchObject({
      severity: "warn",
      text: "Your saved choice no longer fits this plan, so the planner's own answer is shown",
      focus: [],
    });
  });

  it("turns each failure into what the player can do about it", () => {
    const text = (failure: PlanNote) =>
      buildNotices(mockForced.project, withExtras(mockForced, { failure }))[0]!;
    expect(text(note("NO_PIN"))).toMatchObject({
      severity: "info",
      text: "Nothing to calculate yet: set a rate on a drawer, or pin a machine count",
    });
    expect(
      text(
        note("PIN_CONFLICT", [
          note("PIN_DROPPED", "Macerator", note("PIN_COUNT"), "mac"),
          note("PIN_DROPPED", "Furnace", note("PIN_TARGET"), "furn"),
        ]),
      ),
    ).toEqual({
      id: "pin-conflict",
      severity: "error",
      text: "The pinned counts on Macerator and Furnace can't all be met at once: unpin one",
      focus: ["mac", "furn"],
    });
    expect(text(note("BALANCE_FAILED", note("SOLVER_UNSATISFIABLE", "infeasible")))).toMatchObject({
      severity: "error",
      text: "There's no way to meet all these rates and pinned counts: change a rate or unpin a count",
    });
    expect(text(note("VALIDATION_FAILED", "residual"))).toMatchObject({
      severity: "error",
      text: "The planner couldn't solve this plan",
    });
  });

  it("lists the most pressing first: a failed solve, then alarms, then warnings, then the rest", () => {
    const result = withExtras(mockForced, {
      failure: note("BALANCE_FAILED", note("SOLVER_UNSATISFIABLE", "infeasible")),
      notes: [note("OVERSHOOTS_TARGET", "Furnace", "Iron Ingot", 3, 2, "furn")],
      loops: [{ kind: "CLOG_LOCK", cards: ["furn"], portKeys: [], resourceKeys: [] }],
    });
    expect(buildNotices(mockForced.project, result).map((n) => [n.severity, n.tag])).toEqual([
      ["error", undefined],
      ["error", "CLOG LOCK"],
      ["warn", undefined],
    ]);
    const info = { severity: "info" as const, text: "info" };
    const warn = { severity: "warn" as const, text: "warn" };
    const alarm = { severity: "error" as const, tag: "DEAD LOOP", text: "alarm" };
    const failed = { severity: "error" as const, text: "failed" };
    expect(byUrgency([info, warn, alarm, failed, warn])).toEqual([failed, alarm, warn, warn, info]);
  });

  it("says nothing for an empty board, a clean plan or an old-mode result", () => {
    expect(
      buildNotices(
        { ...mockForced.project, nodes: [] },
        withExtras(mockForced, { failure: note("NO_PIN") }),
      ),
    ).toEqual([]);
    expect(
      buildNotices(
        { ...mockForced.project, nodes: [] },
        withExtras(mockForced, { failure: note("EMPTY_GRAPH") }),
      ),
    ).toEqual([]);
    expect(buildNotices(mockForced.project, mockForced.result)).toEqual([]);
    expect(buildNotices(mockForced.project, undefined)).toEqual([]);
    expect(buildNotices(mockForced.project, { ...mockForced.result, plan: undefined })).toEqual([]);
  });
});

describe("a plan for a version this site has no recipes for", () => {
  const version = (id: string, gtnhVersion: string): DatasetVersion => ({
    id,
    gtnhVersion,
    channel: "stable",
    publishedAt: "2026-10-20T00:00:00.000Z",
    manifestPath: "/datasets/gtnh/datasets.manifest.json",
    recipeDatasetPath: `/datasets/gtnh/${id}/recipes.json.gz`,
    sourceInfo: { sourceId: "recex", generatedAt: "2026-10-20T00:00:00.000Z" },
  });
  const manifest: DatasetManifest = {
    schemaVersion: 1,
    latestStableVersion: "local-2.9.0-rc-2",
    versions: [version("local-2.9.0-rc-2", "2.9.0-RC-2"), version("local-2.8.1", "2.8.1")],
  };

  it("unserved plan version shows the notice and never refreshes", async () => {
    const plan = { gameVersion: "2.10", recipes: [{ id: "r1" } as Recipe] };
    const unserved = unservedPlanVersion({ datasetManifest: manifest, project: plan });
    expect(unserved).toBe("2.10");
    const notice = planVersionNotice(unserved, servedGameVersions(manifest));
    expect(notice).toMatchObject({
      severity: "warn",
      text: "This plan is for GTNH 2.10. This site has recipes for GTNH 2.9 and GTNH 2.8.1.",
      focus: [],
      // Read in full: the row wraps instead of fading its rule out.
      wrap: true,
    });
    // No Convert action handed over, no key: never a key that does nothing.
    expect(notice?.action).toBeUndefined();

    // Whatever dataset is active, the plan's stored bodies are never asked about.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const apply = vi.fn();
    for (const id of ["local-2.9.0-rc-2", "local-2.8.1"]) {
      const entry = manifest.versions.find((entry) => entry.id === id)!;
      expect(
        startLandingRefresh({
          dataset: { datasetVersionId: id, gtnhVersion: entry.gtnhVersion },
          manifest,
          manifestUrl: "/m.json",
          project: plan,
          checked: new Map(),
          requested: new WeakSet(),
          stillServes: () => true,
          apply,
        }),
      ).toBeUndefined();
    }
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("the key shows once conversion hands one over", () => {
    const convert = vi.fn();
    const notice = planVersionNotice("2.10", ["2.9", "2.8.1"], convert);
    expect(notice?.action?.label).toBe("Convert to GTNH 2.9");
    notice?.action?.onSelect();
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("served plans, and any plan before the manifest arrives, get none", () => {
    expect(unservedPlanVersion({ datasetManifest: manifest, project: {} })).toBeUndefined();
    expect(unservedPlanVersion({ datasetManifest: manifest, project: { gameVersion: "2.8.1" } })).toBeUndefined();
    expect(unservedPlanVersion({ datasetManifest: undefined, project: { gameVersion: "2.10" } })).toBeUndefined();
    expect(planVersionNotice(undefined, ["2.9"])).toBeUndefined();
  });
});

describe("the unconverted cards' notice", () => {
  const marker = (recipeName: string, machineType: string): UnconvertedRecipe => ({
    fromGameVersion: "2.9",
    recipeId: `id-${recipeName}`,
    recipeName,
    machineType,
  });
  const card = (id: string, extra: Partial<FactoryNode> = {}) =>
    ({ id, recipeId: `r-${id}`, machineCount: 1, parallel: 1, overclockTier: "LV", enabled: true, position: { x: 0, y: 0 }, ...extra }) as FactoryNode;

  it("is absent on a plan with no marked card", () => {
    expect(unconvertedNotice({ gameVersion: "2.8.1", nodes: [card("a")] })).toBeUndefined();
  });

  it("says one card in the singular and lists it", () => {
    const notice = unconvertedNotice({
      gameVersion: "2.8.1",
      nodes: [card("a"), card("b", { unconverted: marker("Raw Silicon Ingot", "Electric Blast Furnace") })],
    });
    expect(notice).toMatchObject({
      id: "unconverted",
      severity: "warn",
      text: "1 card has no recipe in GTNH 2.8.1. Its wires count as outside inputs and outputs.",
      focus: ["b"],
      cards: [{ id: "b", label: "Electric Blast Furnace: Raw Silicon Ingot" }],
    });
  });

  it("on a plan this site has no recipes for, says the site lacks them, not the game", () => {
    const notice = unconvertedNotice(
      { gameVersion: "2.10", nodes: [card("b", { unconverted: marker("Raw Silicon Ingot", "Electric Blast Furnace") })] },
      "2.10",
    );
    expect(notice?.text).toBe(
      "Recipes for GTNH 2.10 are not on this site. 1 card has no recipe. Its wires count as outside inputs and outputs.",
    );
    expect(notice?.cards).toEqual([{ id: "b", label: "Electric Blast Furnace: Raw Silicon Ingot" }]);
  });

  it("a recipe name carrying its map (as dataset names do) is listed once after the machine", () => {
    const notice = unconvertedNotice({
      nodes: [card("a", { unconverted: marker("Blast Furnace: Raw Silicon Ingot", "Blast Furnace") })],
    });
    expect(notice?.cards).toEqual([{ id: "a", label: "Blast Furnace: Raw Silicon Ingot" }]);
    // Another name with ": " in it is kept whole.
    const other = unconvertedNotice({ nodes: [card("b", { unconverted: marker("Tier 2: Circuit", "Assembler") })] });
    expect(other?.cards).toEqual([{ id: "b", label: "Assembler: Tier 2: Circuit" }]);
  });

  it("says several cards in the plural and lists every one, a shared card's sections on its line", () => {
    const notice = unconvertedNotice({
      nodes: [
        card("a", { unconverted: marker("Raw Silicon Ingot", "Electric Blast Furnace") }),
        card("b"),
        card("c", {
          extraRecipes: [
            { recipeId: "x", unconverted: marker("Steel Ingot", "Exothermic Hearth") },
            { recipeId: "y", unconverted: marker("Iron Ingot", "Exothermic Hearth") },
          ],
        }),
      ],
    });
    expect(notice?.text).toBe("2 cards have no recipe in GTNH 2.9. Their wires count as outside inputs and outputs.");
    expect(notice?.cards).toEqual([
      { id: "a", label: "Electric Blast Furnace: Raw Silicon Ingot" },
      { id: "c", label: "Exothermic Hearth: Steel Ingot, Iron Ingot" },
    ]);
  });
});
