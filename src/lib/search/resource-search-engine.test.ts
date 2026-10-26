import { describe, expect, it } from "vitest";
import { queryCatalogResources, warmResourceSearch } from "@/lib/server/dataset-query";
import { createResourceSearchEngine, type ResourceSearchFile } from "./resource-search-engine";
import type { ResourceQuerySort } from "./resource-search";

const resource = (
  id: string,
  displayName: string,
  recipeCount: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  kind: (id.includes(":") ? "item" : "fluid") as "item" | "fluid",
  displayName,
  iconPath: `/datasets/gtnh/test/textures/${id.replace(/[^a-z0-9]/gi, "_")}.png`,
  recipeCount,
  ...extra,
});

const resourceIndex = [
  resource("gregtech:gt.metaitem.01@11305", "Steel Ingot", 900),
  resource("gregtech:gt.metaitem.01@17305", "Steel Plate", 700, { oreDictionary: ["plateSteel"] }),
  resource("gregtech:gt.metaitem.01@2305", "Steel Dust", 300),
  resource("gregtech:gt.metaitem.01@32610", "Electric Motor (LV)", 400, {
    tooltip: ["Low Voltage"],
  }),
  resource("gregtech:gt.metaitem.01@32611", "Electric Motor (MV)", 200),
  resource("gregtech:gt.blockmachines@1000", "Electric Blast Furnace", 50, { tooltip: ["EBF"] }),
  resource("minecraft:log", "Oak Log", 120),
  resource("minecraft:wheat", "Wheat", 40),
  resource("forestry:beeCombs", "Honey Comb", 30),
  resource("minecraft:glass", "Glass", 600),
  resource("ic2:itemCellEmpty", "Empty Cell", 500),
  resource("water", "Water", 2000),
  resource("molten.steel", "Molten Steel", 60),
  resource("oredict:plateSteel", "Ore Dictionary: plateSteel", 700),
  resource("gregtech:noicon", "Steel Ghost", 5, { iconPath: undefined }),
];

const counts: ResourceSearchFile["directionCounts"] = [
  ["item:gregtech:gt.metaitem.01@11305", 12, 800],
  ["item:gregtech:gt.metaitem.01@17305", 4, 600],
  ["item:minecraft:glass", 9, 500],
  ["fluid:water", 30, 1500],
  ["item:minecraft:log", 2, 100],
];
const sources = {
  plants: ["item:minecraft:log", "item:minecraft:wheat"],
  bees: ["item:forestry:beeCombs"],
};
const popularity = new Map([
  ["item:minecraft:glass", 50],
  ["fluid:water", 40],
  ["item:gregtech:gt.metaitem.01@17305", 30],
]);

/**
 * NEI's places for the records above (the pipeline's resourceOrder): the steel plate before the
 * dust before the ingot, water first, and some records NEI does not list.
 */
const resourceOrder = [12, 10, 11, 20, 21, 30, 3, 4, null, 2, 5, 0, null, null, 13];

function serverCatalog(order?: Array<number | null>) {
  return {
    version: { id: "test" },
    resources: [],
    resourceIndex: JSON.parse(JSON.stringify(resourceIndex)),
    ...(order ? { resourceOrder: order } : {}),
    resourceDirectionCounts: new Map(
      counts.map(([key, madeBy, usedBy]) => [key, { madeBy, usedBy }]),
    ),
    passiveSourceKeys: { plants: new Set(sources.plants), bees: new Set(sources.bees) },
    recipeMaps: [],
    recipeCount: 0,
    shards: [],
  } as unknown as Parameters<typeof queryCatalogResources>[0];
}

