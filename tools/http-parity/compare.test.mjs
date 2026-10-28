import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { diffCases } from "./compare.mjs";

const ALLOW = JSON.parse(
  readFileSync(new URL("./allowed-differences.json", import.meta.url), "utf8"),
);

const stored = (overrides = {}) => ({
  name: "case",
  status: 200,
  headers: [["content-type", "application/json"]],
  body: { text: "{}" },
  ...overrides,
});
const withHeaders = (headers) =>
  stored({ headers: [["content-type", "application/json"], ...headers] });

describe("diffCases", () => {
  it("fails on a header only one side sent", () => {
    expect(diffCases(withHeaders([["refresh", "0;url=/a"]]), withHeaders([]), [])).toEqual([
      { field: "headers.refresh", a: "0;url=/a", b: undefined },
    ]);
  });

  it("fails on a header value difference the allow list does not name", () => {
    const allow = [{ case: "other", field: "headers.vary", reason: "x" }];
    expect(
      diffCases(withHeaders([["vary", "rsc"]]), withHeaders([["vary", "accept-encoding"]]), allow),
    ).toEqual([{ field: "headers.vary", a: "rsc", b: "accept-encoding" }]);
    expect(diffCases(stored({ status: 200 }), stored({ status: 404 }), [])).toEqual([
      { field: "status", a: 200, b: 404 },
    ]);
  });

  it("passes a difference the allow list names by case pattern and field", () => {
    const a = stored({
      name: "page /",
      headers: [["vary", "rsc, next-router-state-tree"]],
      body: { text: "<a>" },
    });
    const b = stored({ name: "page /", headers: [], body: { text: "<b>" } });
    expect(
      diffCases(a, b, [
        { case: "page .*", field: "headers.vary", a: "rsc, .*", reason: "framework vary" },
        { case: "page .*", field: "body*", reason: "framework markup" },
      ]),
    ).toEqual([]);
    // The value patterns limit an entry to the change it names.
    expect(
      diffCases(
        stored({ name: "page /", headers: [["vary", "accept-encoding"]] }),
        stored({ name: "page /", headers: [] }),
        [{ case: "page .*", field: "headers.vary", a: "rsc, .*", reason: "framework vary" }],
      ),
    ).toEqual([{ field: "headers.vary", a: "accept-encoding", b: undefined }]);
  });

  it("limits an entry to the status side A answered when it names one", () => {
    const page = (status, text) => stored({ name: "gate /x", status, headers: [], body: { text } });
    const allow = [{ case: ".*", status: 404, field: "body*", reason: "the 404 page" }];
    expect(diffCases(page(404, "<a>"), page(404, "<b>"), allow)).toEqual([]);
    expect(diffCases(page(200, "<a>"), page(200, "<b>"), allow)).toEqual([
      { field: "body", a: "<a>", b: "<b>" },
    ]);
  });

  it("ignores date and keep-alive, and checks the body length across content-length and chunked", () => {
    const a = withHeaders([
      ["date", "Tue, 27 Oct 2026 10:00:00 GMT"],
      ["keep-alive", "timeout=5"],
      ["content-length", "2"],
    ]);
    const b = withHeaders([
      ["date", "Wed, 28 Oct 2026 11:00:00 GMT"],
      ["transfer-encoding", "chunked"],
    ]);
    expect(diffCases(a, b, [])).toEqual([]);
    const hashed = (length) => stored({ body: { sha256: "ab", length } });
    expect(diffCases(hashed(10), hashed(11), [])).toEqual([{ field: "body.length", a: 10, b: 11 }]);
    const text = (bytes) => stored({ body: { text: "gtnh_session=<cookie:1>", bytes } });
    expect(diffCases(text(16), text(17), [])).toEqual([{ field: "body.length", a: 16, b: 17 }]);
    expect(diffCases(text(16), text(16), [])).toEqual([]);
    const unmeasured = stored({ body: { text: "gtnh_session=<cookie:1>" } });
    expect(diffCases(text(16), unmeasured, [])).toEqual([
      { field: "body.length", a: 16, b: "unmeasured" },
    ]);
    expect(diffCases(unmeasured, text(16), [])).toEqual([
      { field: "body.length", a: "unmeasured", b: 16 },
    ]);
    expect(diffCases(unmeasured, unmeasured, [])).toEqual([]);
    expect(diffCases(withHeaders([["connection", "close"]]), withHeaders([]), [])).toEqual([
      { field: "headers.connection", a: "close", b: undefined },
    ]);
  });

  it("reports a case only one side has", () => {
    expect(diffCases(stored(), undefined, [])).toEqual([
      { field: "case", a: "present", b: undefined },
    ]);
  });

  it("compares content-length and transfer-encoding as sent on HEAD, 204 and 304", () => {
    const head = (headers) =>
      stored({ request: { method: "HEAD", target: "/x" }, headers, body: { text: "" } });
    expect(
      diffCases(head([["content-length", "13175276"]]), head([["content-length", "0"]]), ALLOW),
    ).toEqual([{ field: "headers.content-length", a: "13175276", b: "0" }]);
    expect(
      diffCases(head([["content-length", "5"]]), head([["transfer-encoding", "chunked"]]), ALLOW),
    ).toEqual([
      { field: "headers.content-length", a: "5", b: undefined },
      { field: "headers.transfer-encoding", a: undefined, b: "chunked" },
    ]);
    const notModified = (headers) => stored({ status: 304, headers, body: { text: "" } });
    expect(diffCases(notModified([["content-length", "5"]]), notModified([]), ALLOW)).toEqual([
      { field: "headers.content-length", a: "5", b: undefined },
    ]);
  });

  it("never allows a case that failed or was skipped, on either side or both", () => {
    const failed = stored({ status: -1, headers: [], body: { text: "<failed: timeout>" } });
    expect(diffCases(failed, failed, [{ case: ".*", field: "*", reason: "x" }])).toEqual([
      { field: "capture", a: "<failed: timeout>" },
      { field: "capture", b: "<failed: timeout>" },
    ]);
  });

  it("reports the body once when it differs, its length only when the bodies match", () => {
    expect(
      diffCases(stored({ body: { text: "ab" } }), stored({ body: { text: "abc" } }), []),
    ).toEqual([{ field: "body", a: "ab", b: "abc" }]);
  });

  it("joins repeated field lines with a comma, as one line, and keeps Set-Cookie lines apart", () => {
    const vary = withHeaders([
      ["vary", "rsc"],
      ["vary", "Accept-Encoding"],
    ]);
    expect(diffCases(vary, withHeaders([["vary", "rsc, Accept-Encoding"]]), [])).toEqual([]);
    expect(diffCases(vary, withHeaders([["vary", "Accept-Encoding, rsc"]]), [])).toHaveLength(1);
    const cookies = withHeaders([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    expect(diffCases(cookies, withHeaders([["set-cookie", "a=1, b=2"]]), [])).toEqual([
      { field: "headers.set-cookie", a: "a=1\nb=2", b: "a=1, b=2" },
    ]);
  });

  it("keeps a single-value header sent twice apart from one line holding a comma", () => {
    for (const [name, one, two] of [
      ["location", "/?plan=a, b", ["/?plan=a", "b"]],
      ["content-type", "text/html, text/plain", ["text/html", "text/plain"]],
      ["content-disposition", 'attachment; filename="a, b"', ['attachment; filename="a', ' b"']],
    ]) {
      const twice = stored({ headers: two.map((value) => [name, value]) });
      expect(diffCases(stored({ headers: [[name, one]] }), twice, []), name).toEqual([
        { field: `headers.${name}`, a: one, b: two.join("\n") },
      ]);
    }
  });

  describe("the committed allow list", () => {
    const NEXT_CSP =
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:3770 http://127.0.0.1:25640; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'self'";
    const EXPRESS_CSP = NEXT_CSP.replace(
      "'unsafe-inline' 'wasm",
      "'sha256-AAAA' 'sha256-BB/+=' 'wasm",
    );
    const csp = (value) =>
      stored({ name: "page /", headers: [["content-security-policy", value]] });

    it("allows the CSP's script hashes in place of 'unsafe-inline', and nothing else", () => {
      expect(diffCases(csp(NEXT_CSP), csp(EXPRESS_CSP), ALLOW)).toEqual([]);
      for (const broken of [
        EXPRESS_CSP.replace(" 'wasm-unsafe-eval'", ""),
        EXPRESS_CSP.replace(" http://127.0.0.1:25640", ""),
        EXPRESS_CSP.replace("; frame-ancestors 'self'", ""),
        EXPRESS_CSP.replace("style-src 'self' 'unsafe-inline'", "style-src 'self'"),
        NEXT_CSP.replace("'unsafe-inline' 'wasm", "'wasm"),
      ]) {
        expect(diffCases(csp(NEXT_CSP), csp(broken), ALLOW), broken).toHaveLength(1);
      }
    });

    it("keeps Accept-Encoding in vary where Next sent it", () => {
      const vary = (value) => stored({ headers: value === undefined ? [] : [["vary", value]] });
      const router =
        "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch";
      expect(diffCases(vary(`${router}, Accept-Encoding`), vary("Accept-Encoding"), ALLOW)).toEqual(
        [],
      );
      expect(diffCases(vary(router), vary(undefined), ALLOW)).toEqual([]);
      expect(diffCases(vary(`${router}, Accept-Encoding`), vary(undefined), ALLOW)).toHaveLength(1);
      expect(diffCases(vary(router), vary("Accept-Encoding"), ALLOW)).toHaveLength(1);
    });

    it("lets only the default font keep its preload in Link", () => {
      const font = (hash) =>
        `<<asset:${hash}>>; rel=preload; as="font"; crossorigin=""; type="font/woff2"`;
      const style = '<<asset:5151aaaa>>; rel=preload; as="style"';
      const link = (...items) => stored({ name: "page /", headers: [["link", items.join(", ")]] });
      const next = link(font("1e06740a"), font("c9407645"), style, font("50841fc9"));
      expect(diffCases(next, link(font("c9407645"), style), ALLOW)).toEqual([]);
      expect(diffCases(next, link(font("c9407645")), ALLOW)).toHaveLength(1);
      expect(diffCases(next, link(font("1e06740a"), style), ALLOW)).toHaveLength(1);
      expect(diffCases(next, link(font("c9407645"), font("1e06740a"), style), ALLOW)).toHaveLength(
        1,
      );
    });

    it("takes the stylesheet preloads out of the /community 307's Link only", () => {
      const font = (hash) =>
        `<<asset:${hash}>>; rel=preload; as="font"; crossorigin=""; type="font/woff2"`;
      const style = '<<asset:401f8660>>; rel=preload; as="style"';
      const answer = (name, status, ...items) =>
        stored({ name, status, headers: [["link", items.join(", ")]] });
      const express = (name, status = 307) => answer(name, status, font("c9407645"));
      for (const name of [
        "page /community",
        "page /community?plan=x",
        "scenario page /community?plan=",
      ]) {
        const next = answer(name, 307, font("1e06740a"), font("c9407645"), style);
        expect(diffCases(next, express(name), ALLOW), name).toEqual([]);
        expect(diffCases(next, answer(name, 307), ALLOW), name).toHaveLength(1);
      }
      const page = answer("page /", 200, font("c9407645"), style);
      expect(diffCases(page, express("page /", 200), ALLOW)).toHaveLength(1);
    });

    it("allows the year of shared caching only on the 404s Next served from its cache", () => {
      const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";
      const cached = (name, status, value) =>
        stored({ name, status, headers: [["cache-control", value]] });
      for (const name of [
        "page /community",
        "page /community?plan=x",
        "site /dev/clean-card",
        "spelling /api/%76ersion",
      ]) {
        expect(
          diffCases(cached(name, 404, "s-maxage=31536000"), cached(name, 404, NO_STORE), ALLOW),
          name,
        ).toEqual([]);
        expect(
          diffCases(cached(name, 200, "s-maxage=31536000"), cached(name, 200, NO_STORE), ALLOW),
          name,
        ).toHaveLength(1);
      }
      expect(
        diffCases(
          cached("route GET /api/version", 404, "s-maxage=31536000"),
          cached("route GET /api/version", 404, NO_STORE),
          ALLOW,
        ),
      ).toHaveLength(1);
    });

    it("allows Connection: close only on the two over-cap uploads' 413", () => {
      const connection = (name, value, status = 413) =>
        stored({ name, status, headers: [["connection", value]] });
      for (const name of ["cap login 17 KiB chunked", "cap board image 6 MiB"]) {
        expect(diffCases(connection(name, "keep-alive"), connection(name, "close"), ALLOW)).toEqual(
          [],
        );
        // A cap that stopped answering 413 is no unread body: its close is a difference.
        for (const status of [200, 400]) {
          expect(
            diffCases(
              connection(name, "keep-alive", status),
              connection(name, "close", status),
              ALLOW,
            ),
          ).toHaveLength(1);
        }
      }
      const length = "cap login 17 KiB Content-Length";
      expect(
        diffCases(connection(length, "keep-alive"), connection(length, "close"), ALLOW),
      ).toHaveLength(1);
    });

    it("allows the 404 page's body under either doctype casing, and the /community 307's body only", () => {
      const page = (name, status, text, headers = []) =>
        stored({ name, status, headers, body: { text } });
      expect(
        diffCases(
          page("gate /DATASETS/x", 404, "<!DOCTYPE html><a>"),
          page("gate /DATASETS/x", 404, "<!doctype html><bb>"),
          ALLOW,
        ),
      ).toEqual([]);
      const next = page("page /community", 307, "<!DOCTYPE html><x>", [["location", "/"]]);
      expect(diffCases(next, page("page /community", 307, "", [["location", "/"]]), ALLOW)).toEqual(
        [],
      );
      expect(
        diffCases(next, page("page /community", 307, "", [["location", "/x"]]), ALLOW),
      ).toHaveLength(1);
    });
  });
});
