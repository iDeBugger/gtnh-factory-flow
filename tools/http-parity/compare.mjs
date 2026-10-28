#!/usr/bin/env node
/**
 * Compares two capture directories case by case: status, body, and every
 * header name and value, order within one name included (repeated lines of
 * a list-valued name are joined as RFC 9110 joins them; see `LIST_HEADERS`).
 *
 *   node tools/http-parity/compare.mjs <dirA> <dirB> [--allow allowed-differences.json]
 *
 * Only the ignore list escapes: `date`, `keep-alive`, the `x-nextjs-*` cache
 * markers, and `content-length` with `transfer-encoding`, which on an answer
 * with a body are one check on the body itself (a length or chunked framing
 * is not a difference, a different body is). On a HEAD, a 204 or a 304 there
 * is no body to check, so both are compared as sent. `connection` is
 * compared. A case that failed or was skipped on either side is a difference
 * no entry can allow.
 *
 * Every other difference fails unless the allow list names it. An entry
 * `{ case, field, reason }` matches a case name by the regular expression
 * `case` (whole name) and a field by name, where a trailing `*` matches any
 * rest. It may narrow itself further:
 * - `status`: the status side A answered (the 404 page, wherever a path ends
 *   on it);
 * - `a` and `b`: regular expressions the two values must match (whole value);
 * - `transform`: a named rewrite of the two values, after which they must be
 *   equal byte for byte, so one intended change is allowed and nothing else
 *   on that field (`TRANSFORMS` below).
 * Exits 1 on any difference the list does not name.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const IGNORED_HEADERS = new Set([
  "date",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "x-nextjs-cache",
  "x-nextjs-prerender",
  "x-nextjs-stale-time",
]);

/** Framing headers that say something on an answer with no body to check. */
const BODYLESS_FRAMING = new Set(["content-length", "transfer-encoding"]);

function isBodyless(stored) {
  return (
    String(stored?.request?.method ?? "").toUpperCase() === "HEAD" ||
    stored?.status === 204 ||
    stored?.status === 304
  );
}

