#!/usr/bin/env node
/**
 * The part of an HTML answer the allow list leaves to this compare: its metadata tags and inline scripts, and
 * its shell markup, taken from two capture directories and compared case by case.
 *
 *   node tools/http-parity/head-compare.mjs <dirA> <dirB>
 *
 * It runs on the pages (`/`, `/?plan=missing`, the scenario's `/?plan=<id>`) and on every HTML 404 either
 * side answered. Exits 1 on any difference.
 *
 * - Tags: every `<meta>`, `<link>` and `<title>`, in document order wherever they sit: Next streams an awaited
 *   page's metadata into `<body>`, so order is compared and placement is not. Framework tags are left out:
 *   stylesheets, preloads and module preloads, and `next-size-adjust`. The site image's and the favicon's
 *   cache-buster query is compared by name only: each build names it by its own hash.
 * - Scripts: every inline script the page itself runs (the boot scripts and the JSON-LD), in order, head and
 *   body alike. Scripts with a `src`, module scripts and Next's own inline scripts (the RSC flight, its chunk
 *   list, its streaming timer) are left out.
 * - Shell: the `<body>` markup up to the first framework script, without Next's suspense markers, its pending
 *   boundary templates, the metadata it streams into the body, and the `#root` wrapper.
 */
import { pathToFileURL } from "node:url";
import { readCaptureDir } from "./compare.mjs";

const INLINE_SCRIPT = /<script(?:\s[^>]*)?>[\s\S]*?<\/script>/g;
const TAG =
  /<title>[\s\S]*?<\/title>|<script(?:\s[^>]*)?>[\s\S]*?<\/script>|<(?:meta|link)\b(?:"[^"]*"|[^>"])*>/g;

/**
 * Cases ruled to answer the site's plain 404 where Next answered another page: Next's prerendered not-found of
 * a page route (`/community` with the switch off, the dev page in production), whose head lacks the 404 title
 * and whose body is empty until its script runs. Their difference from the first directory is reported, never
 * failed; the second directory's answer must be that directory's own plain 404 (`PLAIN_404_CASE`), and any
 * difference from it fails.
 */
export const RULED_PLAIN_404 = new Set([
  "page /community",
  "page /community?plan=x",
  "site /dev/clean-card",
]);

/**
 * Next's own inline scripts: the RSC flight, the chunk list, the streaming timer, and the script that moves icon
 * links it streamed into `<body>` back to `<head>`.
 */
