import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { machineTableNames } from "./machine-table";
import { MACHINE_OVERRIDES } from "./version-overrides";
import { POWER_DATA_OVERRIDES } from "@/lib/power/planner-data";
import { powerSourcesFor } from "@/lib/power/registry";

/**
 * The GTNH 2.8.1 machine and power audit (docs/audits/2-8-1-machine-audit.md)
 * is what the 2.8.1 fix tasks are planned from, so every machine, power source,
 * module, data file and hand table the planner computes with must have a row,
 * and every row a verdict the plan can act on. A new table entry, power source,
 * module or data file fails here until it is audited. It also closes the
 * stage: every different and absent row is answered by an override, every
 * different row by a test named after it, and every row that is not plainly
 * the same carries its outcome.
 */

const ROOT = path.resolve(__dirname, "../../..");
const DOC = path.join(ROOT, "docs/audits/2-8-1-machine-audit.md");

const GROUPS = [
  "Shared rules",
  "Machine table",
  "Machine modules",
  "Machine data files",
  "Synthesized machines",
  "Pipeline tables",
  "Power sources",
  "Power data",
] as const;
type Group = (typeof GROUPS)[number];

const HEADER = ["Item", "Our code", "2.9 behaviour", "2.8.1 source", "Verdict", "Difference", "Data branch", "Outcome"];
const VERDICTS = new Set(["same", "different", "absent in 2.8.1", "not checkable"]);
const DATA_BRANCHES = new Set(["", "oracle export", "hand read", "jar hash + source diff", "dataset catalog"]);
/**
 * What a checked row's 2.8.1 source starts with, so a citation tucked after other words cannot
 * stand in for the evidence: `GT5U@5.09.51.476 gregtech/.../MTEFoo.java:123` (a line range
 * allowed); `each row under <group>` for a row that sums up a group; `GTNH 2.8.1 manifest:` where
 * the pack's mod list decides; or the repo file holding the 2.8.1 data or a separate check.
 */
const CITATION = /^[A-Za-z0-9-]+@[0-9A-Za-z.-]+ [\w/.$-]+\.java:\d+(-\d+)?/;
const AGGREGATE = /^each row under (.+)$/;
const MANIFEST = /^GTNH 2\.8\.1 manifest: /;
const REPO_FILE = /^((?:src\/lib\/(?:machines|power)\/data\/2\.8\.1\/[\w.-]+\.json)|(?:docs\/audits\/[\w.-]+\.md))\b/;

const SHARED_RULES = [
  "standard OC",
  "perfect OC",
  "laser OC",
  "heat OC",
  "multiblock sub-tick",
  "parallels before OC",
  "singleblock tier cap",
  "amperage OC",
  "wireless EU",
  "runtimeCalculation reading",
  "hatch power seeding",
  "steam litres",
];

const SYNTHESIZED = [
  "steam singleblocks",
  "Auto Workbench",
  "crop placeholder",
  "bee maths",
  "crop maths",
];

/** The hand-coded parts of machine-configs.mjs; the rest is tooltip parsing. */
const MACHINE_CONFIG_TABLES = [
  "heatingCoilTiers",
  "pipeCasingTiers",
  "itemPipeCasingTiers",
  "solenoidTiers",
  "pyrolyse oven coil",
  "oil cracker coil",
  "industrial coke oven coil",
  "industrial coke oven casing",
  "industrial coke oven slices",
];

interface Row {
  item: string;
  cells: string[];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseDoc(text: string): { order: string[]; rows: Map<string, Row[]>; numbered: string[] } {
  const order: string[] = [];
  const rows = new Map<string, Row[]>();
  const numbered: string[] = [];
  let group: string | undefined;
  let afterGroups = false;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      group = heading[1].trim();
      afterGroups = !(GROUPS as readonly string[]).includes(group);
      if (!afterGroups) {
        order.push(group);
        rows.set(group, []);
      }
      continue;
    }
    if (afterGroups) {
      const item = /^\d+\.\s+(.+)$/.exec(line);
      if (item) numbered.push(item[1]);
      continue;
    }
    if (!group || !line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells[0] === "Item" || /^-+$/.test(cells[0])) continue;
    rows.get(group)!.push({ item: cells[0], cells });
  }
  return { order, rows, numbered };
}

