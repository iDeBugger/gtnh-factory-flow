import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The layers, held by the import graph (AGENTS.md "Layers"). Every import in
 * src/ and tools/ is read with `ts.preProcessFile`; a layer rule below may be
 * broken only by an edge `architecture-allowlist.json` names, and that list
 * may only shrink: a new break fails, and a fixed edge still listed fails too.
 * Tests, `__fixtures__/`, `test-support/` and `src/app/dev/**` are exempt.
 *
 * `ARCH_DUMP=1 npx vitest run src/architecture.test.ts` rewrites the
 * allowlist from the graph as it is. Use it only to drop fixed entries.
 */

const ROOT = path.resolve(__dirname, "..");
const ALLOWLIST_FILE = path.join(ROOT, "src/architecture-allowlist.json");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", "scratch", "dist-live", "dist-db"]);
const NODE_BUILTINS = new Set(builtinModules);

interface Edge {
  from: string;
  /** A repository path, or `pkg:<specifier>` for a package or Node built-in. */
  to: string;
  typeOnly: boolean;
}

interface SourceFile {
  path: string;
  text: string;
  isClientEntry: boolean;
  edges: Edge[];
}

interface AllowedEdge {
  from: string;
  to: string;
  rule: string;
}

interface Allowlist {
  edges: AllowedEdge[];
  queriesInApp: string[];
}

function walk(directory: string, into: string[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        walk(full, into);
      }
    } else if (
      SOURCE_EXTENSIONS.includes(path.extname(entry.name)) &&
      !entry.name.endsWith(".d.ts")
    ) {
      into.push(full);
    }
  }
}

function resolveSpecifier(fromFile: string, specifier: string): string {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(ROOT, "src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return `pkg:${specifier}`;
  }
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => base + extension),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  if (/\.m?js$/.test(base)) {
    candidates.push(base.replace(/\.m?js$/, ".ts"), base.replace(/\.m?js$/, ".mts"));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(ROOT, candidate).split(path.sep).join("/");
    }
  }
  return `unresolved:${path.relative(ROOT, base)}`;
}

/**
 * Whether the import or export statement around `position` brings in types
 * only: `import type`, `export type`, or braces whose every name is `type`.
 * `preProcessFile` gives the specifier's place, so the statement is read back
 * from its nearest `import` or `export` keyword.
 */
function isTypeOnlyAt(text: string, position: number): boolean {
  const before = text.slice(Math.max(0, position - 4000), position);
  const keyword = [...before.matchAll(/\b(import|export)\b/g)].at(-1);
  if (!keyword || keyword.index === undefined) {
    return false;
  }
  const statement = before.slice(keyword.index);
  if (/^(import|export)\s+type\b/.test(statement)) {
    return true;
  }
  const named = /^import\s*\{([^}]*)\}\s*from\s*["']?$/.exec(statement.trimEnd());
  if (!named) {
    return false;
  }
  const names = named[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith("type "));
}

function isClientEntry(file: string, text: string): boolean {
  if (/\.worker\.tsx?$/.test(file)) {
    return true;
  }
  const preProcessed = text.replace(/^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*/, "");
  return /^\s*["']use client["']/.test(preProcessed);
}

function readGraph(): Map<string, SourceFile> {
  const absolute: string[] = [];
  walk(path.join(ROOT, "src"), absolute);
  walk(path.join(ROOT, "tools"), absolute);
  const graph = new Map<string, SourceFile>();
  for (const file of absolute) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    const info = ts.preProcessFile(text, true, true);
    const seen = new Map<string, Edge>();
    for (const imported of info.importedFiles) {
      const to = resolveSpecifier(file, imported.fileName);
      const typeOnly = isTypeOnlyAt(text, imported.pos);
      const known = seen.get(to);
      if (known) {
        known.typeOnly &&= typeOnly;
      } else {
        seen.set(to, { from: relative, to, typeOnly });
      }
    }
    graph.set(relative, {
      path: relative,
      text,
      isClientEntry: isClientEntry(relative, text),
      edges: [...seen.values()],
    });
  }
  return graph;
}

function isExempt(file: string): boolean {
  return (
    /\.(test|local\.test)\.(m?[tj]sx?)$/.test(file) ||
    file.includes("/__fixtures__/") ||
    file.includes("/test-support/") ||
    file.startsWith("src/app/dev/")
  );
}

