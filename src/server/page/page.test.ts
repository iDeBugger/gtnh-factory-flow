import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRow } from "@/lib/server/community-rows";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import allowJson from "../../../tools/http-parity/allowed-differences.json";
import {
  diffCases,
  type AllowEntry,
  type StoredCase,
} from "../../../tools/http-parity/compare.mjs";
import {
  metadataTags as harnessTags,
  shellMarkup,
} from "../../../tools/http-parity/head-compare.mjs";
import type { RawAnswer } from "../../../tools/http-parity/requests.mjs";
import { documentPolicy } from "@/lib/server/http/security-headers";
import nextAnswers from "../__fixtures__/next-answers.json";
import pageAnswers from "../__fixtures__/next-page-answers.json";
import express from "express";
import { createApp } from "../app";
import { call, listen, type Listening } from "../test-support/serve";
import { NOT_FOUND_BODY, renderNotFoundPage } from "./not-found-page";
import { SITE_FILE_TTL_MS, siteRoutes } from "./site-routes";
import { loadPageTemplate, renderPage, type PageTemplate } from "./template";

const getPublicPlanRow = vi.fn<(id: string) => Promise<PlanRow | undefined>>();
vi.mock("@/lib/server/services/plan-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/services/plan-preview")>()),
  getPublicPlanRow: (id: string) => getPublicPlanRow(id),
}));

const loads = { sitemap: 0, llms: 0 };
vi.mock("@/lib/server/site/site-files", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/server/site/site-files")>();
  return {
    ...original,
    sitemapEntries: () => {
      loads.sitemap += 1;
      return original.sitemapEntries();
    },
    llmsText: () => {
      loads.llms += 1;
      return original.llmsText();
    },
  };
});

/**
 * The page on Express against Next: `/` with its head per request, `/community`, the site files and the
 * document policy, each answer diffed against what Next sent (`__fixtures__/next-page-answers.json`, from the
 * parity captures) through the harness's `diffCases` and its allow list.
 */

const ALLOW = allowJson as AllowEntry[];
const NEXT = pageAnswers as unknown as Record<"off" | "on", Record<string, StoredCase>>;
/** Next's not-found page as captured, the whole HTML (`__fixtures__/next-answers.json`). */
const NEXT_NOT_FOUND = (nextAnswers as unknown as { notFound: { body: { text: string } } }).notFound
  .body.text;
const SITE = "http://127.0.0.1:3770";
const PLAN_ID = "00000000-0000-4000-8000-0000000000c1";
const HASHES = [
  "'sha256-PvTNY8RRgyZEoaf02ie6QMuKgOIk6BcO1wRWREniD94='",
  "'sha256-bAECyPKIDm9rdxW1yLMYCHUdNmNMMTDUJeKbUuAXKyU='",
];
const INTER = path.resolve(import.meta.dirname, "../../client/fonts/inter-latin.woff2");
const SITE_FILES = path.resolve(import.meta.dirname, "assets");
const SHELL = '<div class="ui-scale-shell">shell</div>';

const row = {
  id: PLAN_ID,
  name: "Parity plan",
  description: "A plan for the parity run.",
  machine_count: 1,
  highest_tier: null,
  author_name: "parity",
  needs: [],
  outputs: [],
  game_version: "",
} as unknown as PlanRow;

let root: string;
let template: PageTemplate;

