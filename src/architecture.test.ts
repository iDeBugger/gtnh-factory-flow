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
 * `ARCH_DUMP=1 npx vitest run src/architecture.test.ts` drops the fixed
 * entries from the allowlist. It never adds one, and `MAX_ALLOWED` below holds
 * each rule's entries, so a new exception takes an edit to this file in the
 * same diff. Lower a cap when a task leaves fewer.
 *
 * The data layer (`src/lib/server/db/` and `src/lib/server/repos/`) alone
 * holds the database: its clients, its queries and its SQL. No request value
 * can reach SQL text through what the test reads: a `sql` template's `${}`
 * is a bound parameter, and what splices text in (`sql.raw`, `sql.ref`,
 * `sql.id`, `dynamic`, `CompiledQuery.raw`, ...; see `sqlWriting`) appears
 * only in `db/migrations.ts`, which reads the repository's own files.
 */

/** The most entries the allowlist may hold, per rule and for the querying app files. */
const MAX_ALLOWED: Record<string, number> = {
  "1": 11,
  "2": 1,
  "4": 1,
  "5": 1,
  "6": 1,
  "7": 4,
  "8": 48,
  "9": 0,
  "10": 0,
  "11": 0,
  queriesInApp: 0,
};

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

/** One file's imports; `relative` is its repository path, which need not exist on disk. */
function toSourceFile(relative: string, text: string): SourceFile {
  const absolute = path.join(ROOT, relative);
  const info = ts.preProcessFile(text, true, true);
  const seen = new Map<string, Edge>();
  for (const imported of info.importedFiles) {
    const to = resolveSpecifier(absolute, imported.fileName);
    const typeOnly = isTypeOnlyAt(text, imported.pos);
    const known = seen.get(to);
    if (known) {
      known.typeOnly &&= typeOnly;
    } else {
      seen.set(to, { from: relative, to, typeOnly });
    }
  }
  return {
    path: relative,
    text,
    isClientEntry: isClientEntry(relative, text),
    edges: [...seen.values()],
  };
}

