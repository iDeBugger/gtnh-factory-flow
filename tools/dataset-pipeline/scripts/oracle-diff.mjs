#!/usr/bin/env node
// Diffs two raw oracle export directories (each holding oracle-export.json and
// rendered-icons/). Run: node tools/dataset-pipeline/scripts/oracle-diff.mjs <baseline raw-export>
// <candidate raw-export>, both of one pack (a run's work/raw-export).
//
// - oracle-export.json, domain by domain, as a multiset of records: a GT recipe map's
//   recipes, a domain's array elements, an object's entries. Record order is ignored, and so
//   are the per-run fields (generatedAt, durationMillis) and the exporter's raw recipe ids.
//   A record that differs is matched again in two looser passes, each counted on its own:
//     order: equal once every list inside it is sorted. The game fills oredict lists,
//       aspect lists, bee products and crop drops from hash maps, so their order changes
//       between starts; the normalizer sorts slots before it hashes a recipe.
//     names: equal once display names are dropped and icon names cut to their hash. A few
//       items roll their display name on every start (Lava/Cake Glove, the QED, Quantum
//       Bread), and an icon file is named after the display name.
//   What is left is either a known game-rolled record (GAME_ROLLED) or unexpected.
// - The rendered-icon set: the file names in rendered-icons/ and the keys of
//   icon-colors.json. A name that differs only before its hash is a rolled display name.
//   Pixels are not compared: about 400 time-driven icons differ between exports.
// - When a dataset/recipes.json sits beside each raw export (../dataset), its recipe ids.
//
// Exit 0 when nothing is unexpected, 1 otherwise.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import v8 from "node:v8";
import { spawnSync } from "node:child_process";

// The export is about 430 MB of JSON and both sides are held at once.
if (v8.getHeapStatistics().heap_size_limit < 10 * 1024 ** 3 && !process.env.ORACLE_DIFF_CHILD) {
  const r = spawnSync(process.execPath, ["--max-old-space-size=12288", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, ORACLE_DIFF_CHILD: "1" },
  });
  process.exit(r.status ?? 1);
}

const [baseDir, candDir] = process.argv.slice(2);
if (!baseDir || !candDir) {
  console.error("usage: node oracle-diff.mjs <baseline raw-export dir> <candidate raw-export dir>");
  process.exit(2);
}

