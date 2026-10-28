import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import allowJson from "../../tools/http-parity/allowed-differences.json";
import { diffCases, type AllowEntry, type StoredCase } from "../../tools/http-parity/compare.mjs";
import type { RawAnswer } from "../../tools/http-parity/requests.mjs";
import gateAnswers from "./__fixtures__/next-gate-answers.json";
import { createApp } from "./app";
import { resolveLikeSend } from "./middleware/static";
import { call, listen, type Listening } from "./test-support/serve";

/**
 * The static mounts against what Next's file handler sent (the parity captures of `public/`, the dataset tree and
 * `/_next/static`): cache headers, validators, content types, `Vary`, the answer to other methods, and the
 * refusals decided on the resolved file.
 */

const ALLOW = allowJson as AllowEntry[];
const NEXT = gateAnswers as unknown as { publicFileOptions: StoredCase };
const SITE = "http://127.0.0.1:3770";
const V = "v";
const MTIME = new Date("2026-10-26T19:50:31Z");

let root: string;
let server: Listening;

function put(file: string, content: string): void {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  utimesSync(full, MTIME, MTIME);
}

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  root = mkdtempSync(path.join(tmpdir(), "static-"));
  put("public/icon-192.png", "png bytes");
  put("public/highs.js", "var Module;");
  put("public/highs.wasm", "wasm bytes");
  put("public/site.webmanifest", "{}");
  put("public/.hidden", "dot file");
  put("public/datasets/gtnh/v/recipes.json", "raw");
  put("public/datasets/gtnh/datasets.manifest.json", '{"schemaVersion":1}');
  put("public/datasets/gtnh/v/textures/icon-report.json", "{}");
  put("public/datasets/gtnh/v/textures/atlas/atlas-0000.png", "atlas");
  put("client/assets/index-abc123.js", "export {};");
  put("client/assets/index-abc123.css", "body{}");
  server = await listen(
    createApp({
      env: { production: true, siteUrl: SITE },
      publicDir: path.join(root, "public"),
      datasetsDir: path.join(root, "public", "datasets", "gtnh"),
      clientDir: path.join(root, "client"),
    }),
  );
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function header(answer: RawAnswer, name: string): string | undefined {
  return answer.headers.find(([key]) => key === name)?.[1];
}

function headers(answer: RawAnswer, name: string): string[] {
  return answer.headers.filter(([key]) => key === name).map(([, value]) => value);
}

const WEAK_ETAG = /^W\/"[0-9a-f]+-[0-9a-f]+"$/;