function readGraph(): Map<string, SourceFile> {
  const absolute: string[] = [];
  walk(path.join(ROOT, "src"), absolute);
  walk(path.join(ROOT, "tools"), absolute);
  const graph = new Map<string, SourceFile>();
  for (const file of absolute) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    graph.set(relative, toSourceFile(relative, fs.readFileSync(file, "utf8")));
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

/** What only repositories may hold: the database client and its SQL. */
const isDatabaseLayer = (file: string): boolean => /^src\/lib\/server\/(db|repos)\//.test(file);

/**
 * The PostgREST stand-in for tests and dev: a database of its own, which
 * answers PostgREST requests with SQL. It goes with the PostgREST client.
 */
const isStandIn = (file: string): boolean => file.startsWith("src/lib/server/local-db/");

/** The one module whose SQL is text it reads from the repository: the migrations. */
const MIGRATIONS_FILE = "src/lib/server/db/migrations.ts";

/** The packages and modules that open a database connection. */
const CLIENT_PACKAGES = /^pkg:(@supabase\/postgrest-js|kysely|pg)(\/|$)/;
const CLIENT_MODULES = new Set(["src/lib/server/db/client.ts", "src/lib/server/db/rest.ts"]);

/**
 * What a service may import from lib/server: other services, repositories,
 * the db entry (for transactions and error types; names checked below),
 * auth, limits, the viewer type, the client address, the live notice, and
 * the query-free helpers the services share with routes and repositories
 * (row shapes and icons, library rows and stamps, the lease clock, blueprint
 * payloads, the plan list cache, the plan solver, plan previews, the file
 * store). Never the HTTP plumbing, the stand-in or the clients.
 */
const isServiceTarget = (file: string): boolean =>
  /^src\/lib\/server\/(services|repos|auth|limits)\//.test(file) ||
  [
    "src/lib/server/db/index.ts",
    "src/lib/server/http/viewer.ts",
    "src/lib/server/http/client-address.ts",
    "src/lib/server/live-notify.ts",
    "src/lib/server/community-rows.ts",
    "src/lib/server/library.ts",
    "src/lib/server/cloud-plans.ts",
    "src/lib/server/blueprints.ts",
    "src/lib/server/plan-list-cache.ts",
    "src/lib/server/plan-engine.ts",
    "src/lib/server/plan-preview.ts",
    "src/lib/server/file-store.ts",
  ].includes(file);

/** The layers above the data layer, which it never imports. */
const isAboveDataLayer = (file: string): boolean =>
  /^src\/lib\/server\/(services|auth|limits|http)\//.test(file) ||
  file === "src/lib/server/live-notify.ts";

/** Packages the domain and the contracts never load: they stay pure. */
function isImpurePackage(name: string): boolean {
  return (
    name.startsWith("node:") ||
    NODE_BUILTINS.has(name) ||
    /^(react|react-dom|zustand|ws|pg|kysely|next)(\/|$)/.test(name) ||
    /^(@xyflow|@supabase)\//.test(name)
  );
}

/**
 * The places in lib/server the live service may use: the repositories, and
 * by name the one service and the session code it needs, so it never loads
 * the library's saves, the rate limits, the outbound notice client or the
 * password code.
 */
const isLiveServerTarget = (file: string): boolean =>
  file.startsWith("src/lib/server/repos/") ||
  [
    "src/lib/server/services/design-role.ts",
    "src/lib/server/auth/session.ts",
    "src/lib/server/auth/secret.ts",
    "src/lib/server/auth/sessions.ts",
    "src/lib/server/db/index.ts",
    "src/lib/server/http/client-address.ts",
  ].includes(file);

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
  // 9. Only the data layer loads a database client (kysely, pg, postgrest-js, db/client, db/rest).
  //    tools/ is out of scope: its scripts (the dev database server, the type generator, the
  //    migration runner) open a database themselves and answer no request.
  "9": ({ from, to }) =>
    from.startsWith("src/") &&
    !isDatabaseLayer(from) &&
    (CLIENT_PACKAGES.test(to) || CLIENT_MODULES.has(to)),
  // 10. Services import from lib/server only what `isServiceTarget` names.
  "10": ({ from, to }) =>
    from.startsWith("src/lib/server/services/") && isServer(to) && !isServiceTarget(to),
  // 11. The data layer never imports the layers above it, and db/ never imports repos/.
  "11": ({ from, to }) =>
    isDatabaseLayer(from) &&
    (isAboveDataLayer(to) ||
      (from.startsWith("src/lib/server/db/") && to.startsWith("src/lib/server/repos/"))),
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

/**
 * A query builder's `.from("table")`, whatever the client is named. The
 * built-ins' static `from` (`Array.from`, `Buffer.from`, typed arrays) is no
 * query and is excused by name.
 */
const QUERY_TEXT =
  /(?<!\b(?:Array|Buffer|Object|Set|Map|String|Iterator|(?:Int|Uint|Float|BigInt|BigUint)(?:8|16|32|64)(?:Clamped)?Array)\s*)\.from\(\s*["'`]/;

/** Kysely's statement builders, which no other library in the app names. */
const KYSELY_QUERY_TEXT =
  /\.(selectFrom|selectNoFrom|insertInto|replaceInto|updateTable|deleteFrom|mergeInto)\(/;

function sendsQuery(text: string): boolean {
  return QUERY_TEXT.test(text) || KYSELY_QUERY_TEXT.test(text);
}

/** Files outside the data layer (and the stand-in) that send a query. */
function queriesOutsideDataLayer(graph: Map<string, SourceFile>): string[] {
  return [...graph.values()]
    .filter(
      (file) =>
        file.path.startsWith("src/") &&
        !isExempt(file.path) &&
        !isDatabaseLayer(file.path) &&
        !isStandIn(file.path),
    )
    .filter((file) => sendsQuery(file.text))
    .map((file) => file.path)
    .sort();
}

const syntaxTrees = new Map<string, ts.SourceFile>();

function syntaxTree(file: SourceFile): ts.SourceFile {
  let tree = syntaxTrees.get(file.path);
  if (!tree || tree.text !== file.text) {
    const kind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    tree = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, kind);
    syntaxTrees.set(file.path, tree);
  }
  return tree;
}

/**
 * The names `file` imports or re-exports from `target`: each binding's
 * exported name, `*` for a namespace or `export *`, `default` for a default,
 * and `import()` for a dynamic import or `require`, whose names this reading
 * cannot see and so never passes.
 */
function namesImported(file: SourceFile, target: string): string[] {
  if (!file.edges.some((edge) => edge.to === target)) return [];
  const names: string[] = [];
  for (const statement of syntaxTree(file).statements) {
    const isImport = ts.isImportDeclaration(statement);
    if (!isImport && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    if (resolveSpecifier(path.join(ROOT, file.path), specifier.text) !== target) continue;
    if (isImport) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) names.push("default");
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
      }
    } else {
      const clause = statement.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) {
        names.push("*");
      } else {
        for (const element of clause.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loaded = node.arguments[0];
      if (
        (callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === "require")) &&
        loaded &&
        ts.isStringLiteral(loaded) &&
        resolveSpecifier(path.join(ROOT, file.path), loaded.text) === target
      ) {
        names.push("import()");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntaxTree(file));
  return names;
}

const DB_ENTRY = "src/lib/server/db/index.ts";

/** The db entry's database handles: only the data layer takes one. */
const CLIENT_HANDLES = new Set(["getDb", "getCommunityDb", "*", "import()"]);

/** Files outside the data layer that take a database handle from the db entry. */
function clientHandleImports(graph: Map<string, SourceFile>): string[] {
  return [...graph.values()]
    .filter((file) => !isExempt(file.path) && !isDatabaseLayer(file.path))
    .flatMap((file) =>
      namesImported(file, DB_ENTRY)
        .filter((name) => CLIENT_HANDLES.has(name))
        .map((name) => `${file.path}: ${name}`),
    )
    .sort();
}

/** The names a module exports: declarations, export lists (both names), `*` for `export *`. */
function exportedNames(file: SourceFile): string[] {
  const names: string[] = [];
  for (const statement of syntaxTree(file).statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) {
        names.push("*");
      } else {
        for (const element of clause.elements) {
          if (element.propertyName) names.push(element.propertyName.text);
          names.push(element.name.text);
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) names.push(statement.expression.text);
    } else if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        names.push(statement.name.text);
      }
    }
  }
  return names;
}

