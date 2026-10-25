import { describe, expect, it, vi } from "vitest";
import { buildTextSearchIndex, queryTextSearchIndex } from "@/lib/search";
import { matchSearchTokens, parseSearchQuery } from "@/lib/search";
import type { DatasetVersion } from "@/lib/datasets/types";
import { DATASET_ANSWER_VERSION } from "@/lib/datasets/answer-version";
import {
  applyUsesResourceContext,
  BLANK_RESOURCE_SEARCH_KEYS,
  createBlankResourceSearchCache,
  createShardCache,
  datasetPrewarmOrder,
  DatasetNotFoundError,
  ensureLookupSearchIndex,
  getChoiceAlternativesByKey,
  getDatasetCatalog,
  getWildcardResource,
  orderByRecipeMap,
  PARTIAL_PHASE_WORK_BUDGET,
  partialPhaseCandidates,
  prewarmFirstThenRest,
  prewarmInOrder,
  queryCatalogResources,
  createRankedRecipeSearchCache,
  RECIPE_SEARCH_CACHE_BYTES,
  rankedRecipeSearchBytes,
  rankedRecipeSearchKey,
  SHARD_CACHE_BYTES,
  shardHeapBytes,
  withTankMapFace,
} from "./dataset-query";

describe("dataset query text search", () => {
  it("matches substrings inside tokens without matching across token boundaries", () => {
    const index = buildTextSearchIndex(["Hydrogen Sulfide"], [0]);
    const tokens = index.tokensByEntry[0] ?? [];

    const sulfide = parseSearchQuery("ulfide");
    expect(queryTextSearchIndex(index, sulfide) ?? [0]).toContain(0);
    expect(matchSearchTokens(sulfide, tokens)).toBeDefined();

    const crossBoundary = parseSearchQuery("nsu");
    expect(queryTextSearchIndex(index, crossBoundary) ?? [0]).not.toContain(0);
    expect(matchSearchTokens(crossBoundary, tokens)).toBeUndefined();
  });
});

describe("the recipe partial search phase", () => {
  const index = buildTextSearchIndex(
    ["Steel Plate", "Iron Ingot", "Copper Wire", "LV Motor", "HV Motor"],
    [0, 1, 2, 3, 4],
  );

  it("narrows by the words it can index and lets a short word only score", () => {
    // Never a walk over every recipe: the tier words add no candidates.
    expect(partialPhaseCandidates(index, parseSearchQuery("motor lv hv"))).toEqual([3, 4]);
    expect(partialPhaseCandidates(index, parseSearchQuery("lv steel"))).toEqual([0]);
    expect(partialPhaseCandidates(index, parseSearchQuery("zz irom steal"))).toEqual([]);
  });

  it("is skipped when no word can be indexed", () => {
    expect(partialPhaseCandidates(index, parseSearchQuery("lv hv"))).toBeUndefined();
  });

  it("scores the union while candidates times words fit the budget, and is skipped past it", () => {
    expect(partialPhaseCandidates(index, parseSearchQuery("steel iron"))).toEqual([0, 1]);
    // Six words keep 30,000 candidates; fewer words may score more of them.
    expect(PARTIAL_PHASE_WORK_BUDGET).toBe(180_000);
    expect(PARTIAL_PHASE_WORK_BUDGET / 6).toBe(30_000);
    // Two words and two candidates: a budget of 4 fits, a budget of 3 does not.
    expect(partialPhaseCandidates(index, parseSearchQuery("steel iron"), 4)).toEqual([0, 1]);
    expect(partialPhaseCandidates(index, parseSearchQuery("steel iron"), 3)).toBeUndefined();
    // Three words, the same two candidates: 6 fits, 5 does not.
    expect(partialPhaseCandidates(index, parseSearchQuery("steel iron pls"), 6)).toEqual([0, 1]);
    expect(partialPhaseCandidates(index, parseSearchQuery("steel iron pls"), 5)).toBeUndefined();
  });
});