// A 2.8.1 export still names GT++ maps gtpp.recipe.*; rules seen only there apply only there.
// Scanned in chunks: the export is close to the longest string V8 allows.
const IS_281 = (() => {
  const needle = Buffer.from('"id":"gtpp.recipe.');
  const fd = fs.openSync(path.join(baseDir, "oracle-export.json"), "r");
  const chunk = Buffer.alloc(16 * 1024 * 1024);
  let carry = Buffer.alloc(0);
  try {
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; ) {
      const view = Buffer.concat([carry, chunk.subarray(0, n)]);
      if (view.includes(needle)) return true;
      carry = view.subarray(Math.max(0, view.length - needle.length));
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
})();
const on281 = (test) => (r) => IS_281 && (test ? test(r) : true);
// The 2.8.1 ceilings come from two pairs of 2.8.1 exports with the same jar family.

// Every rule carries a ceiling: the most pairs (or records per side) one diff may put
// under it, about twice the worst seen across the control diffs of four exports of one pack
// with two jars. Past the ceiling, or with unequal sides for a whole-record
// rule, the records count as unexpected, so a real loss or gain cannot hide under a rule.

// Whole records the game rolls when it starts. A rolled record is replaced, never lost, so
// both sides must hold the same number.
const GAME_ROLLED = [
  { label: "Crop Breeder", group: "gregtech/cropsnh.recipes.cropBreeder", ceiling: 40 },
  // The fake assembly line map shows one ore picked from an oredict list per input.
  { label: "assembly line ore picks", group: "gregtech/gt.recipe.fakeAssemblylineProcess", ceiling: 5 },
  {
    label: "Gadomancy aspects",
    group: "thaumcraft/recipes",
    test: (r) => r.type === "infusion" && /^GADOMANCY\./.test(r.research ?? ""),
    ceiling: 5,
  },
  // 2.8.1: the emerald nugget an oredict list resolves to (MagicBees' shard or Forbidden
  // Magic's fragment) is picked in hash order, in the recipes that make or take one.
  ...["gt.recipe.centrifuge", "gt.recipe.macerator", "gtpp.recipe.multicentrifuge"].map((map) => ({
    label: "emerald nugget picks (2.8.1)",
    group: `gregtech/${map}`,
    test: on281((r) => /"magicbees:beenugget@6"|"forbiddenmagic:fmresource"/.test(JSON.stringify(r))),
    ceiling: 4,
  })),
  // 2.8.1: the coloured lens oredict lists (craftingLens<colour>) come out with other members
  // between starts of the same pack.
  {
    label: "lens oredict lists (2.8.1)",
    group: "oreDictionary/entries",
    test: on281((r) => Array.isArray(r) && /^craftingLens/.test(String(r[0]))),
    ceiling: 12,
  },
];
// Records the game fills partly at random: a pair counts as rolled when it is equal once
// these top-level fields are dropped (after the order and names passes), so the rest of the
// record must still match. A test returning false keeps a record out of the rule.
const topAspect = (r) => Math.max(...(r.aspects ?? []).map((a) => a.amount ?? 0));
const GAME_ROLLED_FIELDS = [
  // An alchemical furnace yields the aspect with the largest amount. Between aspects tied
  // for it the pick follows hash-map order. The aspects themselves must be the same.
  {
    label: "essentia smelting tie-break",
    group: "thaumcraft/recipes",
    // The output must be one of the tied aspects, by tag as well as amount.
    test: (r) =>
      r.type === "essentiaSmelting" &&
      r.output?.amount === topAspect(r) &&
      (r.aspects ?? []).some((a) => a.tag === r.output.tag && a.amount === r.output.amount),
    fields: ["output"],
    ceiling: 130,
  },
  // Generated item aspects depend on the order recipes are walked in, so an item without
  // registered aspects can get others, and its smelting time follows the aspect total.
  {
    label: "Thaumcraft generated item aspects (essentia smelting)",
    group: "thaumcraft/recipes",
    test: (r) => r.type === "essentiaSmelting",
    fields: ["output", "outputs", "aspects", "durationTicks", "variants"],
    ceiling: 110,
  },
  // Soil lists come from a hash set of blocks and are cut to a fixed length.
  { label: "CropsNH soil lists", group: "cropsNhCrops/crops", fields: ["soils"], ceiling: 140 },
  // The crop manager simulates harvests with the game's random source.
  {
    label: "IC2 simulated crop yields",
    group: "ic2Crops/crops",
    test: () => !IS_281,
    fields: ["variants", "drops", "durationTicks"],
    ceiling: 5,
  },
  // Slime-like mobs spawn at a random size, which sets their health; a Mandrake rolls its
  // drops on spawn. One mob is one record, so each rule pairs at most once.
  {
    label: "mob spawn rolls",
    group: "mobDrops/mobs",
    test: (r) => r.key === "BiomesOPlenty.Glob" || r.key === "Thaumcraft.ThaumSlime",
    fields: ["maxEntityHealth"],
    ceiling: 2,
  },
  { label: "mob spawn rolls", group: "mobDrops/mobs", test: (r) => r.key === "witchery.mandrake", fields: ["drops"], ceiling: 1 },
  // Witchery's Mindrake is a Mandrake variant: its seed drop rolls the same way (its looting flag here).
  { label: "mob spawn rolls", group: "mobDrops/mobs", test: (r) => r.key === "witchery.mindrake", fields: ["drops"], ceiling: 1 },
  // 2.8.1: Tinkers' blue slime spawns at a random size like the Glob; a GT++ Staballoy
  // Construct rolls its plate drop chance on spawn.
  {
    label: "mob spawn rolls",
    group: "mobDrops/mobs",
    test: on281((r) => r.key === "TConstruct.EdibleSlime"),
    fields: ["maxEntityHealth"],
    ceiling: 1,
  },
  {
    label: "mob spawn rolls",
    group: "mobDrops/mobs",
    test: on281((r) => r.key === "miscutils.constructStaballoy"),
    fields: ["drops"],
    ceiling: 1,
  },
  // 2.8.1: crop yields move far more between exports than on 2.9 (28 and 32 pairs): more of
  // its crops roll their own random source. The 2.9 rule above keeps its ceiling of 5.
  {
    label: "IC2 simulated crop yields (2.8.1)",
    group: "ic2Crops/crops",
    test: on281(),
    fields: ["variants", "drops", "durationTicks"],
    ceiling: 70,
  },
  // The ore-dictionary adapter counts the oredict entries, so it follows the lens lists.
  {
    label: "ore-dictionary adapter count (2.8.1)",
    group: "(top)/adapters",
    test: on281((r) => r.id === "ore-dictionary"),
    fields: ["recipeCount"],
    ceiling: 1,
  },
];
// Pairs that differ only in display names (all domains together).
const NAMES_CEILING = 20;
// Dataset recipe ids of the same records (the normalizer writes map ids with dashes). Ids
// change with content, so a rolled recipe shows as one id gone and one new.
const ROLLED_DATASET_IDS = [
  { label: "Crop Breeder", test: (id) => id.includes(":cropsnh-recipes-cropbreeder:"), ceiling: 40 },
  { label: "assembly line ore picks", test: (id) => id.includes(":gt-recipe-fakeassemblylineprocess:"), ceiling: 5 },
  { label: "Gadomancy aspects", test: (id, line) => id.includes(":thaumcraft:infusion:") && /GADOMANCY\./.test(line), ceiling: 5 },
  { label: "essentia smelting", test: (id) => id.includes(":thaumcraft:essentiasmelting:"), ceiling: 110 },
  {
    label: "emerald nugget picks (2.8.1)",
    test: (id, line) =>
      IS_281 &&
      /:gt-recipe-(centrifuge|macerator|multicentrifuge):/.test(id) &&
      /magicbees:beenugget@6|forbiddenmagic:fmresource/.test(line),
    ceiling: 4,
  },
];

const VOLATILE = new Set(["generatedAt", "durationMillis"]);
// The exporter names a GT, crafting, smelting or thaumcraft recipe by a hash of its list
// index and, for GT, the recipe object's toString (an identity hash), so that id changes on
// every run. The normalizer never reads it (ids come from content), so it is left out.
const RAW_ID_DOMAINS = new Set(["crafting", "smelting", "thaumcraft"]);
const withoutRawId = ({ id: _id, ...rest }) => rest;
const ICON_HASH = /-([0-9a-f]{12})\.png$/;

// mode: 0 exact, 1 lists sorted, 2 lists sorted and names dropped.
function canon(v, mode = 0) {
  if (Array.isArray(v)) {
    const parts = v.map((e) => canon(e, mode));
    if (mode > 0) parts.sort();
    return `[${parts.join(",")}]`;
  }
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => !VOLATILE.has(k) && !(mode === 2 && k === "displayName"))
      .sort()
      .map((k) => {
        let x = v[k];
        if (mode === 2 && k === "icon" && typeof x === "string") x = x.match(ICON_HASH)?.[1] ?? x;
        return `${JSON.stringify(k)}:${canon(x, mode)}`;
      })
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function records(exp) {
  const groups = new Map();
  const add = (g, obj) => {
    let m = groups.get(g);
    if (!m) groups.set(g, (m = new Map()));
    const key = canon(obj);
    const e = m.get(key);
    if (e) e.n += 1;
    else m.set(key, { n: 1, obj });
  };
  const { domains, ...top } = exp;
  // A top-level list (the adapters) is a record per element, so a rule can name one.
  for (const [k, v] of Object.entries(top)) {
    if (VOLATILE.has(k)) continue;
    if (Array.isArray(v)) for (const e of v) add(`(top)/${k}`, e);
    else add(`(top)/${k}`, v);
  }
  for (const d of domains) {
    for (const [k, v] of Object.entries(d)) {
      if (k === "id") continue;
      if (d.id === "gregtech" && k === "recipeMaps") {
        for (const map of v) {
          const { recipes, ...meta } = map;
          add(`gregtech/${map.id}#meta`, meta);
          for (const r of recipes ?? []) add(`gregtech/${map.id}`, withoutRawId(r));
        }
      } else if (Array.isArray(v)) {
        const strip = RAW_ID_DOMAINS.has(d.id) && k === "recipes";
        for (const e of v) add(`${d.id}/${k}`, strip ? withoutRawId(e) : e);
      } else if (v && typeof v === "object") {
        for (const [ek, ev] of Object.entries(v)) add(`${d.id}/${k}`, [ek, ev]);
      } else add(`${d.id}/${k}`, v);
    }
  }
  return groups;
}

// Removes from xs and ys every pair equal under key; returns the pairs.
function matchOff(xs, ys, key) {
  const pool = new Map();
  for (const y of ys) {
    const k = key(y);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(y);
  }
  const used = new Set();
  const left = [];
  const pairs = [];
  for (const x of xs) {
    const list = pool.get(key(x));
    if (list?.length) {
      const y = list.pop();
      used.add(y);
      pairs.push([x, y]);
    } else left.push(x);
  }
  xs.splice(0, xs.length, ...left);
  const rest = ys.filter((y) => !used.has(y));
  ys.splice(0, ys.length, ...rest);
  return pairs;
}

function rolledRule(group, obj) {
  return GAME_ROLLED.find((rule) => rule.group === group && (!rule.test || rule.test(obj))) ?? null;
}

// Display names (and icon names, which follow them) found in one record of a pair more
// often than in the other. Counted, not set-compared, so a name moving between slots shows.
function nameChanges(x, y) {
  const tally = (v, out = new Map()) => {
    if (Array.isArray(v)) v.forEach((e) => tally(e, out));
    else if (v && typeof v === "object") {
      for (const [k, e] of Object.entries(v)) {
        if ((k === "displayName" || k === "icon") && typeof e === "string") out.set(e, (out.get(e) ?? 0) + 1);
        else tally(e, out);
      }
    }
    return out;
  };
  const tx = tally(x);
  const ty = tally(y);
  const more = (p, q) =>
    [...p]
      .filter(([n, c]) => c > (q.get(n) ?? 0))
      .map(([n]) => n)
      .sort();
  return `${more(tx, ty).join(", ")} -> ${more(ty, tx).join(", ")}`;
}

const load = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "oracle-export.json"), "utf8"));