function headerMap(headers, bodyless) {
  const map = new Map();
  for (const [name, value] of headers ?? []) {
    const key = name.toLowerCase();
    if (IGNORED_HEADERS.has(key) && !(bodyless && BODYLESS_FRAMING.has(key))) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

/**
 * The list-valued fields whose repeated lines RFC 9110 makes the same field as one comma-joined line, so two
 * `vary` lines and one joined line compare equal. Every other name keeps one value per line: a single-value
 * field sent twice (two `location`, `content-type` or `content-disposition` lines) is a broken answer, not a
 * spelling, and `set-cookie` lines can never be joined.
 */
export const LIST_HEADERS = new Set([
  "vary",
  "cache-control",
  "link",
  "allow",
  "connection",
  "content-encoding",
  "content-language",
  "pragma",
  "via",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-expose-headers",
]);

function headerValue(key, values) {
  if (values === undefined) return undefined;
  if (values.length === 1) return values[0];
  return values.join(LIST_HEADERS.has(key) ? ", " : "\n");
}

/**
 * A body's length in raw bytes when both sides stored it (a text body normalized to equal text can still have
 * had different bytes), else the stored form's.
 */
export function bodyLength(body, raw = true) {
  if (!body) return 0;
  if (raw && typeof body.bytes === "number") return body.bytes;
  if (typeof body.text === "string") return Buffer.byteLength(body.text, "utf8");
  return body.length ?? 0;
}

function bodyValue(body) {
  if (!body) return undefined;
  if (typeof body.text === "string") return body.text;
  return `sha256:${body.sha256}${body.pixels ? ` pixels:${body.pixels}` : ""}`;
}

function fieldMatches(pattern, field) {
  return pattern.endsWith("*") ? field.startsWith(pattern.slice(0, -1)) : pattern === field;
}

function whole(pattern) {
  return new RegExp(`^(?:${pattern})$`, "s");
}

const SCRIPT_HASHES = "<script-hashes>";

/**
 * Named rewrites for `transform` entries: each returns the two values in a
 * form that must then be equal, or undefined when the rewrite does not apply
 * (the entry then allows nothing).
 */
export const TRANSFORMS = {
  /**
   * The page policy's one intended change: `script-src` names the inline
   * scripts' hashes instead of `'unsafe-inline'`, and the worker policy's
   * path moves from `/_next/static/` to `/assets/`. Every other directive and
   * source stays byte for byte.
   */
  "csp-script-hashes": (a, b) => {
    const unsafe = /script-src 'self' 'unsafe-inline'(?= |;|$)/;
    const hashes = /script-src 'self'(?: 'sha256-[A-Za-z0-9+/=]+')+(?= |;|$)/;
    if (!unsafe.test(a) || !hashes.test(b)) return undefined;
    return [
      a
        .replace(unsafe, `script-src 'self' ${SCRIPT_HASHES}`)
        .replaceAll("/_next/static/", "/assets/"),
      b.replace(hashes, `script-src 'self' ${SCRIPT_HASHES}`),
    ];
  },
  /**
   * Only the named font files keep their preload (the default face). Side A's `Link` items
   * are filtered to its non-font items and the kept fonts, in order, and must
   * then equal side B's exactly, so a dropped or added stylesheet preload, or
   * any other font, still fails. An entry's `dropAs` (for example
   * `["style"]`) also takes side A's preloads of those kinds out, for an
   * answer where they are meant to go.
   */
  "link-keep-fonts": (a, b, entry) => {
    const keep = new Set(entry.keep ?? []);
    const dropAs = new Set(entry.dropAs ?? []);
    const items = a.split(/,\s*(?=<)/);
    const kept = items.filter((item) => {
      const kind = /;\s*as="?([a-z]+)"?/.exec(item)?.[1];
      if (kind !== undefined && dropAs.has(kind)) return false;
      if (kind !== "font") return true;
      const url = /^<(.*?)>\s*;/.exec(item)?.[1];
      return url !== undefined && keep.has(url);
    });
    return [kept.join(", "), b];
  },
};

function transformAllows(entry, difference) {
  if (entry.transform === undefined) return true;
  const transform = TRANSFORMS[entry.transform];
  if (!transform || typeof difference.a !== "string" || typeof difference.b !== "string")
    return false;
  const pair = transform(difference.a, difference.b, entry);
  return pair !== undefined && pair[0] === pair[1];
}

export function isAllowed(caseName, difference, allow, statusA) {
  if (difference.field === "capture") return false;
  return allow.some(
    (entry) =>
      whole(entry.case).test(caseName) &&
      (entry.status === undefined || entry.status === statusA) &&
      fieldMatches(entry.field, difference.field) &&
      (entry.a === undefined || whole(entry.a).test(String(difference.a ?? ""))) &&
      (entry.b === undefined || whole(entry.b).test(String(difference.b ?? ""))) &&
      transformAllows(entry, difference),
  );
}

/** Every difference between two stored cases that the allow list does not name. */
export function diffCases(a, b, allow = []) {
  const name = a?.name ?? b?.name ?? "";
  const differences = [];
  if (!a || !b) {
    differences.push({ field: "case", a: a ? "present" : undefined, b: b ? "present" : undefined });
  } else {
    for (const [side, stored] of [
      ["a", a],
      ["b", b],
    ]) {
      if (!(stored.status > 0)) {
        differences.push({
          field: "capture",
          [side]: stored.body?.text ?? `status ${stored.status}`,
        });
      }
    }
    if (a.status !== b.status) differences.push({ field: "status", a: a.status, b: b.status });
    const bodyless = isBodyless(a) || isBodyless(b);
    const headersA = headerMap(a.headers, bodyless);
    const headersB = headerMap(b.headers, bodyless);
    for (const key of new Set([...headersA.keys(), ...headersB.keys()])) {
      const valueA = headerValue(key, headersA.get(key));
      const valueB = headerValue(key, headersB.get(key));
      if (valueA !== valueB) differences.push({ field: `headers.${key}`, a: valueA, b: valueB });
    }
    const valueA = bodyValue(a.body);
    const valueB = bodyValue(b.body);
    if (valueA !== valueB) {
      differences.push({ field: "body", a: valueA, b: valueB });
    } else {
      // Equal bodies of unequal length: raw bytes the stored form does not show. A text body measured on one
      // side only (a capture from before `bytes` was stored) cannot be checked, and says so.
      const measuredA = typeof a.body?.bytes === "number";
      const measuredB = typeof b.body?.bytes === "number";
      if (measuredA !== measuredB) {
        differences.push({
          field: "body.length",
          a: measuredA ? a.body.bytes : "unmeasured",
          b: measuredB ? b.body.bytes : "unmeasured",
        });
      } else {
        const lengthA = bodyLength(a.body, measuredA);
        const lengthB = bodyLength(b.body, measuredB);
        if (lengthA !== lengthB) differences.push({ field: "body.length", a: lengthA, b: lengthB });
      }
    }
  }
  return differences.filter((difference) => !isAllowed(name, difference, allow, a?.status));
}

export function readCaptureDir(dir) {
  const cases = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const stored = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    if (stored && typeof stored.name === "string") cases.set(stored.name, stored);
  }
  return cases;
}

function clip(value) {
  if (value === undefined) return "(absent)";
  const text = String(value);
  return text.length > 300 ? `${text.slice(0, 300)}... (${text.length} chars)` : text;
}

/** Compares two directories; returns the unallowed differences per case. */
export function compareDirs(dirA, dirB, allow = []) {
  const a = readCaptureDir(dirA);
  const b = readCaptureDir(dirB);
  const results = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const differences = diffCases(a.get(name), b.get(name), allow);
    if (differences.length > 0) results.push({ name, differences });
  }
  return { cases: new Set([...a.keys(), ...b.keys()]).size, results };
}

function main(argv) {
  const args = [...argv];
  const allowAt = args.indexOf("--allow");
  const allowPath = allowAt >= 0 ? args.splice(allowAt, 2)[1] : undefined;
  const [dirA, dirB] = args;
  if (!dirA || !dirB) {
    console.error("usage: compare.mjs <dirA> <dirB> [--allow allowed-differences.json]");
    return 2;
  }
  const allow = allowPath ? JSON.parse(readFileSync(allowPath, "utf8")) : [];
  const { cases, results } = compareDirs(dirA, dirB, allow);
  for (const { name, differences } of results) {
    console.log(`DIFF ${name}`);
    for (const difference of differences) {
      console.log(
        `  ${difference.field}\n    a: ${clip(difference.a)}\n    b: ${clip(difference.b)}`,
      );
    }
  }
  console.log(`${cases} cases, ${results.length} with differences`);
  return results.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
