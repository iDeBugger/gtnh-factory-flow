import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RequestHandler } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import allowJson from "../../tools/http-parity/allowed-differences.json";
import { diffCases, type AllowEntry, type StoredCase } from "../../tools/http-parity/compare.mjs";
import type { RawAnswer } from "../../tools/http-parity/requests.mjs";
import nextAnswers from "./__fixtures__/next-answers.json";
import { createApp } from "./app";
import type { RouteEntry } from "./http/route-table";
import { canonicalUrlOf } from "./middleware/normalize-path";
import { call, listen, type Listening } from "./test-support/serve";

/**
 * The app's own answers (redirects, routing rules, security headers, OPTIONS, 405, 404, 500) against the bytes
 * Next sent for the same requests (`__fixtures__/next-answers.json`). Each comparison goes through the parity
 * harness's `diffCases` with its committed allow list, so the only differences that pass are the ones that list
 * names (Next's router `vary` values, the 404 page's markup and ETag).
 */

const ALLOW = allowJson as AllowEntry[];
const NEXT = nextAnswers as unknown as {
  notFound: StoredCase;
  routeThrew: StoredCase;
  malformedEscape: StoredCase;
  methodNotAllowed: StoredCase;
  options: StoredCase;
  routeGet: StoredCase;
  routeHead: StoredCase;
  paths: StoredCase[];
  served: StoredCase[];
  probedLocations: Record<string, string>;
};

/** The environment the captured Next answers were made with. */
const SITE = "http://127.0.0.1:3770";
const BUILD_ID = "baseline-3a41db6d";

/** The one path case whose Next answer the app does not repeat (see its test). */
const ESCAPED_LETTER = "/api/%76ersion";

const SECURITY_HEADERS = [
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "strict-transport-security",
];

const throwing: RouteEntry = {
  path: "/api/__parity-throw",
  source: "test",
  module: {
    GET: () => {
      throw new Error("thrown on purpose");
    },
  },
};
const param: RouteEntry = {
  path: "/api/__parity-param/:id",
  source: "test",
  module: { GET: async (_request, { params }) => Response.json(await params) },
};
const ownHead: RouteEntry = {
  path: "/api/__own-head",
  source: "test",
  module: {
    GET: () => new Response("get", { headers: { "x-answered-by": "GET" } }),
    HEAD: () => new Response(null, { headers: { "x-answered-by": "HEAD" } }),
  },
};
const handlerUriError: RouteEntry = {
  path: "/api/handler-uri-error",
  source: "test",
  module: {
    GET: () => {
      throw Object.assign(new URIError("the handler's own"), { status: 400 });
    },
  },
};

/** Errors a library raises before any route, each with a `status`. */
const libraryErrors: RequestHandler = (req, _res, next) => {
  if (req.url === "/library-error")
    next(Object.assign(new Error("payload too large"), { status: 413 }));
  else if (req.url === "/library-bad-request")
    next(Object.assign(new Error("bad"), { status: 400 }));
  else next();
};

let ready: { resolve(): void };
let server: Listening;
let gated: Listening;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.stubEnv("NEXT_PUBLIC_GTNH_BUILD_ID", BUILD_ID);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const options = {
    env: { production: true, siteUrl: SITE },
    publicDir: "/nonexistent",
    datasetsDir: "/nonexistent",
  };
  server = await listen(
    createApp({
      ...options,
      before: [libraryErrors],
      extraRoutes: [throwing, param, handlerUriError, ownHead],
      siteFilesDir: path.resolve(import.meta.dirname, "page/assets"),
    }),
  );
  const deferred = new Promise<void>((resolve) => {
    ready = { resolve };
  });
  gated = await listen(createApp({ ...options, ready: deferred }));
});