const packageName = (to: string): string | undefined =>
  to.startsWith("pkg:") ? to.slice(4) : undefined;

const isDomain = (file: string): boolean =>
  /^src\/lib\/(model|machines|power|solver|search|board)\//.test(file) &&
  !/\.worker\.tsx?$/.test(file);

const isFeatureTypes = (file: string): boolean => /^src\/lib\/[^/]+\/types\.ts$/.test(file);

/** Request and response shapes and limits both sides import. */
const isContract = (file: string): boolean =>
  !isDomain(file) &&
  (isFeatureTypes(file) ||
    file === "src/lib/library/sync-types.ts" ||
    file === "src/lib/datasets/resolve-recipes-limits.ts" ||
    /^src\/lib\/live\/(ops|protocol|validate)\.ts$/.test(file));

const isServer = (file: string): boolean => file.startsWith("src/lib/server/");

const isRouteHandler = (file: string): boolean =>
  /^src\/app\/.*\/route\.tsx?$/.test(file) || file === "src/app/sitemap.ts";

const isUiOrStore = (file: string): boolean => /^src\/(components|store)\//.test(file);

/**
 * What only repositories may hold: the database client and its SQL. Until the
 * split, `community.ts` is where the client lives.
 */
const isDatabaseLayer = (file: string): boolean =>
  /^src\/lib\/server\/(db|repos)\//.test(file) || file === "src/lib/server/community.ts";

/** Packages the domain and the contracts never load: they stay pure. */
function isImpurePackage(name: string): boolean {
  return (
    name.startsWith("node:") ||
    NODE_BUILTINS.has(name) ||
    /^(react|react-dom|zustand|ws|pg|kysely|next)(\/|$)/.test(name) ||
    /^(@xyflow|@supabase)\//.test(name)
  );
}

/** The places in lib/server the live service may use. */
const isLiveServerTarget = (file: string): boolean =>
  /^src\/lib\/server\/(repos|services|auth)\//.test(file) ||
  file === "src/lib/server/db/index.ts" ||
  file === "src/lib/server/http/client-address.ts";