let unexpected = 0;
const summary = { domains: {}, rolled: {}, nameChanges: {}, icons: {}, recipeIds: null };
const overflows = [];

{
  const a = records(load(baseDir));
  const b = records(load(candDir));
  const samples = [];
  for (const g of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const ma = a.get(g) ?? new Map();
    const mb = b.get(g) ?? new Map();
    const dom = g.split("/")[0];
    const ds = (summary.domains[dom] ??= {
      records: 0, exactPairs: 0, orderOnly: 0, namesOnly: 0, rolled: 0, onlyBaseline: 0, onlyCandidate: 0, groups: {},
    });
    const onlyA = [];
    const onlyB = [];
    for (const [k, { n, obj }] of ma) {
      ds.records += n;
      const d = n - (mb.get(k)?.n ?? 0);
      ds.exactPairs += Math.min(n, mb.get(k)?.n ?? 0);
      for (let i = 0; i < d; i++) onlyA.push(obj);
    }
    for (const [k, { n, obj }] of mb) {
      const d = n - (ma.get(k)?.n ?? 0);
      for (let i = 0; i < d; i++) onlyB.push(obj);
    }
    if (!onlyA.length && !onlyB.length) continue;
    const gs = { orderOnly: 0, namesOnly: 0, rolled: 0, onlyBaseline: 0, onlyCandidate: 0 };
    gs.orderOnly = matchOff(onlyA, onlyB, (o) => canon(o, 1)).length;
    const namePairs = matchOff(onlyA, onlyB, (o) => canon(o, 2));
    gs.namesOnly = namePairs.length;
    for (const [x, y] of namePairs) {
      const k = `${g}: ${nameChanges(x, y)}`;
      summary.nameChanges[k] = (summary.nameChanges[k] ?? 0) + 1;
    }
    const flag = (count, sample) => {
      gs.unexpectedByRule = (gs.unexpectedByRule ?? 0) + count;
      unexpected += count;
      if (samples.length < 20) samples.push(sample);
    };
    for (const rule of GAME_ROLLED_FIELDS) {
      if (rule.group !== g) continue;
      const strip = (o) => {
        if (rule.test && !rule.test(o)) return `\u0000${canon(o)}`;
        const copy = { ...o };
        for (const f of rule.fields) delete copy[f];
        return canon(copy, 2);
      };
      // Records the rule does not cover get keys no other record shares, so they stay.
      const pairs = matchOff(onlyA, onlyB, strip).length;
      if (!pairs) continue;
      // Rules sharing a label are reported on one line, each rule with its own ceiling (the
      // one it is enforced against), never their sum.
      const r = (summary.rolled[rule.label] ??= { pairs: 0, ceilings: [] });
      r.pairs += pairs;
      r.ceilings.push(`${pairs}/${rule.ceiling}`);
      if (pairs > rule.ceiling) {
        overflows.push(`${rule.label}: ${pairs} pairs, ceiling ${rule.ceiling}`);
        flag(2 * pairs, `${g}: ${pairs} pairs under "${rule.label}", past its ceiling ${rule.ceiling}`);
      } else gs.rolled += 2 * pairs;
    }
    const byRule = new Map();
    for (const [side, list] of [["baseline", onlyA], ["candidate", onlyB]]) {
      for (const obj of list) {
        const rule = rolledRule(g, obj);
        if (rule) {
          const c = byRule.get(rule) ?? { onlyBaseline: 0, onlyCandidate: 0 };
          c[side === "baseline" ? "onlyBaseline" : "onlyCandidate"] += 1;
          byRule.set(rule, c);
          continue;
        }
        gs[side === "baseline" ? "onlyBaseline" : "onlyCandidate"] += 1;
        unexpected += 1;
        if (samples.length < 20) samples.push(`${side} ${g}: ${canon(obj).slice(0, 400)}`);
      }
    }
    for (const [rule, c] of byRule) {
      const r = (summary.rolled[rule.label] ??= { onlyBaseline: 0, onlyCandidate: 0, ceiling: rule.ceiling });
      r.onlyBaseline += c.onlyBaseline;
      r.onlyCandidate += c.onlyCandidate;
      const n = c.onlyBaseline + c.onlyCandidate;
      if (c.onlyBaseline !== c.onlyCandidate || Math.max(c.onlyBaseline, c.onlyCandidate) > rule.ceiling) {
        const why = `${rule.label}: ${c.onlyBaseline} only in baseline, ${c.onlyCandidate} only in candidate (must be equal, at most ${rule.ceiling})`;
        overflows.push(why);
        flag(n, `${g}: ${why}`);
      } else gs.rolled += n;
    }
    for (const k of ["orderOnly", "namesOnly", "rolled", "onlyBaseline", "onlyCandidate"]) ds[k] += gs[k];
    ds.unexpectedByRule = (ds.unexpectedByRule ?? 0) + (gs.unexpectedByRule ?? 0);
    ds.groups[g] = gs;
  }
  console.log("oracle-export.json by domain:");
  console.log("  records in baseline; pairs equal once lists are sorted (order) / once names are dropped (names);");
  console.log("  known game-rolled records; unexpected records only in baseline / only in candidate");
  for (const [dom, ds] of Object.entries(summary.domains)) {
    const state =
      ds.onlyBaseline || ds.onlyCandidate || ds.unexpectedByRule
        ? "DIFFERS"
        : ds.orderOnly || ds.namesOnly || ds.rolled
          ? "same apart from known run-to-run noise"
          : "identical";
    console.log(
      `  ${dom}: ${ds.records}; order ${ds.orderOnly}, names ${ds.namesOnly}; rolled ${ds.rolled}; unexpected ${ds.onlyBaseline} / ${ds.onlyCandidate}${ds.unexpectedByRule ? `, past a rule ${ds.unexpectedByRule}` : ""}: ${state}`,
    );
    for (const [g, gs] of Object.entries(ds.groups)) {
      if (gs.namesOnly || gs.rolled || gs.onlyBaseline || gs.onlyCandidate || gs.unexpectedByRule) {
        console.log(
          `    ${g}: order ${gs.orderOnly}, names ${gs.namesOnly}, rolled ${gs.rolled}, unexpected ${gs.onlyBaseline} / ${gs.onlyCandidate}${gs.unexpectedByRule ? `, past a rule ${gs.unexpectedByRule}` : ""}`,
        );
      }
    }
  }
  const namePairs = Object.values(summary.nameChanges).reduce((x, y) => x + y, 0);
  console.log(`records that differ only in display names (old -> new), ${namePairs} pairs, ceiling ${NAMES_CEILING}:`);
  for (const [k, n] of Object.entries(summary.nameChanges)) console.log(`  ${n} x ${k}`);
  if (namePairs > NAMES_CEILING) {
    overflows.push(`display names: ${namePairs} pairs, ceiling ${NAMES_CEILING}`);
    unexpected += 2 * namePairs;
  }
  console.log("known game-rolled records (pairs for a field rule; only in baseline / only in candidate for a whole-record rule):");
  for (const [label, r] of Object.entries(summary.rolled)) {
    const counts = r.pairs !== undefined ? `${r.pairs} pairs` : `${r.onlyBaseline} / ${r.onlyCandidate}`;
    const ceiling = r.ceilings ? `per rule pairs/ceiling ${r.ceilings.join(", ")}` : `ceiling ${r.ceiling}`;
    console.log(`  ${label}: ${counts}, ${ceiling}`);
  }
  if (samples.length) {
    console.log("first unexpected differences:");
    for (const s of samples) console.log(`  ${s}`);
  }
}

