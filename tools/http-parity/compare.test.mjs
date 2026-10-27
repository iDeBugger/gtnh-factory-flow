import { describe, expect, it } from "vitest";
import { diffCases } from "./compare.mjs";

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
    expect(diffCases(withHeaders([["connection", "close"]]), withHeaders([]), [])).toEqual([
      { field: "headers.connection", a: "close", b: undefined },
    ]);
  });

  it("reports a case only one side has", () => {
    expect(diffCases(stored(), undefined, [])).toEqual([
      { field: "case", a: "present", b: undefined },
    ]);
  });
});