describe("wildcard uses matching", () => {
  it("bridges damaged item ids to their any-damage wildcard", () => {
    expect(getWildcardResource({ kind: "item", id: "minecraft:log@1" })).toEqual({
      kind: "item",
      id: "minecraft:log@32767",
    });
  });

  it("bridges bare damage-0 item ids the same way", () => {
    // Regression: Oak Log ("minecraft:log", no "@") used to skip the wildcard
    // bridge entirely and lost every any-damage recipe (Coke Oven, Pyrolyse
    // Oven, Macerator, ...) from its uses listing.
    expect(getWildcardResource({ kind: "item", id: "minecraft:log" })).toEqual({
      kind: "item",
      id: "minecraft:log@32767",
    });
  });

  it("does not bridge wildcards or fluids", () => {
    expect(getWildcardResource({ kind: "item", id: "minecraft:log@32767" })).toBeUndefined();
    expect(getWildcardResource({ kind: "fluid", id: "water" })).toBeUndefined();
  });
});

describe('what an "any of these" placeholder stands for', () => {
  const catalog = () =>
    ({
      resources: [],
      resourceIndex: [
        {
          kind: "item",
          id: "oredict:circuitBasic",
          displayName: "Ore Dictionary: circuitBasic",
          alternatives: [
            { kind: "item", id: "gregtech:circuit@1", displayName: "Electronic Circuit" },
            { kind: "item", id: "dreamcraft:circuitlv", displayName: "Any LV Circuit" },
            { kind: "item", id: "gregtech:circuit@2", displayName: "Integrated Logic Circuit" },
          ],
        },
        {
          kind: "item",
          id: "oredict:circuitGood",
          displayName: "Ore Dictionary: circuitGood",
          alternatives: [
            { kind: "item", id: "dreamcraft:circuitlv", displayName: "Any LV Circuit" },
            { kind: "item", id: "gregtech:circuit@9", displayName: "Good Electronic Circuit" },
          ],
        },
      ],
    }) as unknown as Parameters<typeof getChoiceAlternativesByKey>[0];

  it("expands a stand-in into the real items of its group", () => {
    const byKey = getChoiceAlternativesByKey(catalog());

    expect(byKey.get("item:dreamcraft:circuitlv")?.map((entry) => entry.displayName)).toEqual([
      "Electronic Circuit",
      "Integrated Logic Circuit",
      "Good Electronic Circuit",
    ]);
  });

  it("never hands alternatives to a concrete item", () => {
    // Sharing an ore dictionary group is not the same as being accepted. The
    // Circuit Assembler recipe for an Electronic Circuit names a Vacuum Tube
    // and takes only that, despite sharing `circuitPrimitive` with the NAND
    // chip, so expanding concrete inputs invents recipes that do not exist.
    const byKey = getChoiceAlternativesByKey(catalog());

    expect(byKey.get("item:gregtech:circuit@1")).toBeUndefined();
    expect(byKey.get("item:gregtech:circuit@2")).toBeUndefined();
  });

  it("does not list one stand-in as another's member", () => {
    const byKey = getChoiceAlternativesByKey(catalog());

    expect(
      byKey
        .get("item:dreamcraft:circuitlv")
        ?.some((entry) => /^Any /.test(entry.displayName ?? "")),
    ).toBe(false);
  });
});

describe("a placeholder that sits in two groups", () => {
  it("is offered the union, without duplicating a shared member", () => {
    const catalog = {
      resources: [],
      resourceIndex: [
        {
          kind: "item",
          id: "oredict:circuitBasic",
          alternatives: [
            { kind: "item", id: "any:lv", displayName: "Any LV Circuit" },
            { kind: "item", id: "gt:circuit.electronic", displayName: "Electronic Circuit" },
          ],
        },
        {
          kind: "item",
          id: "oredict:circuitTier1",
          alternatives: [
            { kind: "item", id: "any:lv", displayName: "Any LV Circuit" },
            { kind: "item", id: "gt:circuit.electronic", displayName: "Electronic Circuit" },
            { kind: "item", id: "gt:circuit.logic", displayName: "Integrated Logic Circuit" },
          ],
        },
      ],
    } as unknown as Parameters<typeof getChoiceAlternativesByKey>[0];

    const offered = getChoiceAlternativesByKey(catalog)
      .get("item:any:lv")
      ?.map((entry) => entry.displayName);

    expect(offered).toEqual(["Electronic Circuit", "Integrated Logic Circuit"]);
  });
});