/** The modules that define or gather the database handles, and the names they hand on. */
const HANDLE_MODULES = new Set([
  DB_ENTRY,
  "src/lib/server/db/client.ts",
  "src/lib/server/db/rest.ts",
]);
const HANDLE_NAMES = new Set(["getDb", "getCommunityDb", "createDbClient", "sql", "CompiledQuery"]);

/**
 * Data-layer modules other than the handle modules that export a handle (or
 * `export *`), which would let a service, allowed to import repositories,
 * take one past the db entry's name checks.
 */
function handleReexports(graph: Map<string, SourceFile>): string[] {
  return [...graph.values()]
    .filter(
      (file) =>
        isDatabaseLayer(file.path) && !isExempt(file.path) && !HANDLE_MODULES.has(file.path),
    )
    .flatMap((file) =>
      exportedNames(file)
        .filter((name) => name === "*" || HANDLE_NAMES.has(name))
        .map((name) => `${file.path}: ${name}`),
    )
    .sort();
}

/**
 * What a service takes from the db entry: the transaction, its handle's type
 * and the failure types and sentences. Building SQL (`json`) is the
 * repositories' work; `services/config.ts` alone also asks whether a
 * database is configured.
 */
const SERVICE_DB_NAMES = new Set([
  "withTransaction",
  "Tx",
  "DbQueryError",
  "DatabaseDownError",
  "isDatabaseDown",
  "COMMUNITY_DB_DOWN_MESSAGE",
  "blueprintStorageErrorMessage",
  "communityStorageErrorMessage",
  "libraryStorageErrorMessage",
  "isMissingColumnError",
]);
const CONFIG_DB_NAMES = new Set(["isCommunityConfigured", "isDatabaseConfigured"]);

function serviceDbNames(graph: Map<string, SourceFile>): string[] {
  return [...graph.values()]
    .filter((file) => file.path.startsWith("src/lib/server/services/") && !isExempt(file.path))
    .flatMap((file) =>
      namesImported(file, DB_ENTRY)
        .filter(
          (name) =>
            !SERVICE_DB_NAMES.has(name) &&
            !(file.path === "src/lib/server/services/config.ts" && CONFIG_DB_NAMES.has(name)),
        )
        .map((name) => `${file.path}: ${name}`),
    )
    .sort();
}

