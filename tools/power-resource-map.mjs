#!/usr/bin/env node
/**
 * Resolves every fuel / loop-fluid name the power sector uses against the
 * live dataset's resources API, and bakes the matches into
 * src/lib/power/data/resource-map.json (name -> slot metadata). Names that
 * do not resolve are listed at the end; power cards show those flows as
 * stats instead of wired ports until an alias is added below.
 *
 *   node tools/power-resource-map.mjs [--base https://gtnhplanner.com] [--version local-2.9.0-beta-2]
 *     [--data scratch/power-tables-2.8.1.json] [--out src/lib/power/data/2.8.1/resource-map.json]
 *
 * --data takes tools/power-tables-dump.ts output: its tables replace the workbook extract, and
 * every flow name its sources produce is resolved too, so a version's own fuels and products
 * are found even where no table lists them. Without it the workbook extract is read as before.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const dump = argValue("--data") ? JSON.parse(fs.readFileSync(argValue("--data"), "utf8")) : undefined;
const outPath = argValue("--out")
  ? path.resolve(argValue("--out"))
  : path.join(repoRoot, "src", "lib", "power", "data", "resource-map.json");
const base = args[args.indexOf("--base") + 1] && args.includes("--base")
  ? args[args.indexOf("--base") + 1]
  : "https://gtnhplanner.com";
const version = args.includes("--version") ? args[args.indexOf("--version") + 1] : "local-2.9.0-beta-2";

const data =
  dump?.tables ??
  JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "lib", "power", "data", "power-planner-data.json"), "utf8"));

/**
 * Spreadsheet name -> the dataset display name (or [name, kind]) when they
 * differ. Grown by running this script and reading the unresolved list.
 */
const ALIASES = {
  "SH Steam": "Superheated Steam",
  "SC Steam": "Supercritical Steam",
  "Dense SH Steam": "Dense Superheated Steam",
  "Dense SC Steam": "Dense Supercritical Steam",
  "Bio Gas": "Biogas",
  "CO2": "Carbon Dioxide",
  "Diesel": "Fuel",
  "Diesel (Fuel)": "Fuel",
  "Ethanol": "Bio Ethanol",
  "Coolant": "IC2 Coolant",
  "Hot Coolant": "IC2 Hot Coolant",
  "Cryotheum": "Gelid Cryotheum",
  "Cold Solar Salt": "Solar Salt (Cold)",
  "Hot Solar Salt": "Solar Salt (Hot)",
  "RP-1 (red)": "Rp-1 Rocket Fuel",
  "CN3H703 (Purple)": "CN3H7O3 Rocket Fuel",
  "H8N4C2O4 (Green)": "H8N4C2O4 Rocket Fuel",
  "EIO Rocket Fuel": "Rocket Fuel",
  "Naq Fuel Mk-I": "Naquadah Based Liquid Fuel MkI",
  "Naq Fuel Mk-II": "Naquadah Based Liquid Fuel MkII",
  "Naq Fuel Mk-III": "Naquadah Based Liquid Fuel MkIII",
  "Naq Fuel Mk-IV": "Naquadah Based Liquid Fuel MkIV",
  "Naq Fuel Mk-V": "Naquadah Based Liquid Fuel MkV",
  "Naq Fuel Mk-VI": "Naquadah Based Liquid Fuel MkVI",
  "Thorium Fuel (Excited)": "Thorium Based Liquid Fuel (Excited State)",
  "Uranium Fuel (Excited)": "Uranium Based Liquid Fuel (Excited State)",
  "Plutonium Fuel (Excited)": "Plutonium Based Liquid Fuel (Excited State)",
  "Molten Uranium-235": "Molten Uranium 235",
  "Molten Uranium-238": "Molten Uranium 238",
  "Molten Plutonium-239": "Molten Plutonium 239",
  "Molten Plutonium-241": "Molten Plutonium 241",
  "Uranium-233": "Molten Uranium 233",
  "Uranium-235 Plasma": "Uranium 235 Plasma",
  "Uranium-238 Plasma": "Uranium 238 Plasma",
  "Plutonium-239 Plasma": "Plutonium 239 Plasma",
  "Plutonium-241 Plasma": "Plutonium 241 Plasma",
  "Sulfuric Naphta": "Sulfuric Naphtha",
  "Industrial Hydrofluoric Acid": "Industrial Strength Hydrofluoric Acid",
  "Industrial Hydrogen Chloride": "Industrial Strength Hydrogen Chloride",
  "Tiberium Bolt (EV)": "Tiberium Bolt",
  "Tiberium Rod (IV)": "Tiberium Rod",
  "Long Tiberium Rod (LuV)": "Long Tiberium Rod",
  "Enriched Naquadah Bolt (EV)": "Enriched Naquadah Bolt",
  "Enriched Naquadah Rod (IV)": "Enriched Naquadah Rod",
  "Long Enriched Naquadah Rod (LuV)": "Long Enriched Naquadah Rod",
  "Naquadria Bolt (ZPM)": "Naquadria Bolt",
  "Naquadria Rod (UV)": "Naquadria Rod",
  "Forestry Biomass": "Biomass",
  "Li2BeF4": "Lithium Tetrafluoroberyllate (LFTB)",
  "U-Salt": "Uranium Depleted Molten Salt (U Salt)",
  "T-Salt": "Thorium Depleted Molten Salt (T Salt)",
  "TB-Salt": "Thorium-Beryllium Depleted Molten Salt (TB Salt)",
  UF6: "Uranium Hexafluoride",
  "Molten Tengam": "Molten Purified Tengam",
  // GT++'s agrichem registers Poop Juice as the fluid "raw.waste", shown as Raw Animal Waste.
  "Poop Juice": "Raw Animal Waste",
};