// The rendered-icon set.
{
  const names = (dir) =>
    new Set(fs.readdirSync(path.join(dir, "rendered-icons")).filter((f) => f !== "icon-colors.json"));
  const colorKeys = (dir) => {
    const f = path.join(dir, "rendered-icons", "icon-colors.json");
    return fs.existsSync(f) ? new Set(Object.keys(JSON.parse(fs.readFileSync(f, "utf8")))) : null;
  };
  const report = (label, x, y) => {
    const onlyA = [...x].filter((e) => !y.has(e)).sort();
    const onlyB = [...y].filter((e) => !x.has(e)).sort();
    const renamedPairs = matchOff(onlyA, onlyB, (n) => n.match(ICON_HASH)?.[1] ?? n);
    const renamed = renamedPairs.length;
    summary.icons[label] = {
      baseline: x.size, candidate: y.size, renamedByRolledName: renamed, onlyBaseline: onlyA.length, onlyCandidate: onlyB.length,
    };
    unexpected += onlyA.length + onlyB.length;
    const state = onlyA.length || onlyB.length ? "DIFFERS" : renamed ? "same apart from rolled display names" : "identical";
    console.log(
      `${label}: ${x.size} vs ${y.size}; renamed by a rolled display name ${renamed}; unexpected only baseline ${onlyA.length}, only candidate ${onlyB.length}: ${state}`,
    );
    for (const [x, y] of renamedPairs) console.log(`  renamed: ${x} -> ${y}`);
    for (const e of onlyA.slice(0, 10)) console.log(`  only baseline: ${e}`);
    for (const e of onlyB.slice(0, 10)) console.log(`  only candidate: ${e}`);
  };
  report("rendered-icons file names", names(baseDir), names(candDir));
  const ca = colorKeys(baseDir);
  const cb = colorKeys(candDir);
  if (ca && cb) report("icon-colors.json keys", ca, cb);
  else {
    console.log(`icon-colors.json: missing in ${ca ? "candidate" : cb ? "baseline" : "both"}`);
    if (ca || cb) unexpected += 1;
  }
}

