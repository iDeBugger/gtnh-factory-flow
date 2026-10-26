/**
 * Golden responses: the sha256 of every dataset API answer over a fixed request
 * set, on every installed version, compared with a recorded baseline. A memory
 * change to the dataset caches must leave every hash as it was.
 *
 * Needs the installed datasets (public/datasets/gtnh, gitignored), so it is a
 * local harness, never in the suite:
 *
 *   GOLDEN_RECORD=1 npx vitest run src/lib/server/dataset-responses.local.test.ts --config vitest.local.config.ts
 *   npx vitest run src/lib/server/dataset-responses.local.test.ts --config vitest.local.config.ts
 *
 * The baseline lives in scratch/golden (gitignored), keyed by each version's
 * manifest checksum: a reinstalled dataset needs a new baseline, not a fix.
 * The whole set runs twice per version, so answers served from warm and evicted
 * caches are held to the same hashes as cold ones.
 *
 * Not covered: the legacy path for a dataset without a lookup index
 * (`loadRecipeIndex` / `ensureIndexes`). No served dataset takes it: the
 * manifest rebuild skips a dataset that lacks recipe-lookup-index.json.gz, and
 * every lookup index installed carries its search text.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getDatasetCatalog,
  getDatasetRecipe,
  getDatasetRecipeIds,
  listDatasetCropFarmRecipes,
  listDatasetEecMobs,
  queryDatasetRecipes,
  queryDatasetResources,
  resolveDatasetRecipeRefs,
  type DatasetRecipeQueryRequest,
  type DatasetRecipeRef,
  type ResourceQuerySort,
} from "./dataset-query";

const VERSIONS = ["local-2.9.0-rc-2", "local-2.8.1"];
const RECORD = process.env.GOLDEN_RECORD === "1";
const root = process.cwd();
const baselinePath = path.join(root, "scratch", "golden", "dataset-responses.json");
const manifestPath = path.join(root, "public", "datasets", "gtnh", "datasets.manifest.json");

type Baseline = Record<string, { checksum: string; hashes: Record<string, string> }>;

const SORTS: ResourceQuerySort[] = [
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
// Fixed and unchanging, so the blank-list cache reuses its answer the way it does
// between two popularity sweeps.
const POPULARITY = new Map<string, number>([
  ["item:gregtech:gt.metaitem.01@11305", 50],
  ["fluid:water", 40],
  ["item:minecraft:glass", 30],
  ["fluid:oxygen", 20],
]);

const STEEL_INGOT = { kind: "item" as const, id: "gregtech:gt.metaitem.01@11305" };
const STEEL_PLATE = { kind: "item" as const, id: "gregtech:gt.metaitem.01@17305" };
const WATER = { kind: "fluid" as const, id: "water" };
const OXYGEN = { kind: "fluid" as const, id: "oxygen" };
const CIRCUIT_2 = { kind: "item" as const, id: "gregtech:gt.integrated_circuit@2" };
const ORE_PLATE_STEEL = { kind: "item" as const, id: "oredict:plateSteel" };
const GLASS = { kind: "item" as const, id: "minecraft:glass" };

type Request = [name: string, run: () => Promise<unknown>];

function recipes(versionId: string, request: Partial<DatasetRecipeQueryRequest>) {
  return queryDatasetRecipes(versionId, {
    query: "",
    mode: "recipes",
    maxTier: "all",
    offset: 0,
    limit: 48,
    ...request,
  });
}

function requestSet(versionId: string): Request[] {
  const requests: Request[] = [];
  const add = (name: string, run: () => Promise<unknown>) => requests.push([name, run]);

  add("catalog", () => getDatasetCatalog(versionId));
  add("recipe-ids", async () => ({ recipeIds: await getDatasetRecipeIds(versionId) }));
  add("crops", () => listDatasetCropFarmRecipes(versionId));
  add("mobs", () => listDatasetEecMobs(versionId));

  // Resources: the blank list in every sort, kind, source and two mods, then
  // typed searches (typos and a split typo included), then paging.
  for (const sort of SORTS) {
    for (const kind of [undefined, "item", "fluid"] as const) {
      add(`resources blank sort=${sort} kind=${kind ?? ""}`, () =>
        queryDatasetResources(versionId, {
          query: "",
          offset: 0,
          limit: 24,
          kind,
          sort,
          popularity: sort === "popular" ? POPULARITY : undefined,
        }),
      );
    }
  }
  for (const source of ["plants", "bees"] as const) {
    for (const sort of ["relevance", "name"] as const) {
      add(`resources blank source=${source} sort=${sort}`, () =>
        queryDatasetResources(versionId, { query: "", offset: 0, limit: 24, source, sort }),
      );
    }
  }
  for (const mod of ["gregtech", "minecraft"]) {
    add(`resources blank mod=${mod}`, () =>
      queryDatasetResources(versionId, { query: "", offset: 0, limit: 24, mod }),
    );
  }
  for (const [offset, limit] of [
    [24, 24],
    [1000, 120],
    [60000, 120],
  ] as const) {
    add(`resources blank page ${offset}/${limit}`, () =>
      queryDatasetResources(versionId, { query: "", offset, limit }),
    );
  }
  for (const query of ["steel", "plate", "oak log", "vaccum", "oaklog", "gt", "x", "ab", "steel plate"]) {
    for (const sort of ["relevance", "name", "made", "nei", "nei-filter"] as const) {
      add(`resources query=${query} sort=${sort}`, () =>
        queryDatasetResources(versionId, { query, offset: 0, limit: 24, sort }),
      );
    }
  }
  add("resources query=steel kind=fluid", () =>
    queryDatasetResources(versionId, { query: "steel", offset: 0, limit: 24, kind: "fluid" }),
  );
  add("resources query=steel mod=gregtech page 24", () =>
    queryDatasetResources(versionId, { query: "steel", offset: 24, limit: 24, mod: "gregtech" }),
  );
  add("resources query=seed source=plants", () =>
    queryDatasetResources(versionId, { query: "seed", offset: 0, limit: 24, source: "plants" }),
  );
  add("resources query=steel sort=popular", () =>
    queryDatasetResources(versionId, {
      query: "steel",
      offset: 0,
      limit: 24,
      sort: "popular",
      popularity: POPULARITY,
    }),
  );

  // Recipes: text only, including the unnarrowable short queries and the
  // corrected and partial phases, in one map and across all maps, paged.
  const texts = [
    "gt",
    "x",
    "ab",
    "steel",
    "steel plate",
    "ebf",
    "platinum group sludge",
    "vaccum pump",
    "oaklog",
    "hydrogen sulfide",
    "circuit",
  ];
  for (const query of texts) {
    add(`recipes query=${query}`, () => recipes(versionId, { query }));
    add(`recipes query=${query} allMaps`, () => recipes(versionId, { query, allMaps: true }));
  }
  for (const offset of [48, 500]) {
    add(`recipes query=steel allMaps offset=${offset}`, () =>
      recipes(versionId, { query: "steel", allMaps: true, offset }),
    );
  }
  add("recipes query=gt allMaps offset=5000 limit=120", () =>
    recipes(versionId, { query: "gt", allMaps: true, offset: 5000, limit: 120 }),
  );
  add("recipes query=steel maxTier=LV allMaps", () =>
    recipes(versionId, { query: "steel", allMaps: true, maxTier: "LV" }),
  );

  // The legacy single-resource form.
  add("recipes resource=steel ingot mode=recipes", () =>
    recipes(versionId, { resource: STEEL_INGOT, mode: "recipes" }),
  );
  add("recipes resource=water mode=uses", () => recipes(versionId, { resource: WATER, mode: "uses" }));
  add("recipes resource=water mode=uses recipeMap=Chemical Reactor", () =>
    recipes(versionId, { resource: WATER, mode: "uses", recipeMap: "Chemical Reactor" }),
  );

  // Clauses: single, multi-clause any/all/only, map filters, tiers, paging.
  const clause = (role: "takes" | "makes", resource: { kind: "item" | "fluid"; id: string }) => ({
    role,
    ...resource,
  });
  add("recipes makes steel ingot allMaps", () =>
    recipes(versionId, { clauses: [clause("makes", STEEL_INGOT)], allMaps: true }),
  );
  add("recipes makes steel ingot Blast Furnace", () =>
    recipes(versionId, { clauses: [clause("makes", STEEL_INGOT)], recipeMap: "Blast Furnace" }),
  );
  add("recipes takes water allMaps page 2", () =>
    recipes(versionId, { clauses: [clause("takes", WATER)], allMaps: true, offset: 48 }),
  );
  add("recipes takes water allMaps offset=2000 limit=120", () =>
    recipes(versionId, { clauses: [clause("takes", WATER)], allMaps: true, offset: 2000, limit: 120 }),
  );
  add("recipes takes circuit 2 allMaps", () =>
    recipes(versionId, { clauses: [clause("takes", CIRCUIT_2)], allMaps: true }),
  );
  add("recipes takes plateSteel allMaps", () =>
    recipes(versionId, { clauses: [clause("takes", ORE_PLATE_STEEL)], allMaps: true }),
  );
  add("recipes takes steel plate allMaps", () =>
    recipes(versionId, { clauses: [clause("takes", STEEL_PLATE)], allMaps: true }),
  );
  add("recipes takes water+oxygen any", () =>
    recipes(versionId, {
      clauses: [clause("takes", WATER), clause("takes", OXYGEN)],
      takesOp: "any",
      allMaps: true,
    }),
  );
  add("recipes takes water+oxygen all", () =>
    recipes(versionId, {
      clauses: [clause("takes", WATER), clause("takes", OXYGEN)],
      takesOp: "all",
      allMaps: true,
    }),
  );
  add("recipes takes water+oxygen only", () =>
    recipes(versionId, {
      clauses: [clause("takes", WATER), clause("takes", OXYGEN)],
      takesOp: "only",
      allMaps: true,
    }),
  );
  add("recipes takes glass makes steel any", () =>
    recipes(versionId, {
      clauses: [clause("takes", GLASS), clause("makes", STEEL_INGOT)],
      allMaps: true,
    }),
  );
  add("recipes makes steel ingot only", () =>
    recipes(versionId, { clauses: [clause("makes", STEEL_INGOT)], makesOp: "only", allMaps: true }),
  );
  add("recipes takes water query=hydrogen", () =>
    recipes(versionId, { clauses: [clause("takes", WATER)], query: "hydrogen", allMaps: true }),
  );
  add("recipes takes water maxTier=HV", () =>
    recipes(versionId, { clauses: [clause("takes", WATER)], maxTier: "HV", allMaps: true }),
  );
  add("recipes takes water exclude Chemical Reactor", () =>
    recipes(versionId, {
      clauses: [clause("takes", WATER)],
      allMaps: true,
      mapSelection: { mode: "exclude", maps: ["Chemical Reactor", "Large Chemical Reactor"] },
    }),
  );
  add("recipes takes water include Mixer", () =>
    recipes(versionId, {
      clauses: [clause("takes", WATER)],
      allMaps: true,
      mapSelection: { mode: "include", maps: ["Mixer"] },
    }),
  );
  add("recipes takes water include none", () =>
    recipes(versionId, {
      clauses: [clause("takes", WATER)],
      allMaps: true,
      mapSelection: { mode: "include", maps: [] },
    }),
  );
  add("recipes query=steel exclude Assembler", () =>
    recipes(versionId, {
      query: "steel",
      allMaps: true,
      mapSelection: { mode: "exclude", maps: ["Assembler"] },
    }),
  );
  add("recipes Blast Furnace map browse page 3", () =>
    recipes(versionId, {
      clauses: [clause("takes", OXYGEN)],
      recipeMap: "Blast Furnace",
      offset: 96,
    }),
  );

  // Recipe by id, at fixed positions across the shards (the Blast Furnace
  // shards are near 32,000 on 2.9), a crop, a mob, and one that is not there.
  add("recipe by id", async () => {
    const ids = await getDatasetRecipeIds(versionId);
    const picks = [0, 1, 1000, 32300, 32600, 33500, 100000, 200000, ids.length - 1]
      .filter((index) => index < ids.length)
      .map((index) => ids[index]);
    const crops = (await listDatasetCropFarmRecipes(versionId)).crops;
    const mobs = (await listDatasetEecMobs(versionId)).mobs;
    if (crops[0]) picks.push(crops[0].id);
    if (mobs[0]) picks.push(mobs[0].id);
    picks.push("no-such-recipe");
    const out: unknown[] = [];
    for (const id of picks) {
      out.push([id, (await getDatasetRecipe(versionId, id)) ?? null]);
    }
    return out;
  });

  // Plan import: refs rebuilt from real bodies under new ids (exact), one with
  // a changed EU (near match), one settled only by its raw recipe id.
  add("resolve-recipes", async () => {
    const ids = await getDatasetRecipeIds(versionId);
    const refs: DatasetRecipeRef[] = [];
    for (const index of [1000, 32600, 100000]) {
      const recipe = index < ids.length ? await getDatasetRecipe(versionId, ids[index]) : undefined;
      if (!recipe) continue;
      const ref: DatasetRecipeRef = {
        id: `imported-${index}`,
        name: recipe.name,
        machineType: recipe.machineType,
        recipeMap: recipe.source?.recipeMap,
        inputs: recipe.inputs,
        outputs: recipe.outputs,
        durationTicks: recipe.durationTicks,
        eut: recipe.eut,
      };
      refs.push(ref);
      refs.push({ ...ref, id: `imported-${index}-eu`, eut: (recipe.eut ?? 0) + 1 });
      if (recipe.source?.rawRecipeId) {
        refs.push({
          id: `imported-${index}-raw`,
          name: recipe.name,
          machineType: recipe.machineType,
          rawRecipeId: recipe.source.rawRecipeId,
          inputs: recipe.inputs,
          outputs: [{ kind: "item", id: "nothing:at-all", amount: 1 } as never, ...recipe.outputs],
          durationTicks: recipe.durationTicks,
          eut: recipe.eut,
        });
      }
    }
    return { matches: await resolveDatasetRecipeRefs(versionId, refs) };
  });

  return requests;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function manifestChecksum(versionId: string): string {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    versions: Array<{ id: string; checksumSha256?: string }>;
  };
  return manifest.versions.find((version) => version.id === versionId)?.checksumSha256 ?? "";
}

async function hashAll(versionId: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const pass of [1, 2]) {
    for (const [name, run] of requestSet(versionId)) {
      const hash = sha256(await run());
      if (pass === 1) {
        hashes[name] = hash;
      } else if (hashes[name] !== hash) {
        hashes[`${name} (second pass)`] = hash;
      }
    }
  }
  return hashes;
}

// Without the installed datasets there is nothing to compare: skip rather than fail.
describe.skipIf(!fs.existsSync(manifestPath))("dataset responses stay byte for byte", () => {
  const baseline: Baseline = fs.existsSync(baselinePath)
    ? (JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Baseline)
    : {};

  for (const versionId of VERSIONS) {
    it(
      versionId,
      async () => {
        const checksum = manifestChecksum(versionId);
        const started = Date.now();
        const hashes = await hashAll(versionId);
        console.info(`${versionId}: ${Object.keys(hashes).length} responses in ${Date.now() - started} ms`);
        if (RECORD) {
          baseline[versionId] = { checksum, hashes };
          fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
          fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
          return;
        }
        const recorded = baseline[versionId];
        expect(recorded, `no baseline for ${versionId}`).toBeDefined();
        expect(checksum, `${versionId} was reinstalled since the baseline: record again`).toBe(
          recorded.checksum,
        );
        const changed = Object.keys({ ...recorded.hashes, ...hashes }).filter(
          (name) => recorded.hashes[name] !== hashes[name],
        );
        expect(changed).toEqual([]);
      },
      1_200_000,
    );
  }
});