/** Names whose match is a specific id (display-name collisions). */
const ID_OVERRIDES = {
  "Block of Cactus Coke": { kind: "item", id: "miscutils:blockcactuscoke" },
  "Block of Sugar Coke": { kind: "item", id: "miscutils:blocksugarcoke" },
  "Ench. Golden Apple": { kind: "item", id: "minecraft:golden_apple@1" },
  // The RTG pellets' display names carry private-use glyph prefixes that
  // defeat the exact-name match; pin them by id.
  "Pu Pellet": { kind: "item", id: "miscutils:mu-metaitem.01@32041" },
  "Sr Pellet": { kind: "item", id: "miscutils:mu-metaitem.01@32042" },
  "Po Pellet": { kind: "item", id: "miscutils:mu-metaitem.01@32043" },
  "Am Pellet": { kind: "item", id: "miscutils:mu-metaitem.01@32044" },
};

/**
 * Per game version (the --data dump's gameVersion; 2.9 without one): workbook names that pack
 * shows under another name, pinned to the item's id because the display name collides with other
 * mods' items ("Amber" is also biomesoplenty:gems@7 and thaumcraft:itemresource@6). Both packs
 * name GT gems by the bare material ("Amber") and the life essence cell "Life Cell"; 2.8.1 also
 * names GT's Void material "Void". Each is a magic fuel (5.09.51.476 ProcessingGem.java:62,
 * ProcessingDust.java:57-62, ProcessingPlate.java:107-112, ProcessingCell.java:52-60; at 5.09.54.205
 * Amber and Vinteum are magic fuel 32, MaterialsInit.java:2855, :11770).
 */
const GEM_AND_CELL_ALIASES = {
  "Amber Gem": { query: "Amber", kind: "item", id: "gregtech:gt.metaitem.01@8514" },
  "Vinteum Gem": { query: "Vinteum", kind: "item", id: "gregtech:gt.metaitem.01@8529" },
  "Life Essence Cell": { query: "Life Cell", kind: "item", id: "gregtech:gt.metaitem.01@30694" },
};
const VERSION_ID_ALIASES = {
  "2.9": GEM_AND_CELL_ALIASES,
  "2.8.1": {
    ...GEM_AND_CELL_ALIASES,
    "Void Metal Dust": { query: "Void Dust", kind: "item", id: "gregtech:gt.metaitem.01@2970" },
    "Void Metal Plate": { query: "Void Plate", kind: "item", id: "gregtech:gt.metaitem.01@17970" },
  },
};
const versionIdAliases = VERSION_ID_ALIASES[dump?.gameVersion ?? "2.9"] ?? {};