/** Kysely's calls that put their argument into the SQL text rather than bind it. */
const SPLICING_CALLS = new Set(["raw", "ref", "id", "lit", "table"]);

const isKysely = (specifier: ts.Node): boolean =>
  ts.isStringLiteral(specifier) && /^kysely(\/|$)/.test(specifier.text);

/** A name used as a type, or named in an import: no value reaches SQL through it. */
const inTypeOrImport = (node: ts.Node): boolean =>
  ts.isTypeReferenceNode(node.parent) ||
  ts.isTypeQueryNode(node.parent) ||
  ts.isImportSpecifier(node.parent) ||
  ts.isExpressionWithTypeArguments(node.parent);

/**
 * Where SQL is written, read from the syntax tree. `template` is a `sql`
 * template; `splicing` lists what can put a value into the SQL text:
 * - a splicing call on `sql` (`sql.raw`, `sql.ref`, `sql.id`, `sql.lit`, `sql.table`);
 * - Kysely's `sql` used other than as a template tag or the object of such a
 *   call (assigned, destructured, indexed, passed), which hides its calls
 *   from this reading, and `sql` imported under another name;
 * - `dynamic` (`db.dynamic.ref`, `const { dynamic } = db`), whose `ref` and
 *   `table` take any string as an identifier;
 * - `CompiledQuery` as a value (`CompiledQuery.raw` runs a string as SQL),
 *   and outside db/ any mention of it;
 * - a namespace or dynamic import of kysely, which would reach all of these
 *   under other names.
 */