describe("the Tank map's face", () => {
  const cell = {
    kind: "item" as const,
    id: "ic2:itemcellempty",
    displayName: "Empty Cell",
    iconPath: "cell.png",
  };
  const lvTank = {
    kind: "item" as const,
    id: "gregtech:gt.blockmachines@818",
    displayName: "Low Voltage Fluid Tank",
    iconPath: "tank.png",
    dominantColor: "#abc",
    modId: "gregtech",
  };

  it("wears the Low Voltage Fluid Tank, called Fluid Tank", () => {
    const icons = withTankMapFace({
      resources: [cell, lvTank] as never,
      recipeMapIcons: [
        { recipeMap: "Tank", resource: cell },
        { recipeMap: "Canner", resource: cell },
      ],
    });
    expect(icons?.find((entry) => entry.recipeMap === "Tank")?.resource).toMatchObject({
      id: lvTank.id,
      displayName: "Fluid Tank",
      iconPath: "tank.png",
      modId: "gregtech",
    });
    expect(icons?.find((entry) => entry.recipeMap === "Canner")?.resource).toEqual(cell);
  });

  it("keeps the cell when the dataset has no fluid tank item", () => {
    const icons = [{ recipeMap: "Tank", resource: cell }];
    expect(withTankMapFace({ resources: [cell] as never, recipeMapIcons: icons })).toBe(icons);
  });
});

describe("an all-maps page walks the machines in section order", () => {
  // The antimony ingot answer, shrunk: ranked across maps, the Blast
  // Furnace's one recipe fell past the first page and its section sat empty
  // above a Bricked Blast Furnace showing a third of its count.
  const recipeMaps = ["Blast Furnace", "Bricked Blast Furnace", "Furnace"];
  const mapOf: Record<number, string> = {
    0: "Furnace",
    1: "Bricked Blast Furnace",
    2: "Furnace",
    3: "Bricked Blast Furnace",
    4: "Blast Furnace",
  };
  const ranked = [0, 1, 2, 3, 4].map((recipeIndex) => ({ recipeIndex }));

  it("fills the sections top-down, keeping the ranking inside each", () => {
    const ordered = orderByRecipeMap(ranked, (recipeIndex) => mapOf[recipeIndex], recipeMaps);
    expect(ordered.map((match) => match.recipeIndex)).toEqual([4, 1, 3, 0, 2]);
    // A first page of two now holds every Blast Furnace recipe.
    expect(ordered.slice(0, 2).map((match) => mapOf[match.recipeIndex])).toEqual([
      "Blast Furnace",
      "Bricked Blast Furnace",
    ]);
  });

  it("puts a recipe whose map is not listed after every listed one", () => {
    const ordered = orderByRecipeMap(
      [{ recipeIndex: 9 }, ...ranked],
      (recipeIndex) => mapOf[recipeIndex],
      recipeMaps,
    );
    expect(ordered.at(-1)?.recipeIndex).toBe(9);
  });
});

describe("a search for an item that has NBT variants", () => {
  const white = {
    kind: "item" as const,
    id: "etfuturum:shulker_box",
    displayName: "White Shulker Box",
    iconPath: "white.png",
  };
  const catalog = { resources: [white], resourceIndex: [] } as never;
  const recipe = {
    id: "orange-box",
    inputs: [
      {
        kind: "item" as const,
        id: "etfuturum:shulker_box",
        amount: 1,
        displayName: "Shulker Box",
        iconPath: "box.png",
        tooltip: ["NBT: {Type:0b}"],
      },
      { kind: "item" as const, id: "minecraft:dye@14", amount: 1, displayName: "Orange Dye" },
    ],
    outputs: [
      {
        kind: "item" as const,
        id: "etfuturum:shulker_box",
        amount: 1,
        displayName: "Orange Shulker Box",
      },
    ],
  } as never;

  it("leaves a slot that is the item with its own name, picture and tooltip", () => {
    const [box] = (
      applyUsesResourceContext(recipe, catalog, white) as { inputs: Record<string, unknown>[] }
    ).inputs;
    expect(box).toMatchObject({
      displayName: "Shulker Box",
      iconPath: "box.png",
      tooltip: ["NBT: {Type:0b}"],
    });
  });
});