/** Flows that are settings/aux, not from the fuel tables. */
const AUX_NAMES = [
  ["Oxygen", "fluid"],
  ["Liquid Oxygen", "fluid"],
  ["Lubricant", "fluid"],
  ["Water", "fluid"],
  ["Distilled Water", "fluid"],
  ["Liquid Air", "fluid"],
  ["Coolant", "fluid"],
  ["Hot Coolant", "fluid"],
  ["Cold Solar Salt", "fluid"],
  ["Hot Solar Salt", "fluid"],
  ["Lava", "fluid"],
  ["Pahoehoe Lava", "fluid"],
  ["Carbon Dioxide", "fluid"],
  ["Air", "fluid"],
  ["Liquid Hydrogen", "fluid"],
  ["Hydrogen", "fluid"],
  ["Helium", "fluid"],
  ["Steam", "fluid"],
  ["Superheated Steam", "fluid"],
  ["Supercritical Steam", "fluid"],
  ["Dense Steam", "fluid"],
  ["Dense Superheated Steam", "fluid"],
  ["Dense Supercritical Steam", "fluid"],
  ["Uranium-233", "fluid"],
  ["Li2BeF4", "fluid"],
  ["U-Salt", "fluid"],
  ["T-Salt", "fluid"],
  ["TB-Salt", "fluid"],
  ["UF6", "fluid"],
  ["Combustion Promoter", "fluid"],
  ["Molten Tengam", "fluid"],
  ["Molten SpaceTime", "fluid"],
  ["Molten Shirabon", "fluid"],
  // Antimatter: the forge eats protomatter, the generator a UMV catalyst.
  ["Protomatter", "fluid"],
  ["Molten Superconductor Base UMV", "fluid"],
  // Byproducts: the lava boiler's obsidian, the magic converter's containers.
  ["Obsidian", "item"],
  ["Blank Slate", "item"],
  ["Apple", "item"],
  ["Stick", "item"],
  // The LNR's depleted fuel returns, litre for litre with the fuel burned.
  ["Thorium Based Liquid Fuel (Depleted)", "fluid"],
  ["Uranium Based Liquid Fuel (Depleted)", "fluid"],
  ["Plutonium Based Liquid Fuel (Depleted)", "fluid"],
  ["Naquadah Based Liquid Fuel MkI (Depleted)", "fluid"],
  ["Naquadah Based Liquid Fuel MkII (Depleted)", "fluid"],
  ["Naquadah Based Liquid Fuel MkIII (Depleted)", "fluid"],
  ["Naquadah Based Liquid Fuel MkIV (Depleted)", "fluid"],
  ["Naquadah Based Liquid Fuel MkV (Depleted)", "fluid"],
  ["Naquadah Based Liquid Fuel MkVI (Depleted)", "fluid"],
  // Spent naquadah reactor rods come back as plain naquadah parts.
  ["Naquadah Bolt", "item"],
  ["Naquadah Rod", "item"],
  ["Long Naquadah Rod", "item"],
  // RTG pellets, one every N real days.
  ["Am Pellet", "item"],
  ["Sr Pellet", "item"],
  ["Pu Pellet", "item"],
  ["Po Pellet", "item"],
  ["Pellets of RTG Fuel", "item"],
  // The Vacuum Reactor's rods (every size of every family) burn to their depleted forms.
  ["Fuel Rod (Thorium)", "item"],
  ["Fuel Rod (Depleted Thorium)", "item"],
  ["Dual Fuel Rod (Thorium)", "item"],
  ["Dual Fuel Rod (Depleted Thorium)", "item"],
  ["Quad Fuel Rod (Thorium)", "item"],
  ["Quad Fuel Rod (Depleted Thorium)", "item"],
  ["Fuel Rod (Uranium)", "item"],
  ["Fuel Rod (Depleted Uranium)", "item"],
  ["Dual Fuel Rod (Uranium)", "item"],
  ["Dual Fuel Rod (Depleted Uranium)", "item"],
  ["Quad Fuel Rod (Uranium)", "item"],
  ["Quad Fuel Rod (Depleted Uranium)", "item"],
  ["Fuel Rod (MOX)", "item"],
  ["Fuel Rod (Depleted MOX)", "item"],
  ["Dual Fuel Rod (MOX)", "item"],
  ["Dual Fuel Rod (Depleted MOX)", "item"],
  ["Quad Fuel Rod (MOX)", "item"],
  ["Quad Fuel Rod (Depleted MOX)", "item"],
  ["Fuel Rod (High Density Uranium)", "item"],
  ["Fuel Rod (Depleted High Density Uranium)", "item"],
  ["Dual Fuel Rod (High Density Uranium)", "item"],
  ["Dual Fuel Rod (Depleted High Density Uranium)", "item"],
  ["Quad Fuel Rod (High Density Uranium)", "item"],
  ["Quad Fuel Rod (Depleted High Density Uranium)", "item"],
  ["Fuel Rod (High Density Plutonium)", "item"],
  ["Fuel Rod (Depleted High Density Plutonium)", "item"],
  ["Dual Fuel Rod (High Density Plutonium)", "item"],
  ["Dual Fuel Rod (Depleted High Density Plutonium)", "item"],
  ["Quad Fuel Rod (High Density Plutonium)", "item"],
  ["Quad Fuel Rod (Depleted High Density Plutonium)", "item"],
  ["Fuel Rod (Excited Uranium)", "item"],
  ["Fuel Rod (Depleted Excited Uranium)", "item"],
  ["Dual Fuel Rod (Excited Uranium)", "item"],
  ["Dual Fuel Rod (Depleted Excited Uranium)", "item"],
  ["Quad Fuel Rod (Excited Uranium)", "item"],
  ["Quad Fuel Rod (Depleted Excited Uranium)", "item"],
  ["Fuel Rod (Excited Plutonium)", "item"],
  ["Fuel Rod (Depleted Excited Plutonium)", "item"],
  ["Dual Fuel Rod (Excited Plutonium)", "item"],
  ["Dual Fuel Rod (Depleted Excited Plutonium)", "item"],
  ["Quad Fuel Rod (Excited Plutonium)", "item"],
  ["Quad Fuel Rod (Depleted Excited Plutonium)", "item"],
  ["Fuel Rod (Naquadah)", "item"],
  ["Fuel Rod (Depleted Naquadah)", "item"],
  ["Dual Fuel Rod (Naquadah)", "item"],
  ["Dual Fuel Rod (Depleted Naquadah)", "item"],
  ["Quad Fuel Rod (Naquadah)", "item"],
  ["Quad Fuel Rod (Depleted Naquadah)", "item"],
  ["Fuel Rod (Naquadria)", "item"],
  ["Fuel Rod (Depleted Naquadria)", "item"],
  ["Dual Fuel Rod (Naquadria)", "item"],
  ["Dual Fuel Rod (Depleted Naquadria)", "item"],
  ["Quad Fuel Rod (Naquadria)", "item"],
  ["Quad Fuel Rod (Depleted Naquadria)", "item"],
  ["Fuel Rod (Tiberium)", "item"],
  ["Fuel Rod (Depleted Tiberium)", "item"],
  ["Dual Fuel Rod (Tiberium)", "item"],
  ["Dual Fuel Rod (Depleted Tiberium)", "item"],
  ["Quad Fuel Rod (Tiberium)", "item"],
  ["Quad Fuel Rod (Depleted Tiberium)", "item"],
  ["The Core", "item"],
  ["The Core (Depleted)", "item"],
  // The Vacuum Reactor's coolant cells circulate: hot out, cold in, one item.
  ["10k Coolant Cell", "item"],
  ["30k Coolant Cell", "item"],
  ["60k Coolant Cell", "item"],
  ["60k He Coolant Cell", "item"],
  ["180k He Coolant Cell", "item"],
  ["360k He Coolant Cell", "item"],
  ["60k NaK Coolant Cell", "item"],
  ["180k NaK Coolant Cell", "item"],
  ["360k NaK Coolant Cell", "item"],
  ["180k Sp Coolant Cell", "item"],
  ["360k Sp Coolant Cell", "item"],
  ["540k Sp Coolant Cell", "item"],
  ["1080k Sp Coolant Cell", "item"],
  ["1G Neutronium Heat Capacitor", "item"],
  // The THTR burns bartworks' TRISO pebbles and returns them burned, a ball
  // per 64 plus the loose rest.
  ["TRISO pebble", "item"],
  ["Burned Out TRISO pebble ball", "item"],
  ["Burned Out TRISO pebble", "item"],
  // The LNE's hydroxide boosters are dusts, one per boost window.
  ["Sodium Hydroxide Dust", "item"],
  ["Potassium Hydroxide Dust", "item"],
  ["Caesium Hydroxide Dust", "item"],
  ["Francium Hydroxide Dust", "item"],
  // The Railcraft boiler's liquid fuels the workbook tables lack (Railcraft's FuelManager, EnderIO's IMC).
  ["Hootch", "fluid"],
  ["Fire Water", "fluid"],
  ["Biofuel", "fluid"],
  ["Blazing Pyrotheum", "fluid"],
];