function isNextInlineScript(tag) {
  return (
    /^<script id="_R_"|^<script>\s*(?:\(?self\.__next_f|requestAnimationFrame\(function\(\)\{\$RT|\$R)/.test(
      tag,
    ) ||
    tag.startsWith(
      `<script>document.querySelectorAll('body link[rel="icon"], body link[rel="apple-touch-icon"]')`,
    )
  );
}

function isFrameworkTag(tag) {
  if (/^<link rel="(?:stylesheet|preload|modulepreload)"/.test(tag)) return true;
  if (/next-size-adjust/.test(tag)) return true;
  if (/^<script\b/.test(tag)) {
    return (
      /^<script[^>]*\ssrc=/.test(tag) ||
      /^<script type="module"/.test(tag) ||
      isNextInlineScript(tag)
    );
  }
  return false;
}

/** The tags compared, in document order. */
export function metadataTags(html) {
  return (html.match(TAG) ?? [])
    .filter((tag) => !tag.startsWith("<script") && !isFrameworkTag(tag))
    .map((tag) => tag.replace(/\?(opengraph-image|favicon)\.[^"]+"/, '?$1.<hash>"'));
}

/** The page's own inline scripts, in document order. */
export function pageScripts(html) {
  return (html.match(TAG) ?? []).filter((tag) => tag.startsWith("<script") && !isFrameworkTag(tag));
}

/** The body markup compared (see the header). */
export function shellMarkup(html) {
  let body = html.slice(html.indexOf("<body"));
  body = body
    .replace(
      /<div hidden=""><!--\$\??-->(?:<template id="B:\d+"><\/template>)?(?:<!--\/\$-->)?<\/div>/,
      "",
    )
    .replace(/<!--\/?\$\??-->/g, "")
    .replace(/<template id="B:\d+"><\/template>/g, "");
  const framework = [...body.matchAll(INLINE_SCRIPT)].find(
    (match) => /^<script[^>]*\ssrc=/.test(match[0]) || isNextInlineScript(match[0]),
  );
  if (framework) body = body.slice(0, framework.index);
  body = body.replace(/<\/body>[\s\S]*$/, "");
  const root = '<div id="root" style="display: contents">';
  if (body.includes(root)) body = body.replace(root, "").replace(/<\/div>\s*$/, "");
  body = body.replace(/<title>[\s\S]*?<\/title>|<(?:meta|link)\b(?:"[^"]*"|[^>"])*>/g, "");
  return body.replace(/>\s+</g, "><").trim();
}

export const PAGE_CASES = ["page /", "page /?plan=missing", "scenario page /?plan="];

/** The site's plain 404: an unknown path. */
export const PLAIN_404_CASE = "page /no-such-page";

function isHtml404(stored) {
  const type = stored?.headers?.find(([key]) => key === "content-type")?.[1] ?? "";
  return stored?.status === 404 && /text\/html/.test(type) && typeof stored.body?.text === "string";
}

/** The differences between two HTML answers of one case: `{ name, field, index?, a, b }`. */
function diffHtml(name, textA, textB, prefix = "") {
  const differences = [];
  for (const [field, list] of [
    ["tags", metadataTags],
    ["scripts", pageScripts],
  ]) {
    const listA = list(textA);
    const listB = list(textB);
    for (let index = 0; index < Math.max(listA.length, listB.length); index++) {
      if (listA[index] !== listB[index]) {
        differences.push({ name, field: prefix + field, index, a: listA[index], b: listB[index] });
        break;
      }
    }
  }
  const shellA = shellMarkup(textA);
  const shellB = shellMarkup(textB);
  if (shellA !== shellB) {
    let at = 0;
    while (shellA[at] === shellB[at]) at++;
    differences.push({
      name,
      field: prefix + "shell",
      index: at,
      a: shellA.slice(Math.max(0, at - 60), at + 200),
      b: shellB.slice(Math.max(0, at - 60), at + 200),
    });
  }
  return differences;
}

/**
 * Each case's differences: `{ name, field: "tags" | "scripts" | "shell" | "case", index?, a, b }`. A ruled case
 * is also held to the second directory's own plain 404, as fields named `own 404 <field>`.
 */
export function compareHeads(a, b) {
  const names = new Set(PAGE_CASES.filter((name) => a.has(name) || b.has(name)));
  // The throw and escape fixtures exist only in Next's baseline build.
  for (const [name, stored] of [...a, ...b]) {
    if (isHtml404(stored) && !name.startsWith("nextOnly ")) names.add(name);
  }
  const differences = [];
  const ruled = [];
  for (const name of names) {
    const textA = a.get(name)?.body?.text;
    const textB = b.get(name)?.body?.text;
    if (typeof textA !== "string" || typeof textB !== "string") {
      differences.push({ name, field: "case", a: typeof textA, b: typeof textB });
      continue;
    }
    const found = diffHtml(name, textA, textB);
    if (!RULED_PLAIN_404.has(name)) {
      differences.push(...found);
      continue;
    }
    ruled.push(...found);
    if (!isHtml404(b.get(name))) continue;
    const plain = b.get(PLAIN_404_CASE)?.body?.text;
    if (typeof plain !== "string") {
      differences.push({ name, field: "own 404 case", a: "missing", b: "string" });
      continue;
    }
    differences.push(...diffHtml(name, plain, textB, "own 404 "));
  }
  return { cases: names.size, differences, ruled };
}

function main([dirA, dirB]) {
  if (!dirA || !dirB) {
    console.error("usage: head-compare.mjs <dirA> <dirB>");
    return 2;
  }
  const { cases, differences, ruled } = compareHeads(readCaptureDir(dirA), readCaptureDir(dirB));
  for (const d of ruled)
    console.log(
      `ruled ${d.name} ${d.field}: the site's plain 404 (RULED_PLAIN_404), checked against ${PLAIN_404_CASE}`,
    );
  for (const d of differences) {
    console.log(`DIFF ${d.name} ${d.field}${d.index === undefined ? "" : ` at ${d.index}`}`);
    console.log(`  a: ${JSON.stringify(d.a)}\n  b: ${JSON.stringify(d.b)}`);
  }
  console.log(
    `${cases} HTML cases, ${new Set(differences.map((d) => d.name)).size} with differences`,
  );
  return differences.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