function sqlWriting(file: SourceFile): { template: boolean; splicing: string[] } {
  const splicing = new Set<string>();
  let template = false;
  if (!/\bsql\b|\bdynamic\b|\bCompiledQuery\b|kysely/.test(file.text)) {
    return { template, splicing: [] };
  }
  const tree = syntaxTree(file);
  const sqlNames = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !isKysely(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) splicing.add("kysely namespace import");
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text !== "sql") continue;
        sqlNames.add(element.name.text);
        if (element.name.text !== "sql") splicing.add(`sql as ${element.name.text}`);
      }
    }
  }
  // Any `sql` counts, imported or not, and so does an alias of Kysely's.
  const namedSql = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && (node.text === "sql" || sqlNames.has(node.text))) ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "sql");
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && namedSql(node.tag)) {
      template = true;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        SPLICING_CALLS.has(callee.name.text) &&
        namedSql(callee.expression)
      ) {
        splicing.add(`sql.${callee.name.text}`);
      }
      const loaded = node.arguments[0];
      if (
        (callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === "require")) &&
        loaded &&
        isKysely(loaded)
      ) {
        splicing.add("kysely loaded dynamically");
      }
    }
    if (ts.isIdentifier(node) && sqlNames.has(node.text) && !inTypeOrImport(node)) {
      const parent = node.parent;
      const isTag = ts.isTaggedTemplateExpression(parent) && parent.tag === node;
      const isCallObject =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent;
      if (!isTag && !isCallObject) splicing.add("sql used as a value");
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "dynamic") ||
      (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText() === "dynamic") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "dynamic")
    ) {
      splicing.add("dynamic");
    }
    if (ts.isIdentifier(node) && node.text === "CompiledQuery") {
      if (!file.path.startsWith("src/lib/server/db/")) {
        splicing.add("CompiledQuery");
      } else if (!inTypeOrImport(node)) {
        splicing.add("CompiledQuery as a value");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { template, splicing: [...splicing] };
}

/** SQL written where it may not be: templates outside the data layer, splicing outside the migrations. */
function sqlOutOfPlace(graph: Map<string, SourceFile>): string[] {
  const out: string[] = [];
  for (const file of graph.values()) {
    if (isExempt(file.path)) continue;
    const { template, splicing } = sqlWriting(file);
    if (template && !isDatabaseLayer(file.path)) out.push(`${file.path}: sql template`);
    if (file.path !== MIGRATIONS_FILE) {
      for (const call of splicing) out.push(`${file.path}: ${call}`);
    }
  }
  return out.sort();
}

/**
 * Files under src/app that send a query themselves, or hold the client. A
 * route that hands a query to a helper outside db/ and repos/
 * (`community-rows`, `library`, `cloud-plans`, `blueprints`) is not seen
 * here; those helpers join the database layer as their queries move into
 * repositories.
 */
function queryingAppFiles(graph: Map<string, SourceFile>): string[] {
  return [...graph.values()]
    .filter((file) => file.path.startsWith("src/app/") && !isExempt(file.path))
    .filter(
      (file) =>
        sendsQuery(file.text) ||
        file.edges.some(
          (edge) =>
            CLIENT_PACKAGES.test(edge.to) || /^src\/lib\/server\/(db|repos)\//.test(edge.to),
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

const readAllowlist = (): Allowlist =>
  JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8")) as Allowlist;

if (process.env.ARCH_DUMP === "1") {
  // Only removes: an entry stays while its edge still breaks the rule, and a new break is never written.
  const listed = readAllowlist();
  const current = new Set(found.map(key));
  const querySet = new Set(querying);
  const dump: Allowlist = {
    edges: listed.edges.filter((edge) => current.has(key(edge))),
    queriesInApp: listed.queriesInApp.filter((file) => querySet.has(file)),
  };
  fs.writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(dump, null, 2)}\n`);
}

const allowlist = readAllowlist();

describe("the layers", () => {
  it("the allowlist holds exactly MAX_ALLOWED entries per rule", () => {
    const counts: Record<string, number> = { queriesInApp: allowlist.queriesInApp.length };
    for (const edge of allowlist.edges) counts[edge.rule] = (counts[edge.rule] ?? 0) + 1;
    const rules = new Set([...Object.keys(counts), ...Object.keys(MAX_ALLOWED)]);
    const off = [...rules]
      .filter((rule) => (counts[rule] ?? 0) !== (MAX_ALLOWED[rule] ?? 0))
      .map((rule) => `${rule}: ${counts[rule] ?? 0} listed, cap ${MAX_ALLOWED[rule] ?? 0}`);
    expect(off, "lower MAX_ALLOWED to what the allowlist holds").toEqual([]);
  });

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

  it("counts a query builder's .from by any client name, and not the built-ins' from", () => {
    for (const text of [
      'db.from("plans")',
      'communityDb.from("x")',
      'planDb.from("x")',
      "getCommunityDb().from('x')",
      "  .from(`community_plans`)",
      'tx\n  .from("x")',
    ]) {
      expect(sendsQuery(text), text).toBe(true);
    }
    for (const text of [
      'Array.from("abc")',
      'Buffer.from("x")',
      'Uint8Array.from("x")',
      'Object.from("x")',
    ]) {
      expect(sendsQuery(text), text).toBe(false);
    }
  });

  it("services never import next/server", () => {
    const services = [...graph.values()].filter(
      (file) => file.path.startsWith("src/lib/server/services/") && !isExempt(file.path),
    );
    const next = services.flatMap((file) => file.edges.filter(importsNext));
    expect(next.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual([]);
  });

  it("only the data layer sends a query", () => {
    expect(queriesOutsideDataLayer(graph)).toEqual([]);
  });

  it("only the data layer takes a database handle from the db entry", () => {
    expect(clientHandleImports(graph)).toEqual([]);
  });

  it("services take only transactions and failure types from the db entry", () => {
    expect(serviceDbNames(graph)).toEqual([]);
  });

  it("no repository hands on a database handle", () => {
    expect(handleReexports(graph)).toEqual([]);
  });

  it("refuses a repository that re-exports a handle", () => {
    const repo = (name: string) => `src/lib/server/repos/handle-${name}.ts`;
    const fixtures: Record<string, string> = {
      [repo("named")]: 'export { getDb } from "../db";',
      [repo("renamed")]: 'export { getCommunityDb as plans } from "../db";',
      [repo("star")]: 'export * from "../db";',
      [repo("sql")]: 'import { sql } from "kysely";\nexport { sql };',
      [repo("default")]: 'import { getDb } from "../db";\nexport default getDb;',
      [repo("declared")]: "export const sql = 1;\nexport function rows() { return []; }",
      [repo("fine")]: 'import { getDb } from "../db";\nexport const count = () => getDb();',
    };
    const bad = new Map(
      Object.entries(fixtures).map(([file, text]) => [file, toSourceFile(file, text)]),
    );
    expect(handleReexports(bad)).toEqual([
      `${repo("declared")}: sql`,
      `${repo("default")}: getDb`,
      `${repo("named")}: getDb`,
      `${repo("renamed")}: getCommunityDb`,
      `${repo("sql")}: sql`,
      `${repo("star")}: *`,
    ]);
  });

  it("SQL is written only in the data layer, and spliced text only in the migrations", () => {
    expect(sqlOutOfPlace(graph)).toEqual([]);
  });

  it("refuses a live file that loads a service or auth module it does not need", () => {
    const live = "src/live/arch-fixture.ts";
    const bad = new Map([
      [
        live,
        toSourceFile(
          live,
          [
            'import { saveDesign } from "@/lib/server/services/library";',
            'import { hashPassword } from "@/lib/server/auth/passwords";',
            'import { isAdminRequest } from "@/lib/server/auth/admin";',
            'import { designRole } from "@/lib/server/services/design-role";',
            'import { loadSessionUser } from "@/lib/server/auth/sessions";',
            'import * as designs from "@/lib/server/repos/designs";',
          ].join("\n"),
        ),
      ],
    ]);
    expect(breaks(bad).map(key)).toEqual([
      `5|${live}|src/lib/server/auth/admin.ts`,
      `5|${live}|src/lib/server/auth/passwords.ts`,
      `5|${live}|src/lib/server/services/library.ts`,
    ]);
  });

  it("holds a dynamic import or require of the db entry to the same name checks", () => {
    const fixtures: Record<string, string> = {
      "src/lib/server/services/import-fixture.ts": [
        "export const handle = async () => {",
        '  const { getDb } = await import("../db");',
        "  return getDb();",
        "};",
      ].join("\n"),
      "src/lib/server/services/require-fixture.ts":
        'export const handle = () => require("../db").getDb();',
      "src/lib/server/import-fixture.ts":
        'export const handle = async () => (await import("./db")).getCommunityDb();',
    };
    const bad = new Map(
      Object.entries(fixtures).map(([file, text]) => [file, toSourceFile(file, text)]),
    );
    expect(clientHandleImports(bad)).toEqual([
      "src/lib/server/import-fixture.ts: import()",
      "src/lib/server/services/import-fixture.ts: import()",
      "src/lib/server/services/require-fixture.ts: import()",
    ]);
    expect(serviceDbNames(bad)).toEqual([
      "src/lib/server/services/import-fixture.ts: import()",
      "src/lib/server/services/require-fixture.ts: import()",
    ]);
  });

  it("refuses each way of putting a value into the SQL text", () => {
    const repo = (name: string) => `src/lib/server/repos/splice-${name}.ts`;
    const fixtures: Record<string, string> = {
      [repo("compiled")]: [
        'import { CompiledQuery } from "kysely";',
        'import { getDb } from "../db";',
        "export const run = (c: string) => getDb().executeQuery(CompiledQuery.raw(`select ${c}`));",
      ].join("\n"),
      [repo("dynamic-destructured")]: [
        'import { getDb } from "../db";',
        "export const column = (c: string) => {",
        "  const { dynamic } = getDb();",
        "  return dynamic.ref(c);",
        "};",
      ].join("\n"),
      [repo("dynamic-ref")]: [
        'import { getDb } from "../db";',
        "export const column = (c: string) => getDb().dynamic.ref(c);",
      ].join("\n"),
      [repo("dynamic-table")]: [
        'import { getDb } from "../db";',
        'export const table = (t: string) => getDb()["dynamic"].table(t);',
      ].join("\n"),
      [repo("sql-variable")]: [
        'import { sql } from "kysely";',
        "const s = sql;",
        "export const column = (c: string) => s.raw(c);",
      ].join("\n"),
      [repo("sql-destructured")]: [
        'import { sql } from "kysely";',
        "const { raw } = sql;",
        "export const column = (c: string) => raw(c);",
      ].join("\n"),
      [repo("sql-indexed")]: [
        'import { sql } from "kysely";',
        'export const column = (c: string) => sql["raw"](c);',
      ].join("\n"),
      [repo("sql-namespace")]: [
        'import * as k from "kysely";',
        "export const column = (c: string) => k.sql.raw(c);",
      ].join("\n"),
      [repo("sql-dynamic-import")]: [
        "export const column = async (c: string) => {",
        '  const { sql: text } = await import("kysely");',
        "  return text.raw(c);",
        "};",
      ].join("\n"),
      "src/lib/server/db/compiled-as-type.ts": [
        'import type { CompiledQuery } from "kysely";',
        "export const size = (query: CompiledQuery) => query.sql.length;",
      ].join("\n"),
    };
    const bad = new Map(
      Object.entries(fixtures).map(([file, text]) => [file, toSourceFile(file, text)]),
    );
    expect(sqlOutOfPlace(bad)).toEqual([
      `${repo("compiled")}: CompiledQuery`,
      `${repo("dynamic-destructured")}: dynamic`,
      `${repo("dynamic-ref")}: dynamic`,
      `${repo("dynamic-table")}: dynamic`,
      `${repo("sql-destructured")}: sql used as a value`,
      `${repo("sql-dynamic-import")}: kysely loaded dynamically`,
      `${repo("sql-indexed")}: sql used as a value`,
      `${repo("sql-namespace")}: kysely namespace import`,
      `${repo("sql-namespace")}: sql.raw`,
      `${repo("sql-variable")}: sql used as a value`,
    ]);
  });

  it("refuses a bad file under each data-layer rule", () => {
    // Read from memory through the same parser as the real tree; nothing is written to disk.
    const fixtures: Record<string, string> = {
      "src/lib/server/services/arch-fixture.ts": [
        'import { Kysely } from "kysely";',
        'import { getDb, json } from "../db";',
        'import { readJsonBody } from "../http/request-body";',
        'import { openLocalDatabase } from "../local-db/database";',
        'export const rows = () => getDb().selectFrom("community_plans").selectAll();',
      ].join("\n"),
      "src/live/arch-fixture.ts": 'import { createDbClient } from "@/lib/server/db/client";',
      "src/lib/server/plan-arch-fixture.ts": [
        'import * as db from "./db";',
        'export const rows = () => db.getCommunityDb().from("community_plans").select("id");',
      ].join("\n"),
      "src/lib/server/repos/arch-fixture.ts": [
        'import { sql } from "kysely";',
        'import { checkRateLimit } from "../limits/rate-limit";',
        "export const byColumn = (column: string) => sql`select ${sql.raw(column)}`;",
        "export const named = (column: string) => sql.ref(column);",
      ].join("\n"),
      "src/lib/server/db/arch-fixture.ts": [
        'import { sql as text } from "kysely";',
        'import { findPlan } from "../repos/plans";',
        "export const any = (name: string) => text.id(name);",
      ].join("\n"),
      "src/lib/server/auth/arch-fixture.ts": "export const one = () => sql`select 1`;",
    };
    const bad = new Map(
      Object.entries(fixtures).map(([file, text]) => [file, toSourceFile(file, text)]),
    );
    const services = "src/lib/server/services/arch-fixture.ts";
    expect(breaks(bad).map(key)).toEqual(
      expect.arrayContaining([
        `9|${services}|pkg:kysely`,
        `10|${services}|src/lib/server/http/request-body.ts`,
        `10|${services}|src/lib/server/local-db/database.ts`,
        "5|src/live/arch-fixture.ts|src/lib/server/db/client.ts",
        "9|src/live/arch-fixture.ts|src/lib/server/db/client.ts",
        "11|src/lib/server/repos/arch-fixture.ts|src/lib/server/limits/rate-limit.ts",
        "11|src/lib/server/db/arch-fixture.ts|src/lib/server/repos/plans.ts",
      ]),
    );
    expect(queriesOutsideDataLayer(bad)).toEqual(["src/lib/server/plan-arch-fixture.ts", services]);
    expect(clientHandleImports(bad)).toEqual([
      "src/lib/server/plan-arch-fixture.ts: *",
      `${services}: getDb`,
    ]);
    expect(serviceDbNames(bad)).toEqual([`${services}: getDb`, `${services}: json`]);
    expect(sqlOutOfPlace(bad)).toEqual([
      "src/lib/server/auth/arch-fixture.ts: sql template",
      "src/lib/server/db/arch-fixture.ts: sql as text",
      "src/lib/server/db/arch-fixture.ts: sql.id",
      "src/lib/server/repos/arch-fixture.ts: sql.raw",
      "src/lib/server/repos/arch-fixture.ts: sql.ref",
    ]);
  });
});
