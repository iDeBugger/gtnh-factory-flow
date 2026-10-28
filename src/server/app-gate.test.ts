import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import allowJson from "../../tools/http-parity/allowed-differences.json";
import { diffCases, type AllowEntry, type StoredCase } from "../../tools/http-parity/compare.mjs";
import type { RawAnswer } from "../../tools/http-parity/requests.mjs";
import {
  extraGateCases,
  harnessGateCases,
  type GateCase,
} from "../test-support/dataset-gate-cases";
import gateAnswers from "./__fixtures__/next-gate-answers.json";
import { createApp } from "./app";
import type { RouteEntry } from "./http/route-table";
import { call, listen, type Listening } from "./test-support/serve";

/**
 * What Next's proxy did, on the Express app over a raw socket: the dataset path gate on every spelling of a
 * dataset path (src/test-support/dataset-gate-cases.ts), the public mounts that never serve the data, and the
 * cross-site write check on the canonical path. Answers Next gave are compared with the captured bytes
 * (`__fixtures__/next-gate-answers.json`) through the parity harness's `diffCases` and its allow list.
 */

const ALLOW = allowJson as AllowEntry[];
const NEXT = gateAnswers as unknown as {
  gateRefused: StoredCase;
  crossSite: StoredCase[];
};

const SITE = "http://127.0.0.1:3770";
const V = "v";
const RAW_RECIPES = "the raw recipes file, never served";
const INDEX_GZIP = "an index gzip, served only by the dataset-files route";
const ORACLE_REPORT = '{"report":true}';
const ATLAS_TEXTURE = "an atlas texture";

/** The paths the dataset-files route and the URL probe saw, in order. */
const routed: string[] = [];
const seenUrls: string[] = [];

const stubs: RouteEntry[] = [
  {
    path: "/dataset-files/:versionId/*assetPath",
    source: "test",
    module: {
      GET: (request) => {
        const url = new URL(request.url);
        routed.push(url.pathname + url.search);
        return new Response("routed", { headers: { "content-type": "text/plain" } });
      },
    },
  },
  {
    path: "/api/t/url",
    source: "test",
    module: {
      GET: (request) => {
        seenUrls.push(request.url);
        return Response.json({ ok: true });
      },
    },
  },
];

let publicDir: string;
let server: Listening;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.spyOn(console, "error").mockImplementation(() => {});
  publicDir = mkdtempSync(path.join(tmpdir(), "app-gate-"));
  const version = path.join(publicDir, "datasets", "gtnh", V);
  mkdirSync(path.join(version, "oracle"), { recursive: true });
  mkdirSync(path.join(version, "textures", "atlas"), { recursive: true });
  writeFileSync(path.join(version, "recipes.json"), RAW_RECIPES);
  writeFileSync(path.join(version, "recipe-lookup-index.json.gz"), INDEX_GZIP);
  writeFileSync(path.join(version, "oracle", "oracle-report.json"), ORACLE_REPORT);
  writeFileSync(path.join(version, "textures", "atlas", "a.png"), ATLAS_TEXTURE);
  server = await listen(
    createApp({
      env: { production: true, siteUrl: SITE },
      publicDir,
      datasetsDir: path.join(publicDir, "datasets", "gtnh"),
      extraRoutes: stubs,
    }),
  );
});