describe("the static mounts", () => {
  it("serves /assets/* immutable for a year, public/ at max-age=0 with a weak ETag, and the manifest at max-age=0", async () => {
    const asset = await call(server.port, "GET", "/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(header(asset, "cache-control")).toBe("public, max-age=31536000, immutable");
    expect(header(asset, "etag")).toMatch(WEAK_ETAG);

    for (const target of ["/icon-192.png", "/datasets/gtnh/datasets.manifest.json"]) {
      const answer = await call(server.port, "GET", target);
      expect(answer.status, target).toBe(200);
      expect(header(answer, "cache-control"), target).toBe("public, max-age=0");
      expect(header(answer, "etag"), target).toMatch(WEAK_ETAG);
      expect(header(answer, "last-modified"), target).toBe(MTIME.toUTCString());
      expect(header(answer, "accept-ranges"), target).toBe("bytes");
      expect(header(answer, "x-content-type-options"), target).toBe("nosniff");
    }
  });

  it("types each file as Next did, and varies on the encoding only where Next's compression said so", async () => {
    const expected: [string, string, string | undefined][] = [
      ["/icon-192.png", "image/png", undefined],
      ["/highs.js", "application/javascript; charset=UTF-8", "Accept-Encoding"],
      ["/highs.wasm", "application/wasm", "Accept-Encoding"],
      ["/site.webmanifest", "application/manifest+json", "Accept-Encoding"],
      [
        "/datasets/gtnh/datasets.manifest.json",
        "application/json; charset=UTF-8",
        "Accept-Encoding",
      ],
      [
        "/datasets/gtnh/v/textures/icon-report.json",
        "application/json; charset=UTF-8",
        "Accept-Encoding",
      ],
      ["/datasets/gtnh/v/textures/atlas/atlas-0000.png", "image/png", undefined],
      ["/assets/index-abc123.js", "application/javascript; charset=UTF-8", "Accept-Encoding"],
      ["/assets/index-abc123.css", "text/css; charset=UTF-8", "Accept-Encoding"],
    ];
    for (const [target, type, vary] of expected) {
      for (const method of ["GET", "HEAD"]) {
        const answer = await call(server.port, method, target);
        expect(answer.status, `${method} ${target}`).toBe(200);
        expect(header(answer, "content-type"), `${method} ${target}`).toBe(type);
        expect(headers(answer, "vary"), `${method} ${target}`).toEqual(vary ? [vary] : []);
      }
    }
  });

  it("answers 304 to If-None-Match on a public file, with no type and no Vary", async () => {
    for (const target of ["/icon-192.png", "/datasets/gtnh/datasets.manifest.json"]) {
      const first = await call(server.port, "GET", target);
      const again = await call(server.port, "GET", target, {
        "if-none-match": header(first, "etag")!,
      });
      expect(again.status, target).toBe(304);
      expect(again.body.length).toBe(0);
      expect(header(again, "etag")).toBe(header(first, "etag"));
      expect(header(again, "content-type")).toBeUndefined();
      expect(header(again, "vary")).toBeUndefined();
    }
  });

  it("answers any other method on a served file as Next did, and passes the rest on", async () => {
    const answer = await call(server.port, "OPTIONS", "/icon-192.png");
    const stored: StoredCase = {
      name: "pinned",
      request: { method: "OPTIONS", target: "/icon-192.png" },
      status: answer.status,
      headers: answer.headers,
      body: { text: answer.body.toString("utf8") },
    };
    expect(diffCases({ ...NEXT.publicFileOptions, name: "pinned" }, stored, ALLOW)).toEqual([]);
    for (const [method, target] of [
      ["POST", "/highs.js"],
      ["DELETE", "/datasets/gtnh/datasets.manifest.json"],
      ["PUT", "/assets/index-abc123.js"],
    ]) {
      const other = await call(server.port, method, target, {}, "");
      expect(other.status, `${method} ${target}`).toBe(500);
      expect(headers(other, "allow")).toEqual(["GET", "HEAD"]);
    }
    for (const [method, target] of [
      ["OPTIONS", "/no-such-file.png"],
      ["POST", "/.hidden"],
      ["OPTIONS", "/datasets/gtnh/v/recipes.json"],
      ["OPTIONS", "/datasets/gtnh/v"],
    ]) {
      expect((await call(server.port, method, target)).status, `${method} ${target}`).not.toBe(500);
    }
  });

  it("answers a failed precondition or an unsatisfiable range as Next did: its 500, the file's other headers kept", async () => {
    for (const [extra, range] of [
      [{ range: "bytes=99999999-" }, `bytes */${"png bytes".length}`],
      [{ "if-match": '"nope"' }, undefined],
    ] as const) {
      const answer = await call(server.port, "GET", "/icon-192.png", { ...extra });
      expect(answer.status).toBe(500);
      expect(answer.body.toString()).toBe("Internal Server Error");
      expect(header(answer, "cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      expect(header(answer, "etag")).toBe('"66fci67lppl"');
      expect(header(answer, "content-type")).toBe("image/png");
      expect(header(answer, "content-range")).toBe(range);
      expect(header(answer, "last-modified")).toBe(MTIME.toUTCString());
      expect(header(answer, "x-content-type-options")).toBe("nosniff");
      expect(header(answer, "vary")).toBeUndefined();
    }
    const ranged = await call(server.port, "GET", "/icon-192.png", { range: "bytes=0-2" });
    expect(ranged.status).toBe(206);
    expect(ranged.body.toString()).toBe("png");
  });

  it("serves no dot file", async () => {
    expect((await call(server.port, "GET", "/.hidden")).status).toBe(404);
    expect((await call(server.port, "GET", "/%2ehidden")).status).toBe(404);
  });

  it("decides the public mount's refusal on the resolved file, not on the URL", async () => {
    for (const target of [
      "/datasets/gtnh/datasets.manifest.json",
      "/%2fdatasets/gtnh/datasets.manifest.json",
      "/%2Fdatasets/gtnh/datasets.manifest.json",
      "/x/..%2fdatasets/gtnh/datasets.manifest.json",
      "/DATASETS/gtnh/datasets.manifest.json",
      "/datasets/GTNH/datasets.manifest.json",
    ]) {
      const answer = await call(server.port, "GET", target);
      // Only the dataset tree's own mount, on the plain spelling, serves it.
      expect(answer.status, target).toBe(
        target === "/datasets/gtnh/datasets.manifest.json" ? 200 : 404,
      );
    }
    const publicDir = path.join(root, "public");
    expect(resolveLikeSend(publicDir, "/%2fdatasets/x")?.relative).toBe(path.join("datasets", "x"));
    expect(resolveLikeSend(publicDir, "/a/%2e%2e/datasets/x")?.relative).toBe(
      path.join("datasets", "x"),
    );
    expect(resolveLikeSend(publicDir, "/x/..%2f..%2fetc/passwd")).toBeUndefined();
    expect(resolveLikeSend(publicDir, "/%E0%A4%A")).toBeUndefined();
    expect(resolveLikeSend(publicDir, "/a%00b")).toBeUndefined();
  });

  it("falls through to the textures route when an atlas texture is missing", async () => {
    const answer = await call(
      server.port,
      "GET",
      `/datasets/gtnh/${V}/textures/atlas/missing-000000000000.png`,
    );
    expect(answer.status).toBe(404);
    expect(header(answer, "cache-control")).toBe("no-store");
    expect(JSON.parse(answer.body.toString())).toEqual({ error: "Texture not found." });
    expect(header(answer, "vary")).toBeUndefined();
  });
});
