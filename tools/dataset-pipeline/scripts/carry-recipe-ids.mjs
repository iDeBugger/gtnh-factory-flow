// Give one dataset another's recipe ids.
//
// The normalizer mints ids from what a recipe is (recipeContentKey in
// normalize-oracle-export.mjs), without the dataset version, so a rebuild or a
// new pack needs no carrying. This script remains for datasets built before
// that, whose ids carried the version and an export-order counter: it takes
// the previous dataset's id for every recipe that does the same thing (same
// map, slots, amounts, chances, ticks and EU), and recipes named by a game
// identity (a bee species, a crop, a vein, a mob, an underground fluid) keep
// theirs when that identity is unchanged. Everything else keeps its new id.
// Run the other way round (a fresh build as "previous", a copy of a published
// dataset as "new"), it lets the two be compared recipe by recipe.
//
// Usage: node carry-recipe-ids.mjs <previous recipes.json[.gz]> <new recipes.json> [report.json]
// Rewrites the new recipes.json in place.
import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";

const [previousPath, nextPath, reportPath] = process.argv.slice(2);
if (!previousPath || !nextPath) {
  console.error("Usage: carry-recipe-ids.mjs <previous recipes.json[.gz]> <new recipes.json> [report.json]");
  process.exit(1);
}

// Kinds whose id is a game identity rather than a content hash or an index.
const IDENTITY_CATEGORIES = new Set([
  "forestry-bee",
  "ic2-crop",
  "cropsnh-crop",
  "kubatech-eec",
  "ore-vein",
  "small-ore",
  "underground-fluid",
]);

function lines(filePath) {
  const stream = fs.createReadStream(filePath);
  const input = filePath.endsWith(".gz") ? stream.pipe(zlib.createGunzip()) : stream;
  return readline.createInterface({ input, crlfDelay: Infinity });
}

function slot(entry, output) {
  return [
    entry.kind,
    entry.id,
    entry.amount ?? "",
    output ? "" : entry.consumed === false ? "nc" : "",
    entry.chance ?? "",
  ].join("|");
}

// GregTech maps by their game id, as it reads in the newest pack: GT++ merged
// into GregTech in 2.9.0-RC-1, so its gtpp.recipe.* maps are gt.recipe.* there,
// and the Industrial Coke Oven's map took the machine's name. Display names
// changed too ("Naquadah Reactor MkII" is "Mk-II"), so names are not used.
const MAP_RENAMES = new Map([["gtpp.recipe.cokeoven", "gt.recipe.industrialcokeoven"]]);

function gameMap(recipe) {
  const raw = String(recipe.source?.rawRecipeId ?? "");
  const colon = raw.lastIndexOf(":");
  if (recipe.category !== "gregtech" || colon <= 0 || !raw.includes(".recipe.")) {
    return undefined;
  }
  const map = raw.slice(0, colon);
  return MAP_RENAMES.get(map) ?? map.replace(/^gtpp\.recipe\./, "gt.recipe.");
}

