import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  assetUrls,
  createNormalizeState,
  normalizeCase,
  normalizeText,
  sha256,
} from "./normalize.mjs";

const json = (value) => ({
  status: 200,
  headers: [["content-type", "application/json"]],
  body: Buffer.from(JSON.stringify(value)),
});

describe("normalizeText and normalizeCase", () => {
  it("numbers UUIDs by first appearance so two runs compare equal", () => {
    const run = (first, second) => {
      const state = createNormalizeState();
      return [
        normalizeCase(json({ id: first, other: second }), {
          name: "a",
          request: { target: "/api/x" },
          state,
        }),
        normalizeCase(json({ again: first }), { name: "b", request: { target: "/api/y" }, state }),
      ];
    };
    const one = run("6f1c2d3e-0000-4000-8000-000000000001", "6f1c2d3e-0000-4000-8000-000000000002");
    const two = run("0a0b0c0d-1111-4111-8111-111111111111", "0a0b0c0d-2222-4222-8222-222222222222");
    expect(one).toEqual(two);
    expect(one[0].body.text).toBe('{"id":"<uuid:1>","other":"<uuid:2>"}');
    expect(one[1].body.text).toBe('{"again":"<uuid:1>"}');
  });

  it("replaces timestamps, session cookies and board image names", () => {
    const state = createNormalizeState();
    expect(
      normalizeText("2026-10-25T17:33:50.431+00:00 and Tue, 27 Oct 2026 10:00:00 GMT", state),
    ).toBe("<time> and <time>");
    expect(normalizeText("gtnh_session=abc.def; Path=/", state)).toBe(
      "gtnh_session=<cookie:1>; Path=/",
    );
    expect(normalizeText("gtnh_session=; Max-Age=0", state)).toBe("gtnh_session=; Max-Age=0");
    expect(normalizeText("/api/community/images/2026-10/0123456789abcdef01.png", state)).toBe(
      "/api/community/images/<month>/<image:1>.png",
    );
    const answer = normalizeCase(
      {
        status: 429,
        headers: [
          ["Retry-After", "37"],
          ["Set-Cookie", "gtnh_session=zz; Path=/"],
        ],
        body: Buffer.alloc(0),
      },
      { name: "c", request: { target: "/api/x" }, state },
    );
    expect(answer.headers).toEqual([
      ["retry-after", "<seconds>"],
      ["set-cookie", "gtnh_session=<cookie:2>; Path=/"],
    ]);
  });

  it("keeps a dataset answer byte for byte", () => {
    const value = {
      id: "6f1c2d3e-0000-4000-8000-000000000001",
      at: "2026-10-25T17:33:50.431Z",
      url: "/_next/static/media/x.woff2",
    };
    for (const target of [
      "/api/datasets/v/catalog",
      "/datasets/gtnh/v/x.json",
      "/dataset-files/v/client/a.json",
    ]) {
      const stored = normalizeCase(json(value), {
        name: "d",
        request: { target },
        state: createNormalizeState(),
      });
      expect(stored.body.text).toBe(JSON.stringify(value));
    }
  });

  it("dates a server-written client file by nothing, every other file by its mtime", () => {
    const file = (target) =>
      normalizeCase(
        {
          status: 200,
          headers: [["last-modified", "Tue, 27 Oct 2026 18:30:31 GMT"]],
          body: Buffer.from("x"),
        },
        { name: "f", request: { target }, state: createNormalizeState() },
      ).headers;
    expect(file("/datasets/gtnh/v/client/catalog.0123456789abcdef0123.json")).toEqual([
      ["last-modified", "<time>"],
    ]);
    expect(file("/datasets/gtnh/v/recipe-lookup-index.json.gz")).toEqual([
      ["last-modified", "Tue, 27 Oct 2026 18:30:31 GMT"],
    ]);
  });

  it("names an asset by its bytes, so /_next/static/media/x.woff2 and /assets/y.woff2 of the same file are equal", () => {
    const font = Buffer.from("the same font bytes");
    const other = Buffer.from("another font");
    const html = (url) => ({
      status: 200,
      headers: [
        ["content-type", "text/html; charset=utf-8"],
        ["link", `<${url}>; rel=preload; as="font"`],
      ],
      body: Buffer.from(`<link rel="preload" href="${url}"/>`),
    });
    const next = "/_next/static/media/x.woff2";
    const vite = "/assets/y.woff2";
    expect(assetUrls(html(next).body.toString())).toEqual([next]);
    const capture = (url, bytes) =>
      normalizeCase(html(url), {
        name: "page",
        request: { target: "/" },
        state: createNormalizeState(),
        assetHashes: new Map([[url, sha256(bytes)]]),
      });
    expect(capture(next, font)).toEqual(capture(vite, font));
    expect(capture(next, font)).not.toEqual(capture(vite, other));
  });

  it("stores a large or binary body by hash, a PNG with its pixels", () => {
    const png = new PNG({ width: 2, height: 1 });
    png.data.fill(200);
    const bytes = PNG.sync.write(png);
    const stored = normalizeCase(
      { status: 200, headers: [["content-type", "image/png"]], body: bytes },
      { name: "png", request: { target: "/icon.png" }, state: createNormalizeState() },
    );
    expect(stored.body.sha256).toBe(sha256(bytes));
    expect(stored.body.length).toBe(bytes.length);
    expect(stored.body.pixels).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replaces a Retry-After count of seconds only, keeping any other form", () => {
    const retry = (value) =>
      normalizeCase(
        { status: 429, headers: [["retry-after", value]], body: Buffer.alloc(0) },
        { name: "r", request: { target: "/api/x" }, state: createNormalizeState() },
      ).headers[0][1];
    expect(retry("37")).toBe("<seconds>");
    expect(retry("Wed, 21 Oct 2026 07:28:00 GMT")).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(retry("1.5")).toBe("1.5");
  });

  it("stores a body that does not decode back to its bytes by hash, not as text", () => {
    const latin1 = Buffer.from('{"error":"caf\xe9"}', "latin1");
    const stored = normalizeCase(
      { status: 400, headers: [["content-type", "application/json"]], body: latin1 },
      { name: "l", request: { target: "/api/x" }, state: createNormalizeState() },
    );
    expect(stored.body).toEqual({ sha256: sha256(latin1), length: latin1.length });
  });

  it("normalizes the 404 page under a dataset path like any page, whatever the path's case", () => {
    const page = {
      status: 404,
      headers: [
        ["content-type", "text/html; charset=utf-8"],
        ["etag", '"abc"'],
      ],
      body: Buffer.from('<!DOCTYPE html><script src="/_next/static/chunks/a.js"></script>'),
    };
    for (const target of ["/DATASETS/gtnh/v/recipes.json", "/datasets/gtnh/v/RECIPES.JSON"]) {
      const stored = normalizeCase(page, {
        name: "g",
        request: { target },
        state: createNormalizeState(),
        assetHashes: new Map([["/_next/static/chunks/a.js", "f".repeat(64)]]),
      });
      expect(stored.body.text).toBe('<!DOCTYPE html><script src="<asset:ffffffff>"></script>');
      expect(stored.headers).toContainEqual(["etag", "<etag>"]);
    }
  });
});
