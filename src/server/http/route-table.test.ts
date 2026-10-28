import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CASES, ROUTE_TABLE } from "../../../tools/http-parity/requests.mjs";
import { optionsAllow, routePathForFile, ROUTES, type WebHandler } from "./route-table";

const REPO = path.resolve(__dirname, "../../..");

/**
 * Every route file under a folder, as a repo path: `route.ts`, `.tsx`, `.js` or `.jsx`.
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

/** The bracketed path of a route file: the key the parity cases use. */
const nextPath = (source: string): string =>
  source.replace(/^src\/server\/routes/, "").replace(/\/route\.[jt]sx?$/, "");

/**
 * The path-to-regexp Express's router loads (resolved from `router`, so it is the copy Express runs), with the
 * options its layers use under this app's settings: case-sensitive, whole path, no trailing slash.
 */
const { match } = createRequire(createRequire(import.meta.url).resolve("router/package.json"))(
  "path-to-regexp",
) as typeof import("path-to-regexp");

/**
 * Whether an Express 5 path from the table matches a concrete path, as Express's router decides it. Params are
 * left encoded: a param that does not decode still claims its request in Express (the router answers its decode
 * error), so precedence is decided before decoding.
 */
function matches(pattern: string, concrete: string): boolean {
  const matcher = match(pattern, {
    sensitive: true,
    end: true,
    trailing: false,
    decode: (value: string) => value,
  });
  return matcher(concrete.split("?")[0]!) !== false;
}

const h: WebHandler = () => new Response(null);

describe("the route table", () => {
  it("registers every route file under src/server/routes at the path its folders name", () => {
    const files = globRouteFiles("src/server/routes");
    expect(files.length).toBe(37);
    expect(ROUTES.map((r) => r.source).sort()).toEqual(files.sort());
    for (const route of ROUTES) expect(route.path).toBe(routePathForFile(route.source));
  });

  /*
   * routePathForFile maps plain, `[x]` and `[...x]` folders only. Other spellings a reader might expect to mean
   * something (a `(group)` left out of the URL, a `_private` folder, `%5F`, `[[...x]]` also matching its parent,
   * `[file-name]` as one param) would each map wrong, some silently. Such a folder must fail here until the
   * mapping learns it.
   */
  it("finds no route folder whose name the path mapping does not cover", () => {
    const segment = /^([a-z0-9.-]+|\[[A-Za-z_$][\w$]*\]|\[\.\.\.[A-Za-z_$][\w$]*\])$/;
    for (const file of globRouteFiles("src/server/routes")) {
      for (const folder of nextPath(file).split("/").slice(1)) {
        expect(folder, file).toMatch(segment);
      }
    }
  });

  it("derives Express 5 paths from bracketed folder names", () => {
    expect(routePathForFile("src/server/routes/api/a/[id]/route.ts")).toBe("/api/a/:id");
    expect(
      routePathForFile("src/server/routes/dataset-files/[versionId]/[...assetPath]/route.ts"),
    ).toBe("/dataset-files/:versionId/*assetPath");
    expect(routePathForFile("src/server/routes/robots.txt/route.ts")).toBe("/robots.txt");
    expect(routePathForFile("src/server/routes/api/version/route.tsx")).toBe("/api/version");
    expect(routePathForFile("src/server/routes/api/version/route.js")).toBe("/api/version");
    expect(routePathForFile("src/server/routes/api/version/route.jsx")).toBe("/api/version");
  });

  it("serves each route with the handlers its own file exports", async () => {
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
    for (const route of ROUTES) {
      const imported = (await import(path.join(REPO, route.source))) as Record<string, unknown>;
      const exported = methods.filter((method) => typeof imported[method] === "function");
      expect(Object.keys(route.module).sort(), route.source).toEqual([...exported].sort());
      for (const method of exported) {
        expect(route.module[method] === imported[method], `${method} ${route.source}`).toBe(true);
      }
    }
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

  it("serves only the HiGHS files as static", () => {
    expect(ROUTES.filter((route) => route.serving).map((route) => route.source)).toEqual([
      "src/server/routes/api/highs/[file]/route.ts",
    ]);
    expect(ROUTES.find((route) => route.serving)?.serving).toBe("static");
  });

  it("finds no export in a route file other than its handlers", async () => {
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
    for (const route of ROUTES) {
      const imported = (await import(path.join(REPO, route.source))) as Record<string, unknown>;
      expect(
        Object.keys(imported).filter((name) => !methods.includes(name)),
        route.source,
      ).toEqual([]);
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

  it("has parity cases for exactly the methods each route exports", () => {
    for (const route of ROUTES) {
      const route_ = nextPath(route.source);
      // HEAD and OPTIONS are asked of every route, and PATCH of every route as the unexported probe.
      const probed = (c: { name: string; method: string }) =>
        c.method === "HEAD" || c.method === "OPTIONS" || c.name.endsWith(" unexported");
      const caseMethods = new Set(
        CASES.filter((c) => c.route === route_ && !probed(c)).map((c) => c.method),
      );
      expect([...caseMethods].sort(), route_).toEqual(Object.keys(route.module).sort());
      const listed = ROUTE_TABLE.find((r) => r.route === route_);
      expect(listed?.methods.slice().sort(), route_).toEqual(Object.keys(route.module).sort());
    }
    expect(ROUTE_TABLE.map((r) => r.route).sort()).toEqual(
      ROUTES.map((r) => nextPath(r.source)).sort(),
    );
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
