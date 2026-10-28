import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CASES } from "../../../tools/http-parity/requests.mjs";
import { optionsAllow, routePathForFile, ROUTES, type WebHandler } from "./route-table";

const REPO = path.resolve(__dirname, "../../..");

/**
 * Every route file under a folder, as a repo path: `route.ts`, `.tsx`, `.js` or `.jsx`, the names Next routes.
 * Only the baseline's parity fixtures (`__parity-*`) are left out.
 */
function globRouteFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(REPO, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.name.startsWith("__parity-")) continue;
      if (entry.isDirectory()) walk(child);
      else if (/^route\.[jt]sx?$/.test(entry.name)) found.push(child);
    }
  };
  walk(dir);
  return found;
}

/** The Next path of a route file, brackets kept: the key the parity cases use. */
const nextPath = (source: string): string =>
  source.replace(/^src\/app/, "").replace(/\/route\.[jt]sx?$/, "");

/** Whether an Express 5 path from the table matches a concrete path: `:x` takes one segment, `*x` the rest. */
function matches(pattern: string, concrete: string): boolean {
  const want = pattern.split("/").slice(1);
  const have = concrete.split("?")[0].split("/").slice(1);
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith("*")) return have.length > i;
    if (i >= have.length) return false;
    if (!want[i].startsWith(":") && want[i] !== have[i]) return false;
  }
  return want.length === have.length;
}

const h: WebHandler = () => new Response(null);

describe("the route table", () => {
  it("registers every route file under src/app at the path its folders name", () => {
    const files = globRouteFiles("src/app");
    expect(files.length).toBe(38);
    expect(ROUTES.map((r) => r.source).sort()).toEqual(files.sort());
    for (const route of ROUTES) expect(route.path).toBe(routePathForFile(route.source));
  });

  it("derives Express 5 paths from Next folder names", () => {
    expect(routePathForFile("src/app/api/a/[id]/route.ts")).toBe("/api/a/:id");
    expect(routePathForFile("src/app/dataset-files/[versionId]/[...assetPath]/route.ts")).toBe(
      "/dataset-files/:versionId/*assetPath",
    );
    expect(routePathForFile("src/app/llms.txt/route.ts")).toBe("/llms.txt");
    expect(routePathForFile("src/app/api/version/route.tsx")).toBe("/api/version");
    expect(routePathForFile("src/app/api/version/route.js")).toBe("/api/version");
    expect(routePathForFile("src/app/api/version/route.jsx")).toBe("/api/version");
  });

  it("keeps only the method exports of a route module", () => {
    for (const route of ROUTES) {
      expect(Object.keys(route.module).length).toBeGreaterThan(0);
      for (const [name, handler] of Object.entries(route.module)) {
        expect(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).toContain(name);
        expect(typeof handler).toBe("function");
      }
    }
  });

  it("lists OPTIONS' Allow sorted, as Next does", () => {
    expect(optionsAllow({ POST: h, GET: h })).toBe("GET, HEAD, OPTIONS, POST");
    expect(optionsAllow({ POST: h })).toBe("OPTIONS, POST");
    expect(optionsAllow({ PUT: h, DELETE: h })).toBe("DELETE, OPTIONS, PUT");
  });

  it("lists routes in Next's precedence: each concrete path reaches its own route first", () => {
    for (const route of ROUTES) {
      const pathCases = CASES.filter((c) => c.route === nextPath(route.source));
      expect(pathCases.length).toBeGreaterThan(0);
      for (const c of pathCases) {
        const first = ROUTES.find((r) => matches(r.path, c.target));
        expect(first?.source, c.target).toBe(route.source);
      }
    }
  });

  it("has a parity case for every route and every method", () => {
    for (const route of ROUTES) {
      const route_ = nextPath(route.source);
      const methods = [...Object.keys(route.module), "HEAD", "OPTIONS"];
      for (const method of methods) {
        const found = CASES.some((c) => c.route === route_ && c.method === method);
        expect(found, `${method} ${route_}`).toBe(true);
      }
    }
  });
});