describe("which datasets the server prewarms", () => {
  const version = (id: string) => ({ id }) as DatasetVersion;
  const manifest = {
    latestStableVersion: "local-2.9.0-rc-2",
    // Newest pack first, as rebuild-manifest writes it; 2.8.4 is retired.
    versions: [version("local-2.9.0-rc-2"), version("local-2.8.4"), version("local-2.8.1")],
  };

  it("warms the default first, then every other served version, never 2.8.4", () => {
    expect(datasetPrewarmOrder(manifest)).toEqual(["local-2.9.0-rc-2", "local-2.8.1"]);
  });

  it("puts the default first wherever the manifest lists it", () => {
    expect(
      datasetPrewarmOrder({
        ...manifest,
        versions: [version("local-2.8.1"), version("local-2.9.0-rc-2")],
      }),
    ).toEqual(["local-2.9.0-rc-2", "local-2.8.1"]);
  });

  it("never warms a hidden version even when it is the default", () => {
    expect(datasetPrewarmOrder({ ...manifest, latestStableVersion: "local-2.8.4" })).toEqual([
      "local-2.9.0-rc-2",
      "local-2.8.1",
    ]);
  });

  it("never loads a hidden version for a request", async () => {
    // Refused before any disk read: no manifest is needed here.
    const refusal = getDatasetCatalog("local-2.8.4");
    await expect(refusal).rejects.toBeInstanceOf(DatasetNotFoundError);
    await expect(refusal).rejects.toThrow("Dataset not found.");
  });

  it("logs a failed 2.8.1 prewarm and carries on", async () => {
    const warmed: string[] = [];
    const errors: string[] = [];
    await expect(
      prewarmInOrder(
        ["local-2.8.1", "local-2.9.0-rc-2"],
        async (versionId) => {
          if (versionId === "local-2.8.1") throw new Error("missing resource index");
          warmed.push(versionId);
        },
        (message) => errors.push(message),
      ),
    ).resolves.toBeUndefined();

    expect(errors).toEqual(["GTNH dataset local-2.8.1 prewarm failed."]);
    expect(warmed).toEqual(["local-2.9.0-rc-2"]);
  });
});

describe("what the startup prewarm waits for", () => {
  it("resolves once the default is warm, before the next version settles", async () => {
    let releaseSecond: () => void = () => {};
    const started: string[] = [];
    const settled: string[] = [];
    const prewarm = (versionId: string) => {
      started.push(versionId);
      if (versionId === "local-2.9.0-rc-2") {
        settled.push(versionId);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        releaseSecond = () => {
          settled.push(versionId);
          resolve();
        };
      });
    };

    await prewarmFirstThenRest(["local-2.9.0-rc-2", "local-2.8.1"], prewarm, () => {});

    expect(settled).toEqual(["local-2.9.0-rc-2"]);
    await Promise.resolve();
    expect(started).toEqual(["local-2.9.0-rc-2", "local-2.8.1"]);
    releaseSecond();
    await Promise.resolve();
    expect(settled).toEqual(["local-2.9.0-rc-2", "local-2.8.1"]);
  });

  it("still returns when the default fails, and warms the rest", async () => {
    const warmed: string[] = [];
    const errors: string[] = [];
    await prewarmFirstThenRest(
      ["local-2.9.0-rc-2", "local-2.8.1"],
      async (versionId) => {
        if (versionId === "local-2.9.0-rc-2") throw new Error("missing");
        warmed.push(versionId);
      },
      (message) => errors.push(message),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual(["GTNH dataset local-2.9.0-rc-2 prewarm failed."]);
    expect(warmed).toEqual(["local-2.8.1"]);
  });
});

describe("the loaded datasets", () => {
  it("are one set for the whole process, however many copies of the module load", async () => {
    // instrumentation.ts and the route handlers are separate bundles: the
    // startup prewarm must fill the caches the routes read.
    const key = Symbol.for("gtnh-factory-flow.dataset-query.caches");
    const host = globalThis as Record<symbol, unknown>;
    const first = host[key];
    expect(first).toBeDefined();

    vi.resetModules();
    await import("./dataset-query");

    expect(host[key]).toBe(first);
  });
});