function machineModules(): string[] {
  return readdirSync(path.join(ROOT, "src/lib/machines"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

function dataFiles(): string[] {
  const files = [
    ...readdirSync(path.join(ROOT, "src/lib/machines/data")),
    ...readdirSync(path.join(ROOT, "src/lib/power/data")),
  ].filter((name) => name.endsWith(".json"));
  return [...files, "reference-coefficients.json"].sort();
}

function wikiStatsEntries(): string[] {
  const source = readFileSync(
    path.join(ROOT, "tools/dataset-pipeline/scripts/machine-wiki-stats.mjs"),
    "utf8",
  );
  const body = source.slice(source.indexOf("const ENTRIES = new Map(["));
  return [...body.matchAll(/^ {2}\[\n {4}"([^"]+)",/gm)].map((match) => match[1]);
}

function powerDataTables(): string[] {
  const data = JSON.parse(
    readFileSync(path.join(ROOT, "src/lib/power/data/power-planner-data.json"), "utf8"),
  ) as Record<string, unknown>;
  return Object.keys(data).filter((key) => key !== "source" && key !== "extractedAt");
}

const REQUIRED: Record<Group, () => string[]> = {
  "Shared rules": () => SHARED_RULES,
  "Machine table": () => machineTableNames(),
  "Machine modules": machineModules,
  "Machine data files": dataFiles,
  "Synthesized machines": () => SYNTHESIZED,
  "Pipeline tables": () => [
    ...wikiStatsEntries().map((entry) => `machine-wiki-stats.mjs: ${entry}`),
    ...MACHINE_CONFIG_TABLES.map((table) => `machine-configs.mjs: ${table}`),
    "sparge-byproducts.mjs: spargeExpectedLitres",
    "eec-drops.mjs: chance modifiers",
    "eec-drops.mjs: looting and player-only",
  ],
  // 2.9 has every source; 2.8.1 only leaves some out.
  "Power sources": () => [...new Set([...powerSourcesFor("2.9"), ...powerSourcesFor("2.8.1")].map((source) => source.id))],
  "Power data": () => powerDataTables().map((table) => `power-planner-data.json: ${table}`),
};

describe("2.8.1 machine audit coverage", () => {
  // Each reader parses a source file or directory; one that stops matching must fail, not pass vacuously.
  it("every required-item reader finds items", () => {
    expect(machineTableNames().length).toBeGreaterThan(0);
    expect(powerSourcesFor("2.9").length).toBeGreaterThan(0);
    expect(machineModules().length).toBeGreaterThan(0);
    expect(dataFiles().length).toBeGreaterThan(1);
    expect(wikiStatsEntries().length).toBeGreaterThan(0);
    expect(powerDataTables().length).toBeGreaterThan(0);
  });

  it("the audit doc exists", () => {
    expect(existsSync(DOC), `${DOC} is missing`).toBe(true);
  });

  const text = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
  const doc = parseDoc(text);

  it("opens with the title and the sources line", () => {
    expect(text.startsWith("# Machine and power audit: GTNH 2.8.1\n")).toBe(true);
    expect(text).toMatch(/^Sources: GT5-Unofficial 5\.09\.51\.476, .+\. 2\.9 reference: the code at [0-9a-f]{7,40}\.$/m);
  });

  it("has the groups in order", () => {
    expect(doc.order).toEqual([...GROUPS]);
  });

  it("uses the table header everywhere", () => {
    for (const group of GROUPS) {
      const section = text.split(`## ${group}\n`)[1]?.split("\n## ")[0] ?? "";
      const header = section.split("\n").find((line) => line.startsWith("| Item"));
      expect(header && splitRow(header), group).toEqual(HEADER);
    }
  });

  for (const group of GROUPS) {
    it(`${group}: every audited item has exactly one row`, () => {
      const items = (doc.rows.get(group) ?? []).map((row) => row.item);
      const missing = REQUIRED[group]().filter((name) => !items.includes(name));
      expect(missing, `${group} rows missing`).toEqual([]);
      const duplicates = items.filter((item, index) => items.indexOf(item) !== index);
      expect(duplicates, `${group} duplicate rows`).toEqual([]);
    });
  }

  it("every row is complete and its verdict valid", () => {
    const problems: string[] = [];
    for (const [group, rows] of doc.rows) {
      for (const { item, cells } of rows) {
        const where = `${group} / ${item}`;
        if (cells.length !== HEADER.length) {
          problems.push(`${where}: ${cells.length} cells`);
          continue;
        }
        const [, ours, behaviour, source, verdict, difference, branch] = cells;
        if (!ours || !behaviour) problems.push(`${where}: our code or 2.9 behaviour empty`);
        if (!source) problems.push(`${where}: no 2.8.1 source`);
        // A checked row names what decides it; a not checkable row names what is missing instead.
        if (verdict !== "not checkable") {
          const aggregate = AGGREGATE.exec(source);
          const file = REPO_FILE.exec(source);
          if (aggregate) {
            const summed = doc.rows.get(aggregate[1]);
            const expected = summed?.some((row) => row.cells[4] === "different") ? "different" : "same";
            if (!summed) problems.push(`${where}: no group "${aggregate[1]}"`);
            else if (verdict !== expected) problems.push(`${where}: sums up ${aggregate[1]}, so it is ${expected}`);
          } else if (file) {
            if (!existsSync(path.join(ROOT, file[1]))) problems.push(`${where}: ${file[1]} does not exist`);
          } else if (!CITATION.test(source) && !MANIFEST.test(source)) {
            problems.push(`${where}: 2.8.1 source does not start with "<Repo>@<tag> <path>:<line>" or another form`);
          }
        }
        if (verdict !== "same" && !cells[7]) problems.push(`${where}: ${verdict} needs an outcome`);
        if (!VERDICTS.has(verdict)) problems.push(`${where}: verdict "${verdict}"`);
        if ((verdict === "different" || verdict === "not checkable") && !difference) {
          problems.push(`${where}: ${verdict} needs a difference or reason`);
        }
        if (!DATA_BRANCHES.has(branch)) problems.push(`${where}: data branch "${branch}"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("ends with a numbered list of every different row", () => {
    const different = [...doc.rows.values()].flat().filter((row) => row.cells[4] === "different");
    expect(doc.numbered.length).toBe(different.length);
    for (const row of different) {
      expect(
        doc.numbered.some((entry) => entry.startsWith(`${row.item}:`)),
        `${row.item} is not in the closing list`,
      ).toBe(true);
    }
  });

  const auditRows = (group: Group) => doc.rows.get(group) ?? [];
  const differentRows = () => [...doc.rows.values()].flat().filter((row) => row.cells[4] === "different");

  it("machine-table.ts 2.8.1 overrides cover every Machine table row", () => {
    const overrides = MACHINE_OVERRIDES["2.8.1"] ?? {};
    const problems: string[] = [];
    for (const row of auditRows("Machine table")) {
      // Every 2.8.1 difference is an override entry; every machine 2.8.1 lacks is a null one,
      // so a name that still reaches the table never gets the 2.9 numbers.
      if (row.cells[4] === "different" && !overrides[row.item]) problems.push(`${row.item}: no 2.8.1 override`);
      if (row.cells[4] === "absent in 2.8.1" && overrides[row.item] !== null) problems.push(`${row.item}: not null on 2.8.1`);
    }
    expect(problems).toEqual([]);
  });

  it("power-planner-data.json 2.8.1 overrides cover every Power data row", () => {
    const overrides = POWER_DATA_OVERRIDES["2.8.1"] ?? {};
    const tables = auditRows("Power data")
      .filter((row) => row.cells[4] === "different")
      .map((row) => row.item.replace("power-planner-data.json: ", ""));
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((table) => !(table in overrides))).toEqual([]);
  });

  it("version-overrides.ts 2.8.1 is the only version with machine overrides", () => {
    // 2.9 reads the base table; a 2.9 entry would be a second copy of it.
    expect(Object.keys(MACHINE_OVERRIDES)).toEqual(["2.8.1"]);
    expect(Object.keys(MACHINE_OVERRIDES["2.8.1"] ?? {}).length).toBeGreaterThan(0);
  });

  it("every different row has a test named after it", () => {
    const titles = collectTestTitles(["src", "tools"]);
    const missing = differentRows()
      .filter((row) => !titles.some((title) => title.matches(row.item)))
      .map((row) => row.item);
    expect(missing).toEqual([]);
  });
});

interface TestTitle {
  matches(item: string): boolean;
}

/**
 * The test( / it( titles of every *.test.ts, *.test.tsx and *.test.mjs file under the roots
 * (skip, todo and fails are not tests that pin anything, so they are left out). A template
 * title counts for an item when its text before the first placeholder starts the item and the
 * item is spelled out, quoted, in the lines just above it: the table its loop fills the
 * placeholder from. A version placeholder reads as a version.
 */
function collectTestTitles(roots: string[]): TestTitle[] {
  const titles: TestTitle[] = [];
  const TITLE = /\b(?:it|test)(?:\.(?:only|concurrent))?\(\s*(["'`])((?:\\.|(?!\1).)*?)\1/gs;
  const LOOP_LINES = 40;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(full);
        continue;
      }
      if (!/\.test\.(?:ts|tsx|mjs)$/.test(entry.name) || entry.name.includes(".local.")) continue;
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(TITLE)) {
        // A version placeholder is not an item name: read it as a version.
        const title = match[1] === "`" ? match[2].replace(/\$\{(?:gameVersion|version)\}/g, "2.9") : match[2];
        const placeholder = match[1] === "`" ? title.indexOf("${") : -1;
        if (placeholder < 0) {
          titles.push({ matches: (item) => title.startsWith(item) });
        } else {
          const prefix = title.slice(0, placeholder);
          const above = source.slice(0, match.index).split("\n").slice(-LOOP_LINES).join("\n");
          titles.push({
            matches: (item) =>
              item.startsWith(prefix) && (above.includes(`"${item}"`) || above.includes(`'${item}'`)),
          });
        }
      }
    }
  };
  for (const root of roots) walk(path.join(ROOT, root));
  return titles;
}
