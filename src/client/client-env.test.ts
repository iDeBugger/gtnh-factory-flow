import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CLIENT_ENV_NAMES } from "../../tools/build/define.mjs";

/**
 * The browser has no `process`. Vite inlines only the names
 * `tools/build/define.mjs` defines, so any other `process` read that browser
 * code reaches at run time throws `process is not defined` at load, and only
 * in the production build. This walks the source import graph from the page
 * entry and the four workers (no build) and holds every `process` read it
 * finds: the defined names read plainly, the debug switches behind
 * `typeof process`, and the one run-time read behind `typeof window`.
 */

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");
const ENTRIES = [
  "src/client/main.tsx",
  "src/lib/arrange.worker.ts",
  "src/store/solve-books.worker.ts",
  "src/components/flow/grid-route.worker.ts",
  "src/lib/search/resource-search.worker.ts",
];
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

interface ProcessRead {
  file: string;
  /** `process.env.NAME` read without a guard. */
  envName?: string;
  /** The `process.env?.NAME` or other read behind `typeof process`. */
  guardedName?: string;
  /** `Reflect.get(process.env, ...)`. */
  reflect?: boolean;
  /** Anything else: an unguarded read of something not defined. */
  other?: string;
}

function resolveImport(from: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(from), specifier);
  } else {
    return undefined;
  }
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => base + extension),
    ...EXTENSIONS.map((extension) => path.join(base, "index" + extension)),
  ];
  return candidates.find(
    (candidate) =>
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile() &&
      EXTENSIONS.includes(path.extname(candidate)),
  );
}

/** The modules a file loads at run time: value imports, re-exports, dynamic imports and workers. */
function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function isTypeofProcessGuard(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (
      ts.isTypeOfExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === "process"
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Whether `node` sits on the right of an `&&` whose left tests `typeof process`, or in such an `if`. */
function isBehindTypeofProcess(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === child &&
      isTypeofProcessGuard(parent.left)
    ) {
      return true;
    }
    if (
      ts.isIfStatement(parent) &&
      parent.thenStatement === child &&
      isTypeofProcessGuard(parent.expression)
    ) {
      return true;
    }
  }
  return false;
}

function processReads(file: string, source: ts.SourceFile): ProcessRead[] {
  const reads: ProcessRead[] = [];
  const relative = path.relative(ROOT, file).split(path.sep).join("/");
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "process") {
      const parent = node.parent;
      const isOperandOfTypeof = ts.isTypeOfExpression(parent);
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ts.isPropertySignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isShorthandPropertyAssignment(parent);
      if (!isOperandOfTypeof && !isPropertyName) {
        reads.push(classify(relative, node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

function classify(file: string, node: ts.Identifier): ProcessRead {
  const parent = node.parent;
  // process.env.NAME, as written (no optional chain between env and NAME).
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name.text === "env" &&
    !parent.questionDotToken &&
    ts.isPropertyAccessExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    const outer = parent.parent;
    if (isBehindTypeofProcess(node)) return { file, guardedName: outer.name.text };
    if (!outer.questionDotToken) return { file, envName: outer.name.text };
  }
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name.text === "env" &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.arguments[0] === parent &&
    parent.parent.expression.getText() === "Reflect.get"
  ) {
    return { file, reflect: true };
  }
  if (isBehindTypeofProcess(node)) {
    const outer = ts.isPropertyAccessExpression(parent) ? parent.parent : undefined;
    const name =
      outer && ts.isPropertyAccessExpression(outer) && outer.expression === parent
        ? outer.name.text
        : parent.getText();
    return { file, guardedName: name };
  }
  return { file, other: parent.getText() };
}

function browserReads(): { files: string[]; reads: ProcessRead[] } {
  const seen = new Set<string>();
  const queue = ENTRIES.map((entry) => path.join(ROOT, entry));
  const reads: ProcessRead[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    reads.push(...processReads(file, source));
    for (const specifier of runtimeSpecifiers(source)) {
      const resolved = resolveImport(file, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return { files: [...seen], reads };
}

describe("process in browser code", () => {
  const { files, reads } = browserReads();

  it("walks the app and the workers", () => {
    const relative = files.map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
    expect(relative).toContain("src/components/FactoryPlannerApp.tsx");
    expect(relative).toContain("src/lib/deployment-features.ts");
    expect(relative).toContain("src/lib/solver/simplex.ts");
  });

  it("browser code reads only the defined process.env names, unguarded", () => {
    const names = reads.flatMap((read) => (read.envName ? [read.envName] : []));
    expect([...new Set(names)].sort()).toEqual([...CLIENT_ENV_NAMES].sort());
  });

  it("every other process read in browser code sits behind typeof process", () => {
    // The one plain read is on HiGHS's Node branch, which the browser never takes: the worker always passes the
    // glue URL, and loadNodeHighs runs only without one.
    expect(reads.filter((read) => read.other).map((read) => `${read.file}:${read.other}`)).toEqual([
      "src/lib/solver/lp-engine.ts:process.cwd",
    ]);
    expect(
      reads
        .flatMap((read) => (read.guardedName ? [`${read.file}:${read.guardedName}`] : []))
        .sort(),
    ).toEqual([
      "src/lib/board-arrange.ts:ARRANGE_DEBUG",
      "src/lib/board-arrange.ts:ARRANGE_DEBUG",
      "src/lib/solver/simplex.ts:SIMPLEX_DEBUG",
      "src/lib/solver/simplex.ts:SIMPLEX_DEBUG",
    ]);
  });

  it("reads Reflect.get(process.env) only in deployment-features.ts, behind typeof window", () => {
    expect(reads.filter((read) => read.reflect).map((read) => read.file)).toEqual([
      "src/lib/deployment-features.ts",
    ]);
    const text = fs.readFileSync(path.join(SRC, "lib/deployment-features.ts"), "utf8");
    const windowCheck = text.indexOf(
      'if (typeof window !== "undefined") {\n    return built;\n  }',
    );
    expect(windowCheck).toBeGreaterThan(-1);
    expect(windowCheck).toBeLessThan(text.indexOf("Reflect.get(process.env"));
  });
});