function machineKey(recipe) {
  return gameMap(recipe) ?? String(recipe.machineType ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function contentKey(recipe) {
  return JSON.stringify([
    recipe.category,
    recipe.kind,
    machineKey(recipe),
    recipe.specialValue ?? null,
    recipe.durationTicks ?? null,
    recipe.eut ?? null,
    (recipe.inputs ?? []).map((entry) => slot(entry, false)).sort(),
    (recipe.outputs ?? []).map((entry) => slot(entry, true)).sort(),
  ]);
}

// An id is `oracle:<category>:...`, or `oracle:<dataset version>:<category>:...`
// in datasets built before ids left the version out.
function identityKey(recipe) {
  const rest = String(recipe.id).replace(/^oracle:/, "");
  const unversioned = rest.startsWith(`${recipe.category}:`) ? rest : rest.slice(rest.indexOf(":") + 1);
  return `${recipe.category}|${unversioned}`;
}

function recipeLine(line) {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  return JSON.parse(trimmed.replace(/,$/, ""));
}

async function readPrevious(filePath) {
  const byContent = new Map();
  const byIdentity = new Map();
  const all = new Map();
  let inRecipes = false;
  for await (const line of lines(filePath)) {
    if (/^ {2}"[^"]+": /.test(line)) {
      inRecipes = line.startsWith('  "recipes": [');
      continue;
    }
    if (!inRecipes) {
      continue;
    }
    const recipe = recipeLine(line);
    if (!recipe) {
      continue;
    }
    all.set(recipe.id, recipe.category);
    const key = contentKey(recipe);
    if (!byContent.has(key)) {
      byContent.set(key, []);
    }
    byContent.get(key).push(recipe.id);
    if (IDENTITY_CATEGORIES.has(recipe.category)) {
      byIdentity.set(identityKey(recipe), recipe.id);
    }
  }
  return { byContent, byIdentity, all };
}

function bump(table, category, field) {
  table[category] ??= { kept: 0, keptByIdentity: 0, new: 0, gone: 0 };
  table[category][field] += 1;
}

async function main() {
  const previous = await readPrevious(previousPath);
  const used = new Set();
  const counts = {};
  const pendingIdentity = [];
  const outPath = `${nextPath}.carry-tmp`;
  const out = fs.createWriteStream(outPath);
  const write = (text) =>
    new Promise((resolve) => (out.write(text) ? resolve() : out.once("drain", resolve)));

  // Pass one: exact content. Pass two (identity kinds) needs to know which
  // previous ids exact matches took, so identity recipes are held and written
  // in place once the whole file has been read: they are few.
  const buffered = [];
  let inRecipes = false;
  for await (const line of lines(nextPath)) {
    if (/^ {2}"[^"]+": /.test(line)) {
      inRecipes = line.startsWith('  "recipes": [');
      buffered.push({ text: line });
      continue;
    }
    const recipe = inRecipes ? recipeLine(line) : undefined;
    if (!recipe) {
      buffered.push({ text: line });
      continue;
    }
    const candidates = previous.byContent.get(contentKey(recipe)) ?? [];
    const match = candidates.find((id) => !used.has(id));
    const prefix = line.slice(0, line.length - line.trimStart().length);
    const comma = line.trimEnd().endsWith(",") ? "," : "";
    if (match) {
      used.add(match);
      recipe.id = match;
      bump(counts, recipe.category, "kept");
      buffered.push({ text: `${prefix}${JSON.stringify(recipe)}${comma}` });
    } else if (IDENTITY_CATEGORIES.has(recipe.category)) {
      const entry = { recipe, prefix, comma, text: undefined };
      pendingIdentity.push(entry);
      buffered.push(entry);
    } else {
      bump(counts, recipe.category, "new");
      buffered.push({ text: line });
    }
    // Flush everything before the first pending identity recipe.
    if (pendingIdentity.length === 0 && buffered.length > 4096) {
      for (const item of buffered.splice(0)) {
        await write(`${item.text}\n`);
      }
    }
  }

  const changedIdentity = [];
  for (const entry of pendingIdentity) {
    const id = previous.byIdentity.get(identityKey(entry.recipe));
    if (id && !used.has(id)) {
      used.add(id);
      entry.recipe.id = id;
      bump(counts, entry.recipe.category, "keptByIdentity");
      changedIdentity.push(id);
    } else {
      bump(counts, entry.recipe.category, "new");
    }
    entry.text = `${entry.prefix}${JSON.stringify(entry.recipe)}${entry.comma}`;
  }
  for (const item of buffered) {
    await write(`${item.text}\n`);
  }
  await new Promise((resolve) => out.end(resolve));

  const goneIds = [];
  for (const [id, category] of previous.all) {
    if (!used.has(id)) {
      bump(counts, category, "gone");
      goneIds.push(id);
    }
  }
  fs.renameSync(outPath, nextPath);

  const totals = { kept: 0, keptByIdentity: 0, new: 0, gone: 0 };
  for (const row of Object.values(counts)) {
    for (const field of Object.keys(totals)) {
      totals[field] += row[field];
    }
  }
  console.table({ ...counts, TOTAL: totals });
  if (reportPath) {
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify({ previous: previousPath, counts, totals, keptByIdentity: changedIdentity, gone: goneIds }, null, 1)}\n`,
    );
  }
}

await main();