// Recipe ids in the datasets beside the raw exports. Ids come from recipe content, so a
// game-rolled recipe shows as one id gone and one new: per rolled class both sides must
// hold the same number, at most the class ceiling. recipes.json is past the longest string
// Node reads whole, so it is streamed: dataset-json-writer puts every recipe on its own line
// under "recipes".
{
  const datasetOf = (dir) => path.join(dir, "..", "dataset", "recipes.json");
  const ids = async (dir) => {
    // id -> the rolled class it belongs to, or null.
    const out = new Map();
    let inRecipes = false;
    const rl = readline.createInterface({ input: fs.createReadStream(datasetOf(dir)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.startsWith('  "')) {
        inRecipes = line.startsWith('  "recipes": [');
        continue;
      }
      if (!inRecipes || !line.startsWith("    {")) continue;
      const { id } = JSON.parse(line.trim().replace(/,$/, ""));
      out.set(id, ROLLED_DATASET_IDS.find((c) => c.test(id, line)) ?? null);
    }
    return out;
  };
  if (fs.existsSync(datasetOf(baseDir)) && fs.existsSync(datasetOf(candDir))) {
    const a = await ids(baseDir);
    const b = await ids(candDir);
    const onlyA = [...a.keys()].filter((id) => !b.has(id));
    const onlyB = [...b.keys()].filter((id) => !a.has(id));
    const tally = (list, m) => {
      const by = new Map();
      const other = [];
      for (const id of list) {
        const c = m.get(id);
        if (c) by.set(c, (by.get(c) ?? 0) + 1);
        else other.push(id);
      }
      return { by, other };
    };
    const ta = tally(onlyA, a);
    const tb = tally(onlyB, b);
    let unexpectedIds = ta.other.length + tb.other.length;
    const classes = {};
    for (const c of ROLLED_DATASET_IDS) {
      const na = ta.by.get(c) ?? 0;
      const nb = tb.by.get(c) ?? 0;
      const ok = na === nb && na <= c.ceiling;
      classes[c.label] = { onlyBaseline: na, onlyCandidate: nb, ceiling: c.ceiling, ok };
      if (!ok) {
        unexpectedIds += na + nb;
        overflows.push(`dataset ids, ${c.label}: ${na} / ${nb} (must be equal, at most ${c.ceiling})`);
      }
    }
    summary.recipeIds = {
      baseline: a.size,
      candidate: b.size,
      onlyBaseline: onlyA.length,
      onlyCandidate: onlyB.length,
      classes,
      outsideOnlyBaseline: ta.other.length,
      outsideOnlyCandidate: tb.other.length,
      unexpected: unexpectedIds,
    };
    unexpected += unexpectedIds;
    console.log(
      `dataset recipe ids: ${a.size} vs ${b.size}; only baseline ${onlyA.length} (${ta.other.length} outside the rolled classes), only candidate ${onlyB.length} (${tb.other.length} outside)`,
    );
    for (const [label, c] of Object.entries(classes)) {
      console.log(`  ${label}: ${c.onlyBaseline} / ${c.onlyCandidate}, ceiling ${c.ceiling}${c.ok ? "" : ": PAST THE RULE"}`);
    }
    for (const id of ta.other.slice(0, 10)) console.log(`  only baseline: ${id}`);
    for (const id of tb.other.slice(0, 10)) console.log(`  only candidate: ${id}`);
  } else console.log("dataset recipe ids: no dataset/recipes.json beside both raw exports; skipped");
}

if (overflows.length) {
  console.log("rules overrun (counted as unexpected):");
  for (const o of overflows) console.log(`  ${o}`);
}
console.log(JSON.stringify({ unexpected, ...summary }));
process.exit(unexpected ? 1 : 0);