/**
 * Plasma exhausts follow the game's registry fallback: the de-powered
 * fluid under the plain name if one exists, else the molten form. Both
 * candidates are probed as FLUIDS ONLY - a name that only matches an item
 * must stay unresolved or the turbine would exhaust litres of an item.
 */
const STRICT_FLUID = new Set();

function collectNames() {
  const wanted = new Map();
  const add = (name, kind) => {
    if (typeof name === "string" && name.trim() && name !== "None" && !wanted.has(name.trim())) {
      wanted.set(name.trim(), kind);
    }
  };
  for (const [table, kind] of [
    ["steamGrades", "fluid"],
    ["gasFuels", "fluid"],
    ["gasFuelsXl", "fluid"],
    ["plasmas", "fluid"],
    ["combustionFuels", "fluid"],
    ["eceFuels", "fluid"],
    ["semifluidFuels", "fluid"],
    ["chemFuels", "fluid"],
    ["frostFuels", "fluid"],
    ["rocketFuels", "fluid"],
    ["lnrFuels", "fluid"],
    ["lnrCoolants", "fluid"],
    ["lnrBoosters", "fluid"],
    ["lftrFuels", "fluid"],
    ["magicSolids", "item"],
    ["naquadahRods", "item"],
  ]) {
    for (const entry of data[table]) {
      add(entry.name, kind);
    }
  }
  for (const [key, group] of Object.entries(data.boilerFuels)) {
    for (const entry of group) {
      add(entry.name, key.endsWith("Solid") ? "item" : "fluid");
    }
  }
  for (const recipe of data.fusionRecipes) {
    add(recipe.input1, "fluid");
    add(recipe.input2, "fluid");
    add(recipe.decayOutput, "fluid");
  }
  for (const [name, kind] of AUX_NAMES) {
    add(name, kind);
  }
  for (const { name, kind } of dump?.flows ?? []) {
    add(name, kind);
  }
  // kubatech's HTGR fuel and its burned form, one item per pebble material
  // (the dataset writes "Uranium 235" where the workbook says "Uranium-235").
  for (const entry of data.htgrPebbles) {
    const material = entry.name.replace("-", " ");
    add(`TRISO Fuel (${material})`, "item");
    add(`Burned Out TRISO Fuel (${material})`, "item");
  }
  for (const entry of data.plasmas) {
    const base = entry.name.replace(/ Plasma$/, "");
    if (base !== entry.name) {
      add(base, "fluid");
      STRICT_FLUID.add(base);
      add(`Molten ${base}`, "fluid");
      STRICT_FLUID.add(`Molten ${base}`);
    }
  }
  return wanted;
}