describe("the recipe search text", () => {
  it("is released once the index holds its words, and the index still answers", () => {
    const lookup = {
      hasSearchText: true,
      searchText: ["Hydrogen Sulfide", "Steel Plate"],
    } as unknown as Parameters<typeof ensureLookupSearchIndex>[0];

    const index = ensureLookupSearchIndex(lookup);

    expect(lookup.searchText).toBeUndefined();
    expect(lookup.hasSearchText).toBe(true);
    expect(index.tokensByEntry[1]).toEqual(["steel", "plate"]);
    expect(queryTextSearchIndex(index, parseSearchQuery("steel"))).toEqual([1]);
    expect(ensureLookupSearchIndex(lookup)).toBe(index);
  });
});

describe("the bounded dataset caches", () => {
  const MB = 1024 * 1024;

  it("hold parsed shards up to 128 MB of estimated heap, oldest out first", () => {
    expect(SHARD_CACHE_BYTES).toBe(128 * MB);
    // 2.5 bytes of heap per byte of unzipped JSON.
    expect(shardHeapBytes(4 * MB)).toBe(10 * MB);

    const cache = createShardCache();
    for (let shard = 0; shard < 14; shard += 1) {
      cache.set(`2.9:shard-${shard}`, [], shardHeapBytes(4 * MB));
    }
    // Twelve 10 MB shards fit in 128 MB; the two oldest went.
    expect(cache.keys()).toEqual(
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((shard) => `2.9:shard-${shard}`),
    );
    expect(cache.totalSize).toBeLessThanOrEqual(SHARD_CACHE_BYTES);
  });

  it("keep the two largest Blast Furnace shards together", () => {
    const cache = createShardCache();
    cache.set("2.9:shard-0130", [], shardHeapBytes(21 * MB));
    cache.set("2.9:shard-0136", [], shardHeapBytes(22 * MB));
    expect(cache.keys()).toEqual(["2.9:shard-0130", "2.9:shard-0136"]);
  });

  it("keep a shard bigger than the ceiling alone until the next shard arrives", () => {
    const cache = createShardCache();
    cache.set("2.9:shard-0000", [], shardHeapBytes(1 * MB));
    cache.set("2.9:huge", [], shardHeapBytes(60 * MB));
    expect(cache.keys()).toEqual(["2.9:huge"]);
    cache.set("2.8.1:shard-0001", [], shardHeapBytes(1 * MB));
    expect(cache.keys()).toEqual(["2.8.1:shard-0001"]);
  });

  it("a blank list asked with a mod reuses the un-modded entry", async () => {
    const resource = (id: string, recipeCount: number) => ({
      id,
      kind: "item" as const,
      displayName: id.split(":")[1],
      iconPath: `${id}.png`,
      recipeCount,
    });
    // Direction counts are preset, so nothing reads the lookup index from disk.
    const catalog = {
      version: { id: "test" },
      resources: [],
      resourceIndex: [
        resource("gregtech:steel", 5),
        resource("minecraft:glass", 3),
        resource("gregtech:copper", 1),
      ],
      resourceDirectionCounts: new Map(),
      recipeMaps: [],
      recipeCount: 0,
      shards: [],
    } as unknown as Parameters<typeof queryCatalogResources>[0];
    const blank = { query: "", offset: 0, limit: 24 };

    const all = await queryCatalogResources(catalog, blank);
    const gregtech = await queryCatalogResources(catalog, { ...blank, mod: "gregtech" });
    const nope = await queryCatalogResources(catalog, { ...blank, mod: "nope" });

    expect(catalog.blankResourceSearches?.count).toBe(1);
    expect(all.resources.map((entry) => entry.id)).toEqual([
      "gregtech:steel",
      "minecraft:glass",
      "gregtech:copper",
    ]);
    expect(gregtech.resources.map((entry) => entry.id)).toEqual([
      "gregtech:steel",
      "gregtech:copper",
    ]);
    expect(gregtech.total).toBe(2);
    expect(gregtech.mods).toEqual(all.mods);
    expect(nope).toMatchObject({ resources: [], total: 0, mods: all.mods });
  });

  it("keep 24 blank item lists per version, the least recently read out first", () => {
    expect(BLANK_RESOURCE_SEARCH_KEYS).toBe(24);
    const cache = createBlankResourceSearchCache<number>();
    for (let key = 0; key < 24; key += 1) {
      cache.set(`list-${key}`, key);
    }
    expect(cache.get("list-0")).toBe(0);
    cache.set("list-24", 24);
    expect(cache.count).toBe(24);
    expect(cache.get("list-1")).toBeUndefined();
    expect(cache.get("list-0")).toBe(0);
  });
});