afterAll(async () => {
  await server.close();
  rmSync(publicDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function header(answer: RawAnswer, name: string): string | undefined {
  return answer.headers.find(([key]) => key === name)?.[1];
}

/** The app's answer stored as the harness stores a case, under the name the comparison uses. */
function stored(method: string, target: string, answer: RawAnswer): StoredCase {
  return {
    name: "pinned",
    request: { method, target },
    status: answer.status,
    headers: answer.headers,
    body: { text: answer.body.toString("utf8") },
  };
}

/** The differences from Next's captured answer that the allow list does not name. */
function againstNext(next: StoredCase, method: string, target: string, answer: RawAnswer) {
  return diffCases({ ...next, name: "pinned" }, stored(method, target, answer), ALLOW);
}

async function routedPathFor(target: string): Promise<string | undefined> {
  const before = routed.length;
  const answer = await call(server.port, "GET", target);
  expect(answer.status, target).toBe(200);
  expect(answer.body.toString(), target).toBe("routed");
  return routed.length > before ? routed.at(-1) : undefined;
}

const CASES: GateCase[] = [...harnessGateCases(V), ...extraGateCases(V)];
const kind = (name: GateCase["answer"]["kind"]) => CASES.filter((c) => c.answer.kind === name);

describe("the dataset path gate", () => {
  it.each(kind("refuse").map((c) => c.target))(
    "refuses %s with 400 and no-store, as Next's proxy did",
    async (target) => {
      const answer = await call(server.port, "GET", target);
      expect(answer.status).toBe(400);
      expect(header(answer, "cache-control")).toBe("no-store");
      expect(JSON.parse(answer.body.toString())).toEqual({ error: "Invalid dataset path." });
      expect(againstNext(NEXT.gateRefused, "GET", target, answer)).toEqual([]);
    },
  );

  it.each(kind("rewrite").map((c) => [c.target, (c.answer as { routed: string }).routed] as const))(
    "sends %s to the dataset-files route at %s",
    async (target, path) => {
      expect(await routedPathFor(target)).toBe(path);
    },
  );

  it("names the rewritten path on the answer and keeps the query, as Next's proxy did", async () => {
    const answer = await call(server.port, "GET", `/datasets/gtnh/${V}/recipes.json.gz?a=1&b`);
    expect(header(answer, "x-middleware-rewrite")).toBe(`/dataset-files/${V}/recipes.json.gz`);
    expect(routed.at(-1)).toBe(`/dataset-files/${V}/recipes.json.gz?a=1&b`);
  });

  it.each(
    kind("redirect").map((c) => [c.target, (c.answer as { location: string }).location] as const),
  )("answers %s with Next's 308 to %s before the gate", async (target, location) => {
    const answer = await call(server.port, "GET", target);
    expect(answer.status).toBe(308);
    expect(header(answer, "location")).toBe(location);
  });

  it.each(kind("notFound").map((c) => c.target))("answers %s with the 404", async (target) => {
    expect((await call(server.port, "GET", target)).status).toBe(404);
  });

  it("serves a file beside the data from the public dataset tree", async () => {
    for (const { target } of kind("public")) {
      const answer = await call(server.port, "GET", target);
      expect(answer.status, target).toBe(200);
      expect(answer.body.toString(), target).toBe(ORACLE_REPORT);
    }
  });

  it("passes a plain dataset-files path to its route as sent", async () => {
    for (const { target } of kind("route")) expect(await routedPathFor(target)).toBe(target);
  });

  it("leaves a target that does not start with a slash to Node's 400", async () => {
    for (const { target } of kind("badRequest")) {
      const answer = await call(server.port, "GET", target);
      expect(answer.status, target).toBe(400);
      expect(answer.body.length).toBe(0);
    }
  });

  it("sends a dot-segment spelling of an index gzip to the dataset-files route, as Next's proxy did", async () => {
    expect(await routedPathFor(`/datasets/gtnh/${V}/x/../recipe-lookup-index.json.gz`)).toBe(
      `/dataset-files/${V}/recipe-lookup-index.json.gz`,
    );
    expect(await routedPathFor(`/datasets/gtnh/${V}/%2e/recipe-lookup-index.json.gz`)).toBe(
      `/dataset-files/${V}/recipe-lookup-index.json.gz`,
    );
  });

  it("never serves a dataset file through the public mount, under any spelling", async () => {
    const targets = [
      `/datasets/gtnh/${V}/recipes.json`,
      `/datasets/gtnh/${V}/RECIPES.JSON`,
      `/DATASETS/gtnh/${V}/recipes.json`,
      `/datasets/GTNH/${V}/recipes.json`,
      `/Datasets/gtnh/${V}/Recipes.Json`,
      `/datasets/gtnh/${V}/recipes%2Ejson`,
      `/%2fdatasets/gtnh/${V}/recipes.json`,
      `/%2Fdatasets/gtnh/${V}/recipe-lookup-index.json.gz`,
      `/x/..%2fdatasets/gtnh/${V}/recipes.json`,
      `/x/..%2Fdatasets/gtnh/${V}/recipe-lookup-index.json.gz`,
      `/datasets/gtnh/${V}/%2e/recipes.json`,
      `/datasets/gtnh/${V}/./recipes.json`,
      `/datasets/gtnh/${V}/RECIPE-LOOKUP-INDEX.JSON.GZ`,
      `/%64atasets/gtnh/${V}/recipes.json`,
    ];
    for (const target of targets) {
      for (const method of ["GET", "HEAD"]) {
        const answer = await call(server.port, method, target);
        const body = answer.body.toString();
        expect(body, `${method} ${target}`).not.toBe(RAW_RECIPES);
        expect(body, `${method} ${target}`).not.toBe(INDEX_GZIP);
        // A HEAD that reached a file would name its length.
        for (const file of [RAW_RECIPES, INDEX_GZIP]) {
          expect(header(answer, "content-length"), `${method} ${target}`).not.toBe(
            String(file.length),
          );
        }
      }
    }
  });

  it("hands the handler and the dataset mount the canonical URL, not the raw one", async () => {
    const texture = await call(server.port, "GET", `/datasets/gtnh/${V}/textures/atlas/x/../a.png`);
    expect(texture.status).toBe(200);
    expect(texture.body.toString()).toBe(ATLAS_TEXTURE);
    await call(server.port, "GET", "/x/../api/t/url?q=1");
    await call(server.port, "GET", "/api/%2e/t/url");
    expect(seenUrls.slice(-2)).toEqual([`${SITE}/api/t/url?q=1`, `${SITE}/api/t/url`]);
  });
});

describe("the cross-site write check", () => {
  const EVIL = { host: "parity.example", origin: "https://evil.example" };

  function requestHeaders(name: string): Record<string, string> {
    if (name === "cross-site Sec-Fetch-Site")
      return { host: "parity.example", "sec-fetch-site": "cross-site" };
    if (name === "same-site Origin")
      return { host: "parity.example", origin: "https://parity.example" };
    return EVIL;
  }

  it("answers every cross-site case Next's proxy answered, as Next did", async () => {
    expect(NEXT.crossSite.length).toBe(8);
    for (const next of NEXT.crossSite) {
      const { method, target } = next.request;
      const answer = await call(server.port, method, target, requestHeaders(next.name), "{}");
      expect(answer.status, next.name).toBe(next.status);
      if (next.name === "same-site Origin") continue;
      expect(againstNext(next, method, target, answer), next.name).toEqual([]);
    }
  });

  it("refuses a cross-site write to the API, and passes the same write from the site's origin or with no Origin", async () => {
    const logout = "/api/community/auth/logout";
    const refused = await call(server.port, "POST", logout, EVIL, "{}");
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body.toString())).toEqual({ error: "Cross-site request refused." });
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      expect((await call(server.port, method, logout, EVIL, "{}")).status, method).toBe(403);
    }
    const sameSite = await call(
      server.port,
      "POST",
      logout,
      { host: "parity.example", origin: "https://parity.example" },
      "{}",
    );
    expect(sameSite.status).toBe(200);
    expect((await call(server.port, "POST", logout, { host: "parity.example" }, "{}")).status).toBe(
      200,
    );
    expect((await call(server.port, "GET", "/api/version", EVIL)).status).toBe(200);
    expect((await call(server.port, "POST", "/no-such-page", EVIL, "{}")).status).toBe(404);
  });

  it("answers a cross-site write to /API/ with 404 and to //api/ with 308, so no route sees it", async () => {
    expect((await call(server.port, "POST", "/API/community/auth/logout", EVIL, "{}")).status).toBe(
      404,
    );
    const redirected = await call(server.port, "POST", "//api/community/auth/logout", EVIL, "{}");
    expect(redirected.status).toBe(308);
    expect(header(redirected, "location")).toBe("/api/community/auth/logout");
  });

  it("refuses a cross-site write under a dot-segment spelling of /api/, as Next's proxy did", async () => {
    const pinned = NEXT.crossSite.find(
      (c) => c.name === "cross-site /x/../api/community/auth/logout",
    )!;
    for (const target of [
      "/x/../api/community/auth/logout",
      "/x/%2e%2e/api/community/auth/logout",
      "/x/%2E%2E/api/community/auth/logout",
      "/api/x/../community/auth/logout",
    ]) {
      const answer = await call(server.port, "POST", target, EVIL, "{}");
      expect(againstNext(pinned, "POST", target, answer), target).toEqual([]);
    }
  });
});