/** Each rule: does this edge break it. Rule 6 (client reach) is a graph walk, below. */
const RULES: Record<string, (edge: Edge) => boolean> = {
  // 1. The domain imports the domain and feature types only, and no impure package.
  "1": ({ from, to }) => {
    if (!isDomain(from)) return false;
    const name = packageName(to);
    if (name) return isImpurePackage(name);
    return !isDomain(to) && !isFeatureTypes(to);
  },
  // 2. Contracts import the domain and contracts only, and no impure package.
  "2": ({ from, to }) => {
    if (!isContract(from)) return false;
    const name = packageName(to);
    if (name) return isImpurePackage(name);
    return !isDomain(to) && !isContract(to);
  },
  // 3. Server code never imports the UI, the stores, the app, the live service or React.
  "3": ({ from, to }) => {
    if (!isServer(from)) return false;
    const name = packageName(to);
    if (name) return /^(react|react-dom)(\/|$)/.test(name);
    return /^src\/(components|store|app|live)\//.test(to);
  },
  // 4. Route handlers never reach the database layer, the UI or the stores.
  "4": ({ from, to }) => isRouteHandler(from) && (isDatabaseLayer(to) || isUiOrStore(to)),
  // 5. The live service uses the server's repositories, services, auth and db entry only.
  "5": ({ from, to }) => {
    if (!from.startsWith("src/live/")) return false;
    if (/^src\/(app|components|store)\//.test(to)) return true;
    return isServer(to) && !isLiveServerTarget(to);
  },
  // 7. The stores never import the UI.
  "7": ({ from, to }) => from.startsWith("src/store/") && to.startsWith("src/components/"),
  // 8. Non-UI lib never imports the UI or the stores.
  "8": ({ from, to }) => from.startsWith("src/lib/") && !isServer(from) && isUiOrStore(to),
};

/** Services return results, never HTTP responses; no allowlist entry excuses one. */
const importsNext = ({ from, to }: Edge): boolean =>
  from.startsWith("src/lib/server/services/") && /^pkg:next(\/|$)/.test(to);

/**
 * Rule 6: the code that runs in a browser (the UI, the stores, every
 * "use client" file and worker, and everything they load at run time) never
 * reaches lib/server or a Node built-in. Reported as the edges that cross.
 */
function clientCrossings(graph: Map<string, SourceFile>): Edge[] {
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const file of graph.values()) {
    if (isExempt(file.path) || !file.path.startsWith("src/")) continue;
    if (file.isClientEntry || isUiOrStore(file.path)) {
      reached.add(file.path);
      queue.push(file.path);
    }
  }
  const crossings: Edge[] = [];
  while (queue.length > 0) {
    const file = graph.get(queue.shift()!);
    for (const edge of file?.edges ?? []) {
      if (edge.typeOnly) continue;
      const name = packageName(edge.to);
      if (name) {
        if (name.startsWith("node:") || NODE_BUILTINS.has(name)) crossings.push(edge);
        continue;
      }
      if (isServer(edge.to)) {
        crossings.push(edge);
        continue;
      }
      if (!reached.has(edge.to) && graph.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return crossings;
}

const QUERY_PACKAGES = /^pkg:(@supabase\/postgrest-js|kysely|pg)(\/|$)/;

/** Files under src/app that send a query themselves. */
function queryingAppFiles(graph: Map<string, SourceFile>): string[] {
  return [...graph.values()]
    .filter((file) => file.path.startsWith("src/app/") && !isExempt(file.path))
    .filter(
      (file) =>
        file.text.includes('.from("') ||
        file.edges.some(
          (edge) => QUERY_PACKAGES.test(edge.to) || /^src\/lib\/server\/(db|repos)\//.test(edge.to),
        ),
    )
    .map((file) => file.path)
    .sort();
}

function breaks(graph: Map<string, SourceFile>): AllowedEdge[] {
  const found = new Map<string, AllowedEdge>();
  for (const file of graph.values()) {
    if (isExempt(file.path)) continue;
    for (const edge of file.edges) {
      for (const [rule, broken] of Object.entries(RULES)) {
        if (broken(edge))
          found.set(`${rule}|${edge.from}|${edge.to}`, { from: edge.from, to: edge.to, rule });
      }
    }
  }
  for (const edge of clientCrossings(graph)) {
    found.set(`6|${edge.from}|${edge.to}`, { from: edge.from, to: edge.to, rule: "6" });
  }
  return [...found.values()].sort(
    (a, b) =>
      a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

const key = (edge: AllowedEdge): string => `${edge.rule}|${edge.from}|${edge.to}`;

const graph = readGraph();
const found = breaks(graph);
const querying = queryingAppFiles(graph);

if (process.env.ARCH_DUMP === "1") {
  const dump: Allowlist = { edges: found, queriesInApp: querying };
  fs.writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(dump, null, 2)}\n`);
}

const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8")) as Allowlist;

describe("the layers", () => {
  it("resolves every import inside the repository", () => {
    const unresolved = [...graph.values()]
      .filter((file) => !isExempt(file.path))
      .flatMap((file) => file.edges.filter((edge) => edge.to.startsWith("unresolved:")))
      .map((edge) => `${edge.from} -> ${edge.to}`);
    expect(unresolved).toEqual([]);
  });

  it("no import breaks a layer rule unless the allowlist names it", () => {
    const allowed = new Set(allowlist.edges.map(key));
    const fresh = found.filter((edge) => !allowed.has(key(edge))).map(key);
    expect(fresh).toEqual([]);
  });

  it("every allowlist entry is still a real import that breaks its rule", () => {
    const current = new Set(found.map(key));
    const stale = allowlist.edges.filter((edge) => !current.has(key(edge))).map(key);
    expect(stale, "fixed: remove these from src/architecture-allowlist.json").toEqual([]);
  });

  it("no client file reaches src/lib/server", () => {
    const allowed = new Set(allowlist.edges.filter((edge) => edge.rule === "6").map(key));
    const crossings = clientCrossings(graph)
      .map((edge) => key({ from: edge.from, to: edge.to, rule: "6" }))
      .filter((edgeKey) => !allowed.has(edgeKey));
    expect(crossings).toEqual([]);
  });

  it("route handlers send no query", () => {
    expect(querying).toEqual([...allowlist.queriesInApp].sort());
  });

  it("services never import next/server", () => {
    const services = [...graph.values()].filter(
      (file) => file.path.startsWith("src/lib/server/services/") && !isExempt(file.path),
    );
    const next = services.flatMap((file) => file.edges.filter(importsNext));
    expect(next.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual([]);
  });
});