afterAll(async () => {
  await server.close();
  await gated.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The app's answer stored as the harness stores a case; `hashed` keeps the body as its sha256, as the fixture does. */
function stored(
  name: string,
  method: string,
  target: string,
  answer: RawAnswer,
  hashed = false,
): StoredCase {
  return {
    name,
    request: { method, target },
    status: answer.status,
    headers: answer.headers,
    body: hashed
      ? {
          sha256: createHash("sha256").update(answer.body).digest("hex"),
          length: answer.body.length,
        }
      : { text: answer.body.toString("utf8") },
  };
}

/** The differences between Next's answer and the app's to the same request that the allow list does not name. */
async function againstNext(next: StoredCase): Promise<unknown[]> {
  const { method, target } = next.request;
  const answer = await call(server.port, method, target);
  const hashed = next.body?.sha256 !== undefined;
  // Named for the comparison: the allow list's entries for the baseline-only fixtures must not apply here.
  return diffCases(
    { ...next, name: "pinned" },
    stored("pinned", method, target, answer, hashed),
    ALLOW,
  );
}

function header(answer: RawAnswer, name: string): string | undefined {
  return answer.headers.find(([key]) => key === name)?.[1];
}

describe("the app against Next's answers", () => {
  it("answers //, \\ and a trailing slash with Next's 308: Location, Refresh, the path as body, no security headers", async () => {
    const redirects = NEXT.paths.filter((next) => next.status === 308);
    expect(redirects.length).toBeGreaterThanOrEqual(8);
    for (const next of redirects) expect(await againstNext(next), next.request.target).toEqual([]);
    const answer = await call(server.port, "GET", "/datasets//gtnh/x");
    expect(answer.status).toBe(308);
    expect(header(answer, "location")).toBe("/datasets/gtnh/x");
    expect(header(answer, "refresh")).toBe("0;url=/datasets/gtnh/x");
    expect(answer.body.toString()).toBe("/datasets/gtnh/x");
    for (const name of [...SECURITY_HEADERS, "content-type"])
      expect(header(answer, name)).toBeUndefined();
  });

  it("resolves dot segments as Next does, in the 308 Location and before routing", async () => {
    for (const next of NEXT.paths.filter((c) => c.status !== 308)) {
      if (next.request.target === ESCAPED_LETTER) continue;
      expect(await againstNext(next), next.request.target).toEqual([]);
    }
    expect((await call(server.port, "GET", "/api/./version")).status).toBe(200);
    expect((await call(server.port, "GET", "/api/%2e/version")).status).toBe(200);
    expect((await call(server.port, "GET", "/api/x/../version")).status).toBe(200);
    expect(header(await call(server.port, "GET", "//api/./version"), "location")).toBe(
      "/api/version",
    );
  });

  /*
   * Next answered this one 404 with `cache-control: s-maxage=31536000`, the header of its prerendered pages (it
   * looked the decoded path up in its prerender cache). The app sends its 404's no-store for every unknown path;
   * nothing in front of the site caches, and Task 10's allow list names the difference.
   */
  it("leaves an escaped unreserved letter escaped, so /api/%76ersion is a 404 as in Next", async () => {
    const next = NEXT.paths.find((c) => c.request.target === ESCAPED_LETTER)!;
    expect(await againstNext(next)).toEqual([
      {
        field: "headers.cache-control",
        a: "s-maxage=31536000",
        b: "private, no-cache, no-store, max-age=0, must-revalidate",
      },
    ]);
  });

  it("re-encodes the path and re-serializes the query of a trailing-slash 308 as Next does", async () => {
    const targets = Object.keys(NEXT.probedLocations);
    expect(targets.length).toBeGreaterThan(20);
    for (const target of targets) {
      const answer = await call(server.port, "GET", target);
      expect(answer.status, target).toBe(308);
      expect(header(answer, "location"), target).toBe(NEXT.probedLocations[target]);
    }
  });

  it("answers a thrown route with Next's 500, byte for byte, and never a stack", async () => {
    expect(await againstNext(NEXT.routeThrew)).toEqual([]);
    const answer = await call(server.port, "GET", "/api/__parity-throw");
    expect(answer.body.length).toBe(0);
  });

  it("answers a malformed escape in a param as Next does", async () => {
    expect(await againstNext(NEXT.malformedEscape)).toEqual([]);
  });

  it("answers Next's 500 to a library error that carries a status, and Next's malformed-escape answer only to a decode error", async () => {
    for (const target of ["/library-error", "/library-bad-request", "/api/handler-uri-error"]) {
      const answer = await call(server.port, "GET", target);
      expect(
        diffCases(
          { ...NEXT.routeThrew, name: "pinned" },
          stored("pinned", "GET", target, answer),
          ALLOW,
        ),
        target,
      ).toEqual([]);
    }
  });

  it("answers 405 with no Allow and no body, and OPTIONS with 204 and the sorted Allow", async () => {
    expect(await againstNext(NEXT.methodNotAllowed)).toEqual([]);
    expect(await againstNext(NEXT.options)).toEqual([]);
    const deleted = await call(server.port, "DELETE", "/api/version");
    expect(deleted.status).toBe(405);
    expect(header(deleted, "allow")).toBeUndefined();
    expect(deleted.body.length).toBe(0);
  });

  it("answers a route as Next did, GET and HEAD", async () => {
    expect(await againstNext(NEXT.routeGet)).toEqual([]);
    expect(await againstNext(NEXT.routeHead)).toEqual([]);
  });

  /*
   * Next served these two from its prerender cache, and the cache shows on the wire: the force-static HiGHS route
   * answers every method with the GET answer and puts a year's s-maxage on a 404 that names no Cache-Control,
   * and the revalidating llms.txt (a site file now, answered from memory) answers any other method with the
   * cache's own 405.
   */
  it("answers the routes Next served from its cache as Next did, for every method", async () => {
    expect(NEXT.served.length).toBe(10);
    for (const next of NEXT.served) expect(await againstNext(next), next.name).toEqual([]);
  });

  it("answers an unknown path with Next's 404 status and headers", async () => {
    expect(await againstNext(NEXT.notFound)).toEqual([]);
    const answer = await call(server.port, "GET", "/no-such-page");
    expect(answer.body.toString()).toContain("404: This page could not be found.");
  });
});

describe("the app's routing rules", () => {
  it("redirects before the gate and the cross-site check", async () => {
    const logout = await call(server.port, "POST", "/api/community/auth/logout/", {
      origin: "https://evil.example",
    });
    expect(logout.status).toBe(308);
    expect(header(logout, "location")).toBe("/api/community/auth/logout");
    expect((await call(server.port, "GET", "/datasets/gtnh/v/recipes.json/")).status).toBe(308);
    expect((await call(server.port, "GET", "//datasets/gtnh/v/recipes.json")).status).toBe(308);
    // The gate and the guard are mounted: the same requests without the redirect's spelling are refused, and an
    // escape the gate refuses still takes the 308 first.
    const evil = { origin: "https://evil.example" };
    expect((await call(server.port, "POST", "/api/community/auth/logout", evil)).status).toBe(403);
    const escaped = await call(server.port, "GET", "/datasets/gtnh/v/recipes%2Ejson/");
    expect(escaped.status).toBe(308);
    expect(header(escaped, "location")).toBe("/datasets/gtnh/v/recipes%2Ejson");
    expect((await call(server.port, "GET", "/datasets/gtnh/v/recipes%2Ejson")).status).toBe(400);
  });

  it("checks cross-site writes on the canonical path, after the redirects", async () => {
    const evil = { origin: "https://evil.example" };
    for (const target of [
      "/x/../api/community/auth/logout",
      "/x/%2e%2e/api/community/auth/logout",
      "/api/./community/auth/logout",
    ]) {
      const answer = await call(server.port, "POST", target, evil);
      expect(answer.status, target).toBe(403);
      expect(JSON.parse(answer.body.toString()), target).toEqual({
        error: "Cross-site request refused.",
      });
    }
    const redirected = await call(server.port, "POST", "//x/../api/community/auth/logout", evil);
    expect(redirected.status).toBe(308);
    expect(header(redirected, "location")).toBe("/api/community/auth/logout");
  });

  it("logs a failed start once, however many requests it holds", async () => {
    const log = vi.mocked(console.error);
    log.mockClear();
    const failed = await listen(
      createApp({
        env: { production: true, siteUrl: SITE },
        publicDir: "/nonexistent",
        datasetsDir: "/nonexistent",
        ready: Promise.reject(new Error("prewarm failed")),
      }),
    );
    try {
      for (let index = 0; index < 3; index += 1) {
        const answer = await call(failed.port, "GET", "/api/version");
        expect(answer.status).toBe(500);
        expect(answer.body.length).toBe(0);
      }
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      await failed.close();
    }
  });

  it("refuses to read the canonical URL before canonicalPath has set it", () => {
    expect(() => canonicalUrlOf({})).toThrow(/before canonicalPath/);
    expect(canonicalUrlOf({ canonicalUrl: "/a?b" })).toBe("/a?b");
  });

  it("puts the security headers on a route answer, a 404, a 405, an OPTIONS and a 500", async () => {
    const answers = [
      await call(server.port, "GET", "/api/version"),
      await call(server.port, "GET", "/no-such-page"),
      await call(server.port, "PATCH", "/api/version"),
      await call(server.port, "OPTIONS", "/api/version"),
      await call(server.port, "GET", "/api/__parity-throw"),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([200, 404, 405, 204, 500]);
    for (const answer of answers) {
      for (const name of SECURITY_HEADERS) expect(header(answer, name), name).toBeDefined();
    }
  });

  it("answers a target the router cannot parse with the site's 404 and the security headers", async () => {
    for (const method of ["GET", "POST"]) {
      const answer = await call(server.port, method, "http://[/x");
      expect(answer.status, method).toBe(404);
      expect(header(answer, "content-type"), method).toMatch(/^text\/html/);
      for (const name of SECURITY_HEADERS) expect(header(answer, name), name).toBeDefined();
      expect(header(answer, "content-security-policy")).not.toBe("default-src 'none'");
      expect(answer.body.toString()).not.toContain("Cannot ");
    }
  });

  it("keeps an absolute-form target's redirect on this origin", async () => {
    for (const target of [
      "http://evil.example/x",
      "http://evil.example//x",
      "https://evil.example/x/",
      "http://evil.example",
    ]) {
      const answer = await call(server.port, "GET", target);
      expect(answer.status, target).toBe(308);
      const location = header(answer, "location")!;
      expect(location, target).toMatch(/^\/(?![/\\])/);
      expect(new URL(location, SITE).origin, target).toBe(SITE);
    }
  });

  it("is case-sensitive: /API/version is a 404", async () => {
    expect((await call(server.port, "GET", "/API/version")).status).toBe(404);
    expect((await call(server.port, "GET", "/api/Version")).status).toBe(404);
  });

  it("answers OPTIONS and any method on an unknown path with the 404", async () => {
    for (const method of ["OPTIONS", "DELETE", "POST"]) {
      expect((await call(server.port, method, "/api/no-such")).status, method).toBe(404);
    }
  });

  it("answers HEAD with the GET's headers and no body", async () => {
    const get = await call(server.port, "GET", "/api/version");
    const head = await call(server.port, "HEAD", "/api/version");
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    const names = (answer: RawAnswer) =>
      answer.headers
        .map(([name]) => name)
        .filter((name) => !["date", "transfer-encoding", "content-length"].includes(name));
    expect(names(head)).toEqual(names(get));
  });

  it("answers HEAD with a route's own HEAD export when it has one", async () => {
    const head = await call(server.port, "HEAD", "/api/__own-head");
    expect(head.status).toBe(200);
    expect(header(head, "x-answered-by")).toBe("HEAD");
    expect(header(await call(server.port, "GET", "/api/__own-head"), "x-answered-by")).toBe("GET");
  });

  it("sends no X-Powered-By and no ETag on a route answer", async () => {
    const answer = await call(server.port, "GET", "/api/version");
    expect(header(answer, "x-powered-by")).toBeUndefined();
    expect(header(answer, "etag")).toBeUndefined();
  });

  it("holds requests until ready resolves", async () => {
    let answered = false;
    const pending = call(gated.port, "GET", "/api/version").then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(answered).toBe(false);
    ready.resolve();
    expect((await pending).status).toBe(200);
  });

  it("reads req.rawTarget and req.originalUrl nowhere after canonicalPath", () => {
    const root = path.join(__dirname);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const relative = path.relative(root, file).split(path.sep).join("/");
          if (relative === "middleware/normalize-path.ts") continue;
          if (/rawTarget|originalUrl/.test(readFileSync(file, "utf8"))) offenders.push(relative);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("a development server's own middlewares", () => {
  /** Stands in for Vite's middlewares: it answers every request that reaches it. */
  const dev: RequestHandler = (_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain");
    res.end("dev");
  };
  let devServer: Listening;
  const EVIL = { host: "parity.example", origin: "https://evil.example" };

  beforeAll(async () => {
    devServer = await listen(
      createApp({
        env: { production: false, siteUrl: SITE },
        publicDir: "/nonexistent",
        datasetsDir: "/nonexistent",
        devMiddlewares: [dev],
      }),
    );
  });
  afterAll(() => devServer.close());

  it("run after the redirects, the security headers, the dataset gate and the cross-site check", async () => {
    const slashes = await call(devServer.port, "GET", "//main.tsx");
    expect(slashes.status).toBe(308);
    expect(header(slashes, "location")).toBe("/main.tsx");
    const trailing = await call(devServer.port, "GET", "/main.tsx/");
    expect(trailing.status).toBe(308);
    expect(header(trailing, "location")).toBe("/main.tsx");

    const served = await call(devServer.port, "GET", "/main.tsx");
    expect(served.body.toString()).toBe("dev");
    for (const name of SECURITY_HEADERS) expect(header(served, name), name).toBeDefined();
    expect(header(served, "content-security-policy")).toContain("'unsafe-eval'");

    const gated = await call(devServer.port, "GET", "/%64atasets/gtnh/v/recipes.json");
    expect(gated.status).toBe(400);
    expect(JSON.parse(gated.body.toString())).toEqual({ error: "Invalid dataset path." });

    const crossSite = await call(devServer.port, "POST", "/api/community/auth/logout", EVIL, "{}");
    expect(crossSite.status).toBe(403);
  });
});
