import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NEI_DEFAULT_SORT, neiItemOrderFromExport, neiSortProblem, resourceOrderFor } from "./nei-item-order.mjs";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

function item(id, displayName) {
  return { kind: "item", id, amount: 1, displayName, icon: undefined };
}

function fluid(id, displayName) {
  return { kind: "fluid", id, amount: 1000, displayName };
}

/**
 * The export through the pipeline's own scripts, as generate-dataset runs them: normalize,
 * build-resource-index, build-recipe-index. Answers recipes.json and resource-index.json.gz.
 */
function runPipeline(rawExport) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nei-item-order-"));
  try {
    const input = path.join(dir, "oracle-export.json");
    const recipes = path.join(dir, "recipes.json");
    fs.writeFileSync(input, JSON.stringify(rawExport));
    const env = { ...process.env, GTNH_DATASET_VERSION_ID: "nei-order", GTNH_DATASET_VERSION_LABEL: "2.9.0" };
    for (const [name, args] of [
      ["normalize-oracle-export.mjs", [input, recipes]],
      ["build-resource-index.mjs", [recipes]],
      ["build-recipe-index.mjs", [recipes, dir]],
    ]) {
      execFileSync(process.execPath, [script(name), ...args], { env, stdio: "pipe" });
    }
    return {
      dataset: JSON.parse(fs.readFileSync(recipes, "utf8")),
      catalog: JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, "resource-index.json.gz"))).toString("utf8")),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const EXPORT = {
  domains: [
    {
      id: "gregtech",
      recipeMaps: [
        {
          id: "gt.recipe.mixer",
          name: "Mixer",
          recipes: [
            {
              id: "mix",
              durationTicks: 20,
              eut: 30,
              itemInputs: [item("minecraft:stone", "Stone"), item("gregtech:gt.metaitem.01@2086", "Gold Dust")],
              fluidInputs: [fluid("water", "Water")],
              itemOutputs: [item("ic2:itembatre", "RE-Battery"), item("modx:onlyinrecipes", "Ghost")],
            },
          ],
        },
      ],
    },
  ],
};

const PLACES = (dataset) =>
  Object.fromEntries(
    dataset.resourceIndex.map((resource, index) => [`${resource.kind}:${resource.id}`, dataset.resourceOrder[index]]),
  );

describe("NEI's item order through the pipeline", () => {
  it("places each resource at its first stack, a resource listed several times (NBT) at the smallest index", () => {
    const { dataset, catalog } = runPipeline({
      ...EXPORT,
      neiItemList: {
        status: "exported",
        sort: NEI_DEFAULT_SORT.join(","),
        // The charged battery, then the empty one: one resource, two stacks.
        stacks: [
          "item:minecraft:stone",
          "item:ic2:itembatre",
          "fluid:water",
          "item:ic2:itembatre",
          "item:gregtech:gt.metaitem.01@2086",
          null,
        ],
      },
    });
    expect(dataset.neiItemOrder).toEqual([
      "item:minecraft:stone",
      "item:ic2:itembatre",
      "fluid:water",
      "item:gregtech:gt.metaitem.01@2086",
    ]);
    expect(dataset.resourceOrder).toHaveLength(dataset.resourceIndex.length);
    expect(PLACES(dataset)).toMatchObject({
      "item:minecraft:stone": 0,
      "item:ic2:itembatre": 1,
      "fluid:water": 2,
      "item:gregtech:gt.metaitem.01@2086": 3,
    });
    // Beside the records in the server's catalog, never a field on them.
    expect(catalog.resourceOrder).toEqual(dataset.resourceOrder);
    expect(catalog.resourceIndex.every((record) => !("resourceOrder" in record) && !("neiOrder" in record))).toBe(true);
  });

  it("leaves a resource NEI does not list unplaced (null), for the search to put after every placed one", () => {
    const { dataset } = runPipeline({
      ...EXPORT,
      neiItemList: { status: "exported", sort: NEI_DEFAULT_SORT.join(","), stacks: ["item:minecraft:stone", "fluid:water"] },
    });
    const places = PLACES(dataset);
    expect(places["item:modx:onlyinrecipes"]).toBeNull();
    expect(places["item:ic2:itembatre"]).toBeNull();
    expect(places["item:minecraft:stone"]).toBe(0);
  });

  it("writes no order at all for an export without NEI's list, or whose list failed", () => {
    for (const rawExport of [EXPORT, { ...EXPORT, neiItemList: { status: "failed", error: "boom" } }]) {
      const { dataset, catalog } = runPipeline(rawExport);
      expect(dataset.neiItemOrder).toBeUndefined();
      expect(dataset.resourceOrder).toBeUndefined();
      expect("resourceOrder" in catalog).toBe(false);
    }
  });
});

const DEFAULT = NEI_DEFAULT_SORT.join(",");

describe("the order helpers", () => {
  it("take a list only when it was sorted by NEI's default, mods' own rules after it allowed", () => {
    const list = (sort) => ({ status: "exported", sort, stacks: ["item:a"] });
    expect(neiSortProblem(list(DEFAULT))).toBeUndefined();
    expect(neiItemOrderFromExport(list(`${DEFAULT},somemod.itemsort.colour`))).toEqual(["item:a"]);
    const changed = list("nei.itemsort.name,nei.itemsort.minecraft,nei.itemsort.mod,nei.itemsort.id,nei.itemsort.default,nei.itemsort.damage");
    expect(neiSortProblem(changed)).toMatch(/not NEI's default/);
    expect(neiItemOrderFromExport(changed)).toBeUndefined();
    expect(neiItemOrderFromExport({ status: "exported", stacks: ["item:a"] })).toBeUndefined();
  });

  it("keep each key once at its first place and skip what is not a key", () => {
    expect(
      neiItemOrderFromExport({ status: "exported", sort: DEFAULT, stacks: ["item:b", "item:a", "item:b", "", null, 3, "item:c"] }),
    ).toEqual(["item:b", "item:a", "item:c"]);
    expect(neiItemOrderFromExport({ status: "exported", sort: DEFAULT, stacks: [] })).toBeUndefined();
    expect(neiItemOrderFromExport(undefined)).toBeUndefined();
  });

  it("keep the export's order as is, so a collapsible group the oracle put together stays together", () => {
    // The oracle moves a group's members (cells of several mods) to the first member's place.
    const stacks = ["item:minecraft:stone", "item:ic2:itemcellempty", "item:gregtech:gt.metaitem.01@30", "item:gregtech:gt.metaitem.01@31", "item:gregtech:gt.blockores"];
    const records = stacks.map((key) => ({ kind: "item", id: key.slice("item:".length) })).reverse();
    const order = resourceOrderFor(records, neiItemOrderFromExport({ status: "exported", sort: DEFAULT, stacks }));
    const placed = records.map((record, index) => [order[index], record.id]).sort((left, right) => left[0] - right[0]);
    expect(placed.map(([, id]) => `item:${id}`)).toEqual(stacks);
  });

  it("place records by kind and id", () => {
    expect(
      resourceOrderFor(
        [
          { kind: "item", id: "a" },
          { kind: "fluid", id: "a" },
          { kind: "item", id: "z" },
        ],
        ["fluid:a", "item:a"],
      ),
    ).toEqual([1, 0, null]);
    expect(resourceOrderFor([{ kind: "item", id: "a" }], undefined)).toBeUndefined();
  });
});
