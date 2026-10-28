import { describe, expect, it } from "vitest";
import {
  compareHeads,
  headLeftover,
  htmlLang,
  metadataTags,
  pageScripts,
  shellMarkup,
} from "./head-compare.mjs";

const page = (name, status, text) => [
  name,
  { name, status, headers: [["content-type", "text/html; charset=utf-8"]], body: { text } },
];
const NEXT_HEAD =
  '<head><meta charSet="utf-8"/><link rel="stylesheet" href="<asset:a1>" data-precedence="next"/>' +
  '<script src="<asset:b2>" async=""></script><meta name="robots" content="noindex"/><title>Site</title>' +
  '<link rel="icon" href="/favicon.ico?favicon.abc.ico"/><meta name="next-size-adjust" content=""/></head>';
const NEXT_BODY =
  '<body class="m"><div hidden=""><!--$--><!--/$--></div><script>boot()</script><p>shell</p><!--$--><!--/$-->' +
  '<script id="_R_">chunks</script><script>(self.__next_f=self.__next_f||[]).push([0])</script></body>';
const EXPRESS =
  '<head><meta charSet="utf-8"/><link rel="stylesheet" href="<asset:c3>"><meta name="robots" content="noindex"/>' +
  '<title>Site</title><link rel="icon" href="/favicon.ico?favicon.def.ico"/></head>' +
  '<body class="m"><script>boot()</script><div id="root" style="display: contents"><p>shell</p></div></body>';

describe("head-compare", () => {
  it("compares the tags in order without the framework's, names the cache-buster, and the scripts apart", () => {
    expect(metadataTags(NEXT_HEAD + NEXT_BODY)).toEqual(metadataTags(EXPRESS));
    expect(metadataTags(EXPRESS)).toEqual([
      '<meta charSet="utf-8"/>',
      '<meta name="robots" content="noindex"/>',
      "<title>Site</title>",
      '<link rel="icon" href="/favicon.ico?favicon.<hash>"/>',
    ]);
    expect(pageScripts(NEXT_HEAD + NEXT_BODY)).toEqual(["<script>boot()</script>"]);
    expect(shellMarkup(NEXT_HEAD + NEXT_BODY)).toBe(shellMarkup(EXPRESS));
  });

  it("checks every HTML 404 besides the pages, and fails a missing tag, a changed script or other markup", () => {
    const next = new Map([page("gate /x", 404, NEXT_HEAD + NEXT_BODY)]);
    const same = new Map([page("gate /x", 404, EXPRESS)]);
    expect(compareHeads(next, same)).toMatchObject({ cases: 1, differences: [] });
    for (const broken of [
      EXPRESS.replace('<meta name="robots" content="noindex"/>', ""),
      EXPRESS.replace("boot()", "boot(1)"),
      EXPRESS.replace("<p>shell</p>", "<p>other</p>"),
    ]) {
      const { differences } = compareHeads(next, new Map([page("gate /x", 404, broken)]));
      expect(differences.length, broken).toBeGreaterThan(0);
    }
  });

  it("compares the document's language and fails any other markup left in the head", () => {
    const html = (lang, doc) => `<html lang="${lang}" class="h-full">${doc}`;
    expect(htmlLang(html("en", NEXT_HEAD + NEXT_BODY))).toBe("en");
    expect(htmlLang('<html id="__next_error__"><head></head>')).toBeUndefined();
    expect(headLeftover(NEXT_HEAD)).toBe("");
    const next = new Map([page("gate /x", 404, html("en", NEXT_HEAD + NEXT_BODY))]);
    expect(
      compareHeads(next, new Map([page("gate /x", 404, html("en", EXPRESS))])).differences,
    ).toEqual([]);
    const other = compareHeads(next, new Map([page("gate /x", 404, html("de", EXPRESS))]));
    expect(other.differences).toMatchObject([{ field: "lang", a: "en", b: "de" }]);
    for (const extra of [
      "<style>p{}</style>",
      '<base href="/x/">',
      "<noscript>x</noscript>",
      "text",
    ]) {
      const head = EXPRESS.replace("<title>", `${extra}<title>`);
      const found = compareHeads(next, new Map([page("gate /x", 404, html("en", head))]));
      expect(found.differences, extra).toMatchObject([{ field: "head", a: "" }]);
      // Even the same markup on both sides fails: nothing here reads it.
      const both = compareHeads(
        new Map([
          page(
            "gate /x",
            404,
            html("en", NEXT_HEAD.replace("<title>", `${extra}<title>`) + NEXT_BODY),
          ),
        ]),
        new Map([page("gate /x", 404, html("en", head))]),
      );
      expect(
        both.differences.map((d) => d.field),
        extra,
      ).toContain("head");
    }
  });

  it("reports the cases ruled to a plain 404 without failing them, when they are the site's own 404", () => {
    const next = new Map([page("site /dev/clean-card", 404, NEXT_HEAD + "<body></body>")]);
    const express = new Map([
      page("site /dev/clean-card", 404, EXPRESS),
      page("page /no-such-page", 404, EXPRESS),
    ]);
    const result = compareHeads(next, express);
    expect(result.differences.filter((d) => d.name === "site /dev/clean-card")).toEqual([]);
    expect(result.ruled.length).toBeGreaterThan(0);
  });

  it("fails a ruled case that is not the site's own 404, or has none to hold it to", () => {
    const next = new Map([page("site /dev/clean-card", 404, NEXT_HEAD + "<body></body>")]);
    for (const other of [
      EXPRESS.replace("<title>Site</title>", "<title>Other</title>"),
      EXPRESS.replace("<p>shell</p>", "<p>other</p>"),
      EXPRESS.replace("boot()", "boot(1)"),
    ]) {
      const express = new Map([
        page("site /dev/clean-card", 404, other),
        page("page /no-such-page", 404, EXPRESS),
      ]);
      const own = compareHeads(next, express).differences.filter(
        (d) => d.name === "site /dev/clean-card",
      );
      expect(own.length, other).toBeGreaterThan(0);
      expect(own.every((d) => d.field.startsWith("own 404 "))).toBe(true);
    }
    const alone = compareHeads(next, new Map([page("site /dev/clean-card", 404, EXPRESS)]));
    expect(alone.differences).toMatchObject([
      { name: "site /dev/clean-card", field: "own 404 case" },
    ]);
  });
});