async function search(query) {
  const url = `${base}/api/datasets/${version}/resources?query=${encodeURIComponent(query)}&limit=24`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }
  return (await response.json()).resources ?? [];
}

function pick(results, displayName, kind) {
  const lower = displayName.toLowerCase();
  const exact = results.filter(
    (entry) => (entry.displayName ?? "").toLowerCase() === lower && entry.kind === kind,
  );
  if (exact.length > 0) {
    // GregTech's own molten fluids are "molten.<material>" (plasma exhaust,
    // fusion); Tinkers' share the display name, so GT's wins a "Molten" tie.
    // Otherwise prefer the busiest resource when ids collide on one name.
    const gtMolten = (entry) => (lower.startsWith("molten ") && entry.id.startsWith("molten.") ? 1 : 0);
    return exact.sort((a, b) => gtMolten(b) - gtMolten(a) || (b.recipeCount ?? 0) - (a.recipeCount ?? 0))[0];
  }
  const anyKind = results.filter((entry) => (entry.displayName ?? "").toLowerCase() === lower);
  return anyKind.sort((a, b) => (b.recipeCount ?? 0) - (a.recipeCount ?? 0))[0];
}

const wanted = collectNames();
console.log(`Resolving ${wanted.size} names against ${base} (${version})...`);
const map = {};
const unresolved = [];
const queue = [...wanted.entries()];
const WORKERS = 8;
await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    while (queue.length > 0) {
      const [name, kind] = queue.shift();
      const target = ALIASES[name] ?? name;
      try {
        const pinned = versionIdAliases[name];
        if (pinned) {
          const results = await search(pinned.query);
          const found = results.find((entry) => entry.kind === pinned.kind && entry.id === pinned.id);
          if (found) {
            map[name] = {
              kind: found.kind,
              id: found.id,
              displayName: found.displayName ?? name,
              iconPath: found.iconPath,
              dominantColor: found.dominantColor,
            };
          } else {
            unresolved.push(name);
          }
          continue;
        }
        const override = ID_OVERRIDES[name];
        const results = await search(override ? name.replace("Ench. ", "").replace("Block of ", "") : target);
        let found = override
          ? results.find((entry) => entry.kind === override.kind && entry.id === override.id)
          : pick(results, target, kind);
        // An alias names one pack's display name; another pack may show the resource under the
        // workbook's own name (2.8.1's bioethanol is "Ethanol", 2.9's "Bio Ethanol").
        if (!found && !override && target !== name) {
          found = pick(await search(name), name, kind);
        }
        if (found && STRICT_FLUID.has(name) && found.kind !== "fluid") {
          found = undefined;
        }
        if (found) {
          map[name] = {
            kind: found.kind,
            id: found.id,
            // Some names wear private-use glyph prefixes; strip them.
            displayName: (found.displayName ?? name).replace(/[-]/g, "").trim(),
            iconPath: found.iconPath,
            dominantColor: found.dominantColor,
          };
        } else {
          unresolved.push(name);
        }
      } catch (error) {
        unresolved.push(`${name} (error: ${error.message})`);
      }
    }
  }),
);

const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ datasetVersionId: version, resources: sorted }, null, 1) + "\n");
console.log(`Wrote ${outPath}: ${Object.keys(sorted).length} resolved.`);
if (unresolved.length > 0) {
  console.log(`UNRESOLVED (${unresolved.length}):`);
  for (const name of unresolved.sort()) {
    console.log("  - " + name);
  }
}