/** A built client folder as `build:client` leaves it: the prerendered page, page.json and the Inter file. */
function writeClient(dir: string): void {
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(
    path.join(dir, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en" class="h-full">',
      "  <head>",
      "    <!--app-head-->",
      '    <script type="module" crossorigin src="/assets/index-T.js"></script>',
      '    <link rel="stylesheet" crossorigin href="/assets/index-T.css">',
      "  </head>",
      '  <body class="min-h-full">',
      `    <script>boot()</script><div id="root" style="display: contents">${SHELL}</div>`,
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, "assets", "inter-latin-T.woff2"), readFileSync(INTER));
  writeFileSync(
    path.join(dir, "page.json"),
    JSON.stringify({
      scriptHashes: HASHES,
      fontPreloads: [{ href: "/assets/inter-latin-T.woff2", type: "font/woff2" }],
      assetVersions: { ogImage: "opengraph-image.x.png", favicon: "favicon.x.ico" },
    }),
  );
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "page-"));
  writeClient(path.join(root, "client"));
  mkdirSync(path.join(root, "public"));
  template = loadPageTemplate(path.join(root, "client"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  getPublicPlanRow.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The app as production builds it, with the page and the site files. */
async function serve(mode: "off" | "on"): Promise<Listening> {
  return listen(
    createApp({
      env: { production: true, siteUrl: SITE, modAndCommunity: mode === "on" ? "on" : undefined },
      publicDir: path.join(root, "public"),
      datasetsDir: path.join(root, "public", "datasets", "gtnh"),
      clientDir: path.join(root, "client"),
      template,
      siteFilesDir: SITE_FILES,
    }),
  );
}

function header(answer: RawAnswer, name: string): string | undefined {
  return answer.headers.find(([key]) => key === name)?.[1];
}

/** The Inter file's harness name, `<asset:sha256-8>`, as normalize.mjs writes an asset URL. */
const INTER_ASSET = `<asset:${createHash("sha256").update(readFileSync(INTER)).digest("hex").slice(0, 8)}>`;

/**
 * The app's answer as the harness stores it: text, or the sha256 of a binary body, with times as `<time>` and
 * the Inter URL by its bytes.
 */
function stored(method: string, target: string, answer: RawAnswer, binary = false): StoredCase {
  const text = answer.body
    .toString("utf8")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>");
  return {
    name: "pinned",
    request: { method, target },
    status: answer.status,
    headers: answer.headers.map(([key, value]): [string, string] => [
      key,
      key === "link" ? value.replace("/assets/inter-latin-T.woff2", INTER_ASSET) : value,
    ]),
    body: binary
      ? {
          sha256: createHash("sha256").update(answer.body).digest("hex"),
          length: answer.body.length,
        }
      : { text },
  };
}

/** The differences from Next's answer that the allow list does not name. */
async function againstNext(
  server: Listening,
  mode: "off" | "on",
  name: string,
  binary = false,
): Promise<unknown[]> {
  const next = NEXT[mode][name]!;
  const { method, target } = next.request;
  const answer = await call(server.port, method, target);
  return diffCases({ ...next, name }, { ...stored(method, target, answer, binary), name }, ALLOW);
}

/** The metadata tags of a page, one per line, without the build's stylesheet, script and preload tags. */
function metadataTags(html: string): string {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)![1]!;
  const tags =
    head.match(/<title>[\s\S]*?<\/title>|<meta\b(?:"[^"]*"|[^>"])*>|<link\b(?:"[^"]*"|[^>"])*>/g) ??
    [];
  return (
    tags
      .filter((tag) => !/^<link rel="(stylesheet|preload|modulepreload)"/.test(tag))
      .map((tag) =>
        tag
          .replace(/(\/opengraph-image\.png)\?[^"]+"/, '$1?<hash>"')
          .replace(/(\/favicon\.ico)\?[^"]+"/, '$1?<hash>"'),
      )
      .join("\n") + "\n"
  );
}

const fixture = (name: string) =>
  readFileSync(
    path.resolve(import.meta.dirname, "../../lib/server/site/__fixtures__", name),
    "utf8",
  );

describe("the page template", () => {
  it("opens the head with the charset and viewport, then the font preload and the build's tags, then the metadata", () => {
    const html = renderPage(template, "<title>T</title>");
    expect(/<head>([\s\S]*?)<\/head>/.exec(html)![1]).toBe(
      '<meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>' +
        '<link rel="preload" href="/assets/inter-latin-T.woff2" as="font" type="font/woff2" crossorigin=""/>' +
        '<script type="module" crossorigin src="/assets/index-T.js"></script>' +
        '<link rel="stylesheet" crossorigin href="/assets/index-T.css">' +
        "<title>T</title>",
    );
    expect(html).toContain(`<div id="root" style="display: contents">${SHELL}</div>`);
  });

  it("puts player text in as written, `$` patterns included", () => {
    expect(renderPage(template, "$&$'$`")).toContain("$&$'$`</head>");
  });

  it("refuses a template without exactly one head mark", () => {
    const dir = path.join(root, "bad");
    writeClient(dir);
    writeFileSync(path.join(dir, "index.html"), "<html><head></head><body></body></html>");
    expect(() => loadPageTemplate(dir)).toThrow(/<!--app-head-->/);
  });

  it("refuses a head whose inline script spans lines, which joining the lines would change", () => {
    const dir = path.join(root, "multi-line-script");
    writeClient(dir);
    const html = readFileSync(path.join(dir, "index.html"), "utf8");
    const withScript = (script: string) =>
      writeFileSync(
        path.join(dir, "index.html"),
        html.replace("<!--app-head-->", () => `<!--app-head-->\n    ${script}\n`),
      );
    withScript("<script>\n  boot();\n</script>");
    expect(() => loadPageTemplate(dir)).toThrow(/spans lines/);
    withScript("<script>boot();</script>");
    expect(renderPage(loadPageTemplate(dir), "")).toContain("<script>boot();</script>");
  });

  it("refuses a page.json whose script hashes are missing, empty or malformed", () => {
    const dir = path.join(root, "no-hashes");
    writeClient(dir);
    const page = JSON.parse(readFileSync(path.join(dir, "page.json"), "utf8")) as Record<
      string,
      unknown
    >;
    for (const scriptHashes of [undefined, [], ["sha256-abc"], [HASHES[0], 7]]) {
      writeFileSync(path.join(dir, "page.json"), JSON.stringify({ ...page, scriptHashes }));
      expect(() => loadPageTemplate(dir), JSON.stringify(scriptHashes)).toThrow(/scriptHashes/);
    }
  });

  it("stops a production app whose page has no script hashes, rather than serve 'unsafe-inline'", () => {
    const options = {
      env: { production: true, siteUrl: SITE },
      publicDir: path.join(root, "public"),
      datasetsDir: path.join(root, "public", "datasets", "gtnh"),
    };
    expect(() => createApp({ ...options, template: { ...template, scriptHashes: [] } })).toThrow(
      /script hashes are missing/,
    );
    expect(() => createApp({ ...options, template })).not.toThrow();
  });

  it("stops an app whose page the not-found page cannot be cut from, rather than answer each 404 with a 500", () => {
    const options = {
      env: { production: true, siteUrl: SITE },
      publicDir: path.join(root, "public"),
      datasetsDir: path.join(root, "public", "datasets", "gtnh"),
    };
    const noModule = template.html.replace(/<script type="module"[^>]*>[\s\S]*?<\/script>/g, "");
    expect(() => createApp({ ...options, template: { ...template, html: noModule } })).toThrow(
      /no module script/,
    );
    const noRoot = template.html.replace('<div id="root" style="display: contents">', "<div>");
    expect(() => createApp({ ...options, template: { ...template, html: noRoot } })).toThrow(
      /must hold <div id="root"/,
    );
  });
});

describe("with the community switch off", () => {
  withModAndCommunityUnset();
  let server: Listening;
  beforeAll(async () => {
    server = await serve("off");
  });
  afterAll(() => server.close());

  it("answers a missing page with Next's not-found head and markup, and runs no module script", async () => {
    const answer = await call(server.port, "GET", "/no-such-page");
    expect(answer.status).toBe(404);
    const html = answer.body.toString("utf8");
    // The site head with noindex first and the 404 title last, tag for tag as Next wrote it.
    expect(harnessTags(html)).toEqual(harnessTags(NEXT_NOT_FOUND));
    expect(harnessTags(html)[2]).toBe('<meta name="robots" content="noindex"/>');
    expect(harnessTags(html)[4]).toBe(
      "<title>GTNH Planner | GregTech New Horizons Factory Calculator</title>",
    );
    expect(harnessTags(html).at(-1)).toBe("<title>404: This page could not be found.</title>");
    expect(shellMarkup(NEXT_NOT_FOUND).endsWith(NOT_FOUND_BODY)).toBe(true);
    expect(shellMarkup(html)).toBe(
      `<body class="min-h-full"><script>boot()</script>${NOT_FOUND_BODY}`,
    );
    expect(html).not.toContain('type="module"');
    expect(html).toContain('<link rel="stylesheet" crossorigin href="/assets/index-T.css">');
  });

  it("gives a bare app without the built page the same not-found head and markup", () => {
    const html = renderNotFoundPage();
    // Without the built page there are no cache-buster queries to name.
    const unversioned = harnessTags(NEXT_NOT_FOUND).map((tag) =>
      tag.replace(/\?(?:opengraph-image|favicon)\.<hash>/, ""),
    );
    expect(harnessTags(html)).toEqual(unversioned);
    expect(shellMarkup(html)).toBe(
      `<body class="min-h-full">${NOT_FOUND_BODY}</body>`.replace("</body>", ""),
    );
  });

  it("serves / with the site head, the shell and Next's cache-control", async () => {
    for (const name of ["page /", "HEAD /", "OPTIONS /"]) {
      expect(await againstNext(server, "off", name), name).toEqual([]);
    }
    const answer = await call(server.port, "GET", "/");
    const html = answer.body.toString("utf8");
    expect(metadataTags(html)).toBe(fixture("next-head-off.html"));
    expect(html).toContain(SHELL);
    expect(html).toContain("/opengraph-image.png?opengraph-image.x.png");
    expect(html).toContain("/favicon.ico?favicon.x.ico");
  });

  it("answers any other method on / with the page, as Next did", async () => {
    const answer = await call(server.port, "POST", "/", { "content-type": "text/plain" }, "x");
    expect(answer.status).toBe(200);
    expect(answer.body.toString("utf8")).toContain(SHELL);
  });

  it("keeps the plan head off while the community switch is off", async () => {
    getPublicPlanRow.mockResolvedValue(row);
    expect(await againstNext(server, "off", "page /?plan=missing")).toEqual([]);
    const answer = await call(server.port, "GET", `/?plan=${PLAN_ID}`);
    expect(metadataTags(answer.body.toString("utf8"))).toBe(fixture("next-head-off.html"));
    expect(getPublicPlanRow).not.toHaveBeenCalled();
  });

  it("404s /community with the switch off, where Next's 404 alone was cached for a year", async () => {
    // The year of shared caching is the one difference, and the allow list names it as intended.
    for (const name of ["page /community", "page /community?plan=x"]) {
      expect(await againstNext(server, "off", name), name).toEqual([]);
      expect(NEXT.off[name]!.headers).toContainEqual(["cache-control", "s-maxage=31536000"]);
    }
  });

  it("serves the site files as Next did", async () => {
    for (const name of [
      "site /sitemap.xml",
      "site /robots.txt",
      "site /manifest.webmanifest",
      "site /llms.txt",
    ]) {
      expect(await againstNext(server, "off", name), name).toEqual([]);
    }
    for (const name of ["site /favicon.ico", "site /opengraph-image.png"]) {
      expect(await againstNext(server, "off", name, true), name).toEqual([]);
    }
  });
});

describe("with the community switch on", () => {
  withModAndCommunityOn();
  let server: Listening;
  beforeAll(async () => {
    server = await serve("on");
  });
  afterAll(() => server.close());

  it("serves / with the site head, the shell and Next's cache-control", async () => {
    getPublicPlanRow.mockResolvedValue(undefined);
    for (const name of ["page /", "page /?plan=missing", "HEAD /", "OPTIONS /"]) {
      expect(await againstNext(server, "on", name), name).toEqual([]);
    }
    const answer = await call(server.port, "GET", "/");
    expect(metadataTags(answer.body.toString("utf8"))).toBe(fixture("next-head-on.html"));
  });

  it("serves /?plan=<id> with the plan's head, escaped", async () => {
    getPublicPlanRow.mockResolvedValue(row);
    const plain = await call(server.port, "GET", `/?plan=${PLAN_ID}`);
    expect(metadataTags(plain.body.toString("utf8"))).toBe(fixture("next-head-on-plan.html"));
    expect(getPublicPlanRow).toHaveBeenCalledWith(PLAN_ID);

    getPublicPlanRow.mockResolvedValue({ ...row, name: `</title><script>x()</script>"&'$&` });
    const hostile = (await call(server.port, "GET", `/?plan=${PLAN_ID}`)).body.toString("utf8");
    const head = /<head>([\s\S]*?)<\/head>/.exec(hostile)![1]!;
    expect(head).not.toContain("<script>x()");
    expect(head.match(/<title>/g)).toHaveLength(1);
    expect(head).toContain(
      "<title>&lt;/title&gt;&lt;script&gt;x()&lt;/script&gt;&quot;&amp;&#x27;$&amp; | GTNH Planner</title>",
    );
    const escaped = "&lt;/title&gt;&lt;script&gt;x()&lt;/script&gt;&quot;&amp;&#x27;$&amp;";
    expect(head).toContain(`<meta property="og:title" content="${escaped}"/>`);
    expect(head).toContain(`<meta name="twitter:title" content="${escaped}"/>`);

    getPublicPlanRow.mockResolvedValue({ ...row, description: `"/><script>y()</script>&` });
    const described = (await call(server.port, "GET", `/?plan=${PLAN_ID}`)).body.toString("utf8");
    const describedHead = /<head>([\s\S]*?)<\/head>/.exec(described)![1]!;
    expect(describedHead).not.toContain("<script>y()");
    const words = "&quot;/&gt;&lt;script&gt;y()&lt;/script&gt;&amp;";
    for (const tag of [
      `<meta name="description" content="${words}"/>`,
      `<meta property="og:description" content="${words}"/>`,
      `<meta name="twitter:description" content="${words}"/>`,
    ]) {
      expect(describedHead).toContain(tag);
    }
  });

  it("gives a repeated plan the site head, as Next did", async () => {
    getPublicPlanRow.mockResolvedValue(row);
    const answer = await call(server.port, "GET", `/?plan=${PLAN_ID}&plan=${PLAN_ID}`);
    expect(metadataTags(answer.body.toString("utf8"))).toBe(fixture("next-head-on.html"));
    expect(getPublicPlanRow).not.toHaveBeenCalled();
  });

  it("redirects /community and /community?plan=x as Next did", async () => {
    for (const name of ["page /community", "page /community?plan=x"]) {
      // Next's 307 also preloaded its error document's two stylesheets, which a browser following the redirect
      // never uses. The page's stylesheet is a file of the build, so the 307 names only the font.
      // The allow list names that drop as intended, and only the default face keeps its font preload.
      expect(await againstNext(server, "on", name), name).toEqual([]);
      expect(NEXT.on[name]!.headers.find(([key]) => key === "link")![1]).toMatch(
        /<<asset:c9407645>>; rel=preload; as="font"; crossorigin=""; type="font\/woff2", .*, <<asset:401f8660>>; rel=preload; as="style", <<asset:d70d050a>>; rel=preload; as="style"$/,
      );
      const answer = await call(server.port, "GET", name.slice("page ".length));
      expect(header(answer, "link")).toBe(
        `</assets/inter-latin-T.woff2>; rel=preload; as="font"; crossorigin=""; type="font/woff2"`,
      );
    }
    const cases: [string, string, string, number, string | undefined][] = [
      ["GET", "/community?plan=a%20b%2F%3F", "", 307, "/?plan=a%20b%2F%3F"],
      ["GET", "/community?plan=a&plan=b", "", 307, "/"],
      ["GET", "/community?plan=", "", 307, "/"],
      ["POST", "/community", "", 307, "/"],
      ["HEAD", "/community?plan=x", "", 307, "/?plan=x"],
      ["OPTIONS", "/community", "", 400, undefined],
    ];
    for (const [method, target, body, status, location] of cases) {
      const answer = await call(server.port, method, target, {}, body || undefined);
      expect([answer.status, header(answer, "location")], `${method} ${target}`).toEqual([
        status,
        location,
      ]);
    }
  });

  it("serves sitemap and llms.txt from memory for an hour", async () => {
    const before = { ...loads };
    for (const name of ["site /sitemap.xml", "site /llms.txt"]) {
      expect(await againstNext(server, "on", name), name).toEqual([]);
      expect(await againstNext(server, "on", name), name).toEqual([]);
    }
    await call(server.port, "HEAD", "/sitemap.xml");
    expect(loads.sitemap - before.sitemap).toBeLessThanOrEqual(1);
    expect(loads.llms - before.llms).toBeLessThanOrEqual(1);
    // The memo lives as long as the app, so a fresh app loads once and a second call loads nothing more.
    const fresh = await serve("on");
    try {
      const start = { ...loads };
      await call(fresh.port, "GET", "/sitemap.xml");
      await call(fresh.port, "GET", "/sitemap.xml");
      await call(fresh.port, "GET", "/llms.txt");
      await call(fresh.port, "GET", "/llms.txt");
      expect({ sitemap: loads.sitemap - start.sitemap, llms: loads.llms - start.llms }).toEqual({
        sitemap: 1,
        llms: 1,
      });
    } finally {
      await fresh.close();
    }
  });

  it("loads the sitemap and llms.txt again once an hour has passed, serving the held copy meanwhile", async () => {
    let clock = 0;
    const app = express();
    app.use(siteRoutes({ filesDir: SITE_FILES, now: () => clock }));
    const files = await listen(app);
    try {
      const start = { ...loads };
      const counted = () => ({
        sitemap: loads.sitemap - start.sitemap,
        llms: loads.llms - start.llms,
      });
      for (const target of ["/sitemap.xml", "/llms.txt", "/sitemap.xml", "/llms.txt"]) {
        expect((await call(files.port, "GET", target)).status, target).toBe(200);
      }
      clock = SITE_FILE_TTL_MS - 1;
      await call(files.port, "GET", "/sitemap.xml");
      await call(files.port, "GET", "/llms.txt");
      expect(counted()).toEqual({ sitemap: 1, llms: 1 });
      clock = SITE_FILE_TTL_MS;
      const held = await call(files.port, "GET", "/sitemap.xml");
      await call(files.port, "GET", "/llms.txt");
      expect(held.status).toBe(200);
      expect(counted()).toEqual({ sitemap: 2, llms: 2 });
    } finally {
      await files.close();
    }
  });

  it("serves the other site files as Next did, and answers other methods with Next's 405", async () => {
    for (const name of ["site /robots.txt", "site /manifest.webmanifest"]) {
      expect(await againstNext(server, "on", name), name).toEqual([]);
    }
    for (const name of ["site /favicon.ico", "site /opengraph-image.png"]) {
      expect(await againstNext(server, "on", name, true), name).toEqual([]);
    }
    for (const target of [
      "/sitemap.xml",
      "/robots.txt",
      "/manifest.webmanifest",
      "/favicon.ico",
      "/opengraph-image.png",
      "/llms.txt",
    ]) {
      for (const method of ["POST", "OPTIONS"]) {
        const answer = await call(server.port, method, target);
        expect(
          [
            answer.status,
            answer.headers.filter(([key]) => key === "allow"),
            answer.body.toString(),
          ],
          `${method} ${target}`,
        ).toEqual([
          405,
          [
            ["allow", "GET"],
            ["allow", "HEAD"],
          ],
          "Method Not Allowed",
        ]);
      }
    }
    const ranged = await call(server.port, "GET", "/favicon.ico", { range: "bytes=0-9" });
    expect([ranged.status, ranged.body.length]).toEqual([
      200,
      readFileSync(path.join(SITE_FILES, "favicon.ico")).length,
    ]);
  });

  it("answers script-src with the page's hashes and no 'unsafe-inline' in production", async () => {
    const answer = await call(server.port, "GET", "/");
    const policy = header(answer, "content-security-policy")!;
    const env = { production: true, siteUrl: SITE, modAndCommunity: "on" };
    expect(policy).toBe(
      documentPolicy(env).replace(
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        `script-src 'self' ${HASHES.join(" ")} 'wasm-unsafe-eval'`,
      ),
    );
    expect(policy).not.toContain("'unsafe-inline' 'wasm");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("sends the Link preload header Next sent, by asset bytes", async () => {
    const answer = await call(server.port, "GET", "/");
    const link = header(answer, "link")!.replace("/assets/inter-latin-T.woff2", INTER_ASSET);
    // Inter's latin file is the item Next sent as <asset:c9407645>, the one font whose preload stays.
    expect(link).toBe(
      '<<asset:c9407645>>; rel=preload; as="font"; crossorigin=""; type="font/woff2"',
    );
    const redirect = await call(server.port, "GET", "/community");
    expect(header(redirect, "link")).toBe(header(answer, "link"));
  });
});