describe("the kept recipe searches", () => {
  const version = { id: "local-2.9.0-rc-2", checksumSha256: "abc" } as DatasetVersion;
  const request = {
    query: " Steel Plate ",
    mode: "recipes" as const,
    maxTier: "all" as const,
    offset: 0,
    limit: 48,
  };

  it("key one search for every page of it, and fold case and outer spaces as the parser does", () => {
    const key = rankedRecipeSearchKey(version, request);
    expect(rankedRecipeSearchKey(version, { ...request, offset: 48, limit: 24 })).toBe(key);
    expect(rankedRecipeSearchKey(version, { ...request, query: "steel plate" })).toBe(key);
    expect(key).toContain(DATASET_ANSWER_VERSION);
  });

  it("key apart whatever changes the ranking: the dataset build, the words, the conditions, the maps", () => {
    const key = rankedRecipeSearchKey(version, request);
    for (const other of [
      rankedRecipeSearchKey({ ...version, checksumSha256: "def" }, request),
      rankedRecipeSearchKey(version, { ...request, query: "steel plates" }),
      rankedRecipeSearchKey(version, { ...request, maxTier: "LV" }),
      rankedRecipeSearchKey(version, { ...request, allMaps: true }),
      rankedRecipeSearchKey(version, { ...request, recipeMap: "Bender" }),
      rankedRecipeSearchKey(version, { ...request, mapSelection: { mode: "include", maps: [] } }),
      rankedRecipeSearchKey(version, {
        ...request,
        resource: { kind: "item", id: "minecraft:glass" },
      }),
      rankedRecipeSearchKey(version, {
        ...request,
        resource: { kind: "item", id: "minecraft:glass" },
        mode: "uses",
      }),
      rankedRecipeSearchKey(version, { ...request, takesOp: "all" }),
    ]) {
      expect(other).not.toBe(key);
    }
  });

  it("are bounded by bytes, the widest search counting its four bytes a match", () => {
    expect(RECIPE_SEARCH_CACHE_BYTES).toBe(32 * 1024 * 1024);
    const widest = {
      order: new Int32Array(278_000),
      recipeMaps: ["Assembler"],
      recipeMapCounts: { Assembler: 278_000 },
      outcome: { searchPhase: "exact" as const, corrections: [] },
    };
    const bytes = rankedRecipeSearchBytes("key", widest);
    expect(bytes).toBeGreaterThan(278_000 * 4);
    expect(Math.floor(RECIPE_SEARCH_CACHE_BYTES / bytes)).toBeGreaterThanOrEqual(29);
  });

  it("count each map's name and count and the corrections, and evict the oldest past the bound", () => {
    const search = (matches: number, maps: string[], corrected = false) => ({
      order: new Int32Array(matches),
      recipeMaps: maps,
      recipeMapCounts: Object.fromEntries(maps.map((recipeMap) => [recipeMap, 1])),
      outcome: {
        searchPhase: (corrected ? "corrected" : "exact") as "corrected" | "exact",
        corrections: corrected ? [{ from: "stel", to: "steel" }] : [],
      },
    });
    const small = rankedRecipeSearchBytes("k", search(0, []));
    expect(rankedRecipeSearchBytes("k", search(0, ["Assembler"]))).toBeGreaterThanOrEqual(
      small + 128 + "Assembler".length * 4,
    );
    expect(rankedRecipeSearchBytes("k", search(0, [], true))).toBeGreaterThan(small);

    const one = search(100_000, ["Assembler"]);
    const size = rankedRecipeSearchBytes("a", one);
    const cache = createRankedRecipeSearchCache(Math.floor(size * 2.5));
    cache.set("a", one, size);
    cache.set("b", search(100_000, ["Assembler"]), size);
    expect(cache.get("a")).toBe(one);
    cache.set("c", search(100_000, ["Assembler"]), size);
    // "a" was read last, so "b" is the oldest and goes.
    expect(cache.keys()).toEqual(["a", "c"]);
    expect(cache.totalSize).toBeLessThanOrEqual(size * 2.5);
  });
});
