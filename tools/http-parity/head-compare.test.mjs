import { describe, expect, it } from "vitest";
import { compareHeads, metadataTags, pageScripts, shellMarkup } from "./head-compare.mjs";

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

  it("reports the cases ruled to a plain 404 without failing them", () => {
    const next = new Map([page("site /dev/clean-card", 404, NEXT_HEAD + "<body></body>")]);
    const result = compareHeads(next, new Map([page("site /dev/clean-card", 404, EXPRESS)]));
    expect(result.differences).toEqual([]);
    expect(result.ruled.length).toBeGreaterThan(0);
  });
});
