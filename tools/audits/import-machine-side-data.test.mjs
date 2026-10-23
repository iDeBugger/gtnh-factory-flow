import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The fixture is a real oracle machine-data/ export of GTNH 2.9.0-RC-2, trimmed to a few rows.
// Its two radio hatch rods are in reverse id order, so the importer's sort is what puts them in order.
const here = path.dirname(fileURLToPath(import.meta.url));
const importer = path.join(here, "import-machine-side-data.mjs");
const fixture = path.join(here, "fixtures", "machine-data");

const temps = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(args) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "machine-side-data-"));
  temps.push(tmp);
  const result = spawnSync(process.execPath, [importer, ...args(tmp)], { cwd: tmp, encoding: "utf8" });
  return { tmp, result };
}

const read = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");

describe("import-machine-side-data", () => {
  it("writes the app's three files to --out, creating it, with --gt in every source", () => {
    const { tmp, result } = run((t) => [fixture, "--out", path.join(t, "not", "yet", "here"), "--gt", "5.09.51.476"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("2 trees, 3 vat recipes, 2 radio hatch materials");
    const out = path.join(tmp, "not", "yet", "here");

    expect(read(out, "radio-hatch.json")).toBe(
      `${JSON.stringify({
        source: "bartworks bw.recipe.radhatch, GT5U 5.09.51.476",
        materials: [
          { id: "bartworks:gt.bwmetageneratedstick@30", name: "Thorium 232 Rod", sievert: 90, mass: 1 },
          { id: "bartworks:gt.bwmetageneratedsticklong@30", name: "Long Thorium 232 Rod", sievert: 90, mass: 2 },
        ],
      })}\n`,
    );

    const tgsOutputs = (sapling) => ({
      log: { id: "minecraft:log", amount: 5 },
      sapling: { id: sapling, amount: 5 },
      leaves: { id: sapling === "minecraft:sapling" ? "minecraft:leaves" : "forestry:leaves", amount: 2 },
      fruit: { id: "minecraft:apple", amount: 1 },
    });
    expect(read(out, "tgs-trees.json")).toBe(
      `${JSON.stringify({
        source: "MTETreeFarm NEI recipes, GT5U 5.09.51.476",
        trees: [
          { sapling: { id: "minecraft:sapling", name: "Oak Sapling" }, outputs: tgsOutputs("minecraft:sapling") },
          {
            sapling: { id: "forestry:sapling", name: "Apple Oak Sapling" },
            outputs: tgsOutputs("forestry:sapling"),
            forestry: {
              species: "forestry.treeOak",
              height: 0.75,
              girth: 1,
              fertility: 0.05,
              yield: 0.025,
              base: { log: 1, sapling: 1, leaves: 1, fruit: 1 },
            },
          },
        ],
      })}\n`,
    );

    const vat = JSON.parse(read(out, "bio-vat.json"));
    expect(vat.source).toBe("bartworks bw.recipe.BacteriaVat, GT5U 5.09.51.476");
    expect(vat.recipes[0]).toEqual({
      culture: "Saccharomyces cerevisiae var bayanus",
      items: [{ id: "harvestcraft:grapeitem", amount: 16 }],
      itemOutputs: [],
      fluidIn: { id: "water", amount: 100 },
      fluidOut: { id: "potion.wine", amount: 12 },
      durationTicks: 200,
      eut: 120,
      glass: 3,
      sievert: 0,
    });
    // exact and cleanroom appear only when true, in that order after sievert.
    expect(Object.keys(vat.recipes[1]).slice(-2)).toEqual(["sievert", "exact"]);
    expect(Object.keys(vat.recipes[2]).slice(-3)).toEqual(["sievert", "exact", "cleanroom"]);
    expect(vat.recipes[2]).toMatchObject({ culture: "Cellula Biologicum Evolutione", glass: 8, sievert: 150 });
  });

  it("defaults to src/lib/machines/data under the working directory", () => {
    const { tmp, result } = run(() => [fixture, "--gt", "5.09.54.205"]);
    expect(result.status).toBe(0);
    const out = path.join(tmp, "src", "lib", "machines", "data");
    expect(JSON.parse(read(out, "radio-hatch.json")).source).toBe("bartworks bw.recipe.radhatch, GT5U 5.09.54.205");
  });

  it("refuses to run without --gt, so no file is stamped with the wrong GregTech", () => {
    const { tmp, result } = run((t) => [fixture, "--out", path.join(t, "out")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--gt");
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
  });

  // A degraded export must never install, not even in part: each case leaves the old --out as it was.
  const degraded = [
    ["a missing bio-vat.json", (input) => fs.rmSync(path.join(input, "bio-vat.json")), "the export wrote no bio-vat.json"],
    ["a missing radio-hatch.json", (input) => fs.rmSync(path.join(input, "radio-hatch.json")), "the export wrote no radio-hatch.json"],
    [
      "a failed Forestry read",
      (input) =>
        edit(input, "tgs-trees.json", (file) => {
          file.trees[1].forestry = { error: "java.lang.NoSuchMethodException: getIdent" };
        }),
      "1 of 2 trees have a failed Forestry read, first Apple Oak Sapling: java.lang.NoSuchMethodException: getIdent",
    ],
    ["no trees", (input) => edit(input, "tgs-trees.json", (file) => (file.trees = [])), "tgs-trees.json has no trees"],
    ["no vat recipes", (input) => edit(input, "bio-vat.json", (file) => (file.recipes = [])), "bio-vat.json has no recipes"],
    [
      "no radio hatch materials",
      (input) => edit(input, "radio-hatch.json", (file) => (file.materials = [])),
      "radio-hatch.json has no materials",
    ],
  ];
  for (const [name, degrade, message] of degraded) {
    it(`refuses ${name} and writes nothing`, () => {
      const { tmp, result } = run((t) => {
        const input = path.join(t, "machine-data");
        fs.cpSync(fixture, input, { recursive: true });
        degrade(input);
        fs.mkdirSync(path.join(t, "old"));
        fs.writeFileSync(path.join(t, "old", "bio-vat.json"), "old\n");
        return [input, "--out", path.join(t, "old"), "--gt", "5.09.51.476"];
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(fs.readdirSync(path.join(tmp, "old"))).toEqual(["bio-vat.json"]);
      expect(read(path.join(tmp, "old"), "bio-vat.json")).toBe("old\n");
    });
  }

  it("creates no --out directory when it refuses", () => {
    const { tmp, result } = run((t) => {
      const input = path.join(t, "machine-data");
      fs.cpSync(fixture, input, { recursive: true });
      fs.rmSync(path.join(input, "radio-hatch.json"));
      return [input, "--out", path.join(t, "new"), "--gt", "5.09.51.476"];
    });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(tmp, "new"))).toBe(false);
  });
});

function edit(dir, name, change) {
  const file = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  change(file);
  fs.writeFileSync(path.join(dir, name), JSON.stringify(file));
}