describe.each([
  ["without NEI's order", undefined],
  ["with NEI's order", resourceOrder],
])("the browser's item search %s", (_label, order) => {
  it("answers every request as the server's route does", async () => {
    const catalog = serverCatalog(order);
    // The file as the browser parses it, from the server's own writer.
    const file = JSON.parse(
      JSON.stringify({
        schemaVersion: 2,
        resourceIndex,
        ...(order ? { resourceOrder: order } : {}),
        directionCounts: counts,
        sources,
      }),
    ) as ResourceSearchFile;
    const engine = createResourceSearchEngine(file);
    const sorts: ResourceQuerySort[] = [
      "relevance",
      "name",
      "mod",
      "recipes",
      "made",
      "uses",
      "popular",
      "nei",
      "nei-filter",
    ];
    let compared = 0;
    for (const query of [
      "",
      "s",
      "st",
      "steel",
      "steel plate",
      "stel plat",
      "lv",
      "motor lv",
      "ebf",
      "oaklog",
      "zzzz",
    ]) {
      for (const sort of sorts) {
        for (const extra of [
          {},
          { kind: "fluid" as const },
          { mod: "gregtech" },
          { source: "plants" as const },
        ]) {
          for (const [offset, limit] of [
            [0, 120],
            [2, 3],
          ]) {
            const request = {
              query,
              offset,
              limit,
              sort,
              ...extra,
              popularity: sort === "popular" ? popularity : undefined,
            };
            const server = JSON.parse(
              JSON.stringify(await queryCatalogResources(catalog, request)),
            );
            const browser = JSON.parse(JSON.stringify(engine(request)));
            expect(browser, JSON.stringify(request)).toEqual(server);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(11 * 9 * 4 * 2);
  });

  it("corrects a misspelling the way the server does", () => {
    const file = { schemaVersion: 1 as const, resourceIndex, directionCounts: counts, sources };
    const answer = createResourceSearchEngine(file)({ query: "stel plat", offset: 0, limit: 120 });
    expect(answer.searchPhase).toBe("corrected");
    expect(answer.resources[0]?.displayName).toBe("Steel Plate");
  });
});

describe("the NEI sorts", () => {
  const ids = (answer: { resources: Array<{ kind: string; id: string }> }) =>
    answer.resources.map((entry) => `${entry.kind}:${entry.id}`);
  const engine = (order?: Array<number | null>) =>
    createResourceSearchEngine({
      schemaVersion: 2,
      resourceIndex,
      ...(order ? { resourceOrder: order } : {}),
      directionCounts: counts,
      sources,
    });

  it("are ready when the engine is: the rank table is built at load, on the server by the prewarm", () => {
    expect(engine(resourceOrder).indexes.neiRanks).toBeInstanceOf(Int32Array);
    const catalog = serverCatalog(resourceOrder);
    expect(warmResourceSearch(catalog).neiRanks).toBeInstanceOf(Int32Array);
  });

  it("list everything in NEI's order with nothing typed, unlisted records after", () => {
    const answer = engine(resourceOrder)({ query: "", offset: 0, limit: 120, sort: "nei" });
    expect(ids(answer)).toEqual([
      "fluid:water",
      "item:minecraft:glass",
      "item:minecraft:log",
      "item:minecraft:wheat",
      "item:ic2:itemCellEmpty",
      "item:gregtech:gt.metaitem.01@17305",
      "item:gregtech:gt.metaitem.01@2305",
      "item:gregtech:gt.metaitem.01@11305",
      "item:gregtech:gt.metaitem.01@32610",
      "item:gregtech:gt.metaitem.01@32611",
      "item:gregtech:gt.blockmachines@1000",
      // Not in NEI's list: after it, in the approximation's order.
      "item:forestry:beeCombs",
      "fluid:molten.steel",
    ]);
    expect(ids(engine(resourceOrder)({ query: "", offset: 0, limit: 120, sort: "nei-filter" }))).toEqual(ids(answer));
  });

  it("fall back to the approximation for a dataset without NEI's order", () => {
    const answer = engine()({ query: "", offset: 0, limit: 120, sort: "nei" });
    expect(ids(answer)).toEqual([
      "item:minecraft:glass",
      "item:minecraft:log",
      "item:minecraft:wheat",
      "item:forestry:beeCombs",
      "item:gregtech:gt.blockmachines@1000",
      "item:gregtech:gt.metaitem.01@2305",
      "item:gregtech:gt.metaitem.01@11305",
      "item:gregtech:gt.metaitem.01@17305",
      "item:gregtech:gt.metaitem.01@32610",
      "item:gregtech:gt.metaitem.01@32611",
      "item:ic2:itemCellEmpty",
      "fluid:molten.steel",
      "fluid:water",
    ]);
  });

  it("rank a typed query by match first and settle equal matches in NEI's order", () => {
    const nei = ids(engine(resourceOrder)({ query: "steel", offset: 0, limit: 120, sort: "nei" }));
    const best = ids(engine(resourceOrder)({ query: "steel", offset: 0, limit: 120, sort: "relevance" }));
    // Best match settles the three equal "Steel ..." names by recipe count and name length.
    expect(best.slice(0, 3)).toEqual([
      "item:gregtech:gt.metaitem.01@11305",
      "item:gregtech:gt.metaitem.01@17305",
      "item:gregtech:gt.metaitem.01@2305",
    ]);
    // As in NEI settles them where NEI lists them: plate, dust, ingot.
    expect(nei.slice(0, 3)).toEqual([
      "item:gregtech:gt.metaitem.01@17305",
      "item:gregtech:gt.metaitem.01@2305",
      "item:gregtech:gt.metaitem.01@11305",
    ]);
    // A weaker match stays below them.
    expect(nei.indexOf("fluid:molten.steel")).toBeGreaterThan(2);
  });

  it("filter only, in NEI's order, with no ranking", () => {
    const answer = engine(resourceOrder)({ query: "steel", offset: 0, limit: 120, sort: "nei-filter" });
    expect(ids(answer)).toEqual([
      "item:gregtech:gt.metaitem.01@17305",
      "item:gregtech:gt.metaitem.01@2305",
      "item:gregtech:gt.metaitem.01@11305",
      "fluid:molten.steel",
    ]);
  });
});

