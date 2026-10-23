// The Tree Growth Simulator's and Bacterial Vat's facts the dataset lacks, read from the running pack: the oracle
// export writes them to machine-data/ beside oracle-export.json (the in-game mod's dev harness command
// `mc.sh call 'machinedata?dir=<dir>'` writes the same files). Trimmed to what the app reads and written to --out,
// src/lib/machines/data/ by default. --gt names the pack's GT5U version in each file's source. Never hand-edit the
// outputs; rerun this after a pack update.
//   node tools/audits/import-machine-side-data.mjs <machine-data dir> --gt <GT5U version> [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string", default: "src/lib/machines/data" }, gt: { type: "string" } },
});
const [dir] = positionals;
if (!dir) throw new Error("Expected the machine-data directory the export wrote");
// No default: a file stamped with another pack's GregTech would read as that pack's data.
if (!values.gt) throw new Error("Expected --gt <GT5U version>, e.g. --gt 5.09.54.205");
const gt = `GT5U ${values.gt}`;
// Every input is read and checked before anything is written, so a failed run never leaves a half-new --out.
const read = (name, list) => {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}: the export wrote no ${name}`);
  const items = JSON.parse(fs.readFileSync(file, "utf8"))[list];
  if (!Array.isArray(items) || items.length === 0) throw new Error(`${name} has no ${list}`);
  return items;
};
const amount = (entry) => (entry ? { id: entry.id, amount: entry.amount } : undefined);

const rawTrees = read("tgs-trees.json", "trees");
// A failed Forestry read would drop the genes that scale a sapling's outputs, so the numbers would be wrong.
const failed = rawTrees.filter((tree) => tree.forestry?.error);
if (failed.length > 0) {
  throw new Error(
    `${failed.length} of ${rawTrees.length} trees have a failed Forestry read, first ${failed[0].sapling?.name}: ${failed[0].forestry.error}`,
  );
}
const trees = rawTrees.map((tree) => ({
  sapling: { id: tree.sapling.id, name: tree.sapling.name },
  outputs: Object.fromEntries(Object.entries(tree.outputs).map(([mode, entry]) => [mode, amount(entry)])),
  ...(tree.forestry ? { forestry: tree.forestry } : {}),
}));
if (trees.some((tree) => !tree.sapling.id || Object.keys(tree.outputs).length === 0)) {
  throw new Error("A tree without a sapling or outputs");
}

const vat = read("bio-vat.json", "recipes").map((recipe) => ({
  culture: recipe.culture,
  items: recipe.items.map(amount),
  itemOutputs: recipe.itemOutputs.map(amount),
  fluidIn: amount(recipe.fluidIn),
  fluidOut: amount(recipe.fluidOut),
  durationTicks: recipe.durationTicks,
  eut: recipe.eut,
  glass: recipe.glass,
  sievert: recipe.sievert,
  ...(recipe.exact ? { exact: true } : {}),
  ...(recipe.cleanroom ? { cleanroom: true } : {}),
}));

// GT++ registers its rods from a hash-ordered collection, so the export's order changes on every launch. Sorted by id,
// by code point so the host locale never matters, the file changes only when the materials do.
const materials = read("radio-hatch.json", "materials")
  .map((material) => ({
    id: material.id,
    name: material.name,
    sievert: material.sievert,
    mass: material.mass,
  }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const out = path.resolve(values.out);
fs.mkdirSync(out, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(value)}\n`);
write("tgs-trees.json", { source: `MTETreeFarm NEI recipes, ${gt}`, trees });
write("bio-vat.json", { source: `bartworks bw.recipe.BacteriaVat, ${gt}`, recipes: vat });
write("radio-hatch.json", { source: `bartworks bw.recipe.radhatch, ${gt}`, materials });

console.log(`${trees.length} trees, ${vat.length} vat recipes, ${materials.length} radio hatch materials`);
