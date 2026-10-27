#!/usr/bin/env node
/**
 * Compares two capture directories case by case: status, body, and every
 * header name and value, duplicates and order within one name included.
 *
 *   node tools/http-parity/compare.mjs <dirA> <dirB> [--allow allowed-differences.json]
 *
 * Only the ignore list escapes: `date`, `keep-alive`, the `x-nextjs-*` cache
 * markers, and `content-length` with `transfer-encoding`, which are one check
 * on the body's decoded length (a length or chunked framing is not a
 * difference, a different length is). `connection` is compared. Every other
 * difference fails unless the allow list names it: an entry
 * `{ case, field, reason }` matches a case name by the regular expression
 * `case` (whole name) and a field by name, where a trailing `*` matches any
 * rest. `a` and `b`, when given, are regular expressions the two values must
 * match (whole value), so an entry can allow one known change and nothing
 * else on that field, and `status`, when given, is the status side A must
 * have answered (the 404 page, wherever a path ends on it). Exits 1 on any difference the list does not name.
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

function headerMap(headers) {
  const map = new Map();
  for (const [name, value] of headers ?? []) {
    const key = name.toLowerCase();
    if (IGNORED_HEADERS.has(key)) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

function headerValue(values) {
  if (values === undefined) return undefined;
  return values.length === 1 ? values[0] : values.join("\n");
}

export function bodyLength(body) {
  if (!body) return 0;
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

export function isAllowed(caseName, difference, allow, statusA) {
  return allow.some(
    (entry) =>
      whole(entry.case).test(caseName) &&
      (entry.status === undefined || entry.status === statusA) &&
      fieldMatches(entry.field, difference.field) &&
      (entry.a === undefined || whole(entry.a).test(String(difference.a ?? ""))) &&
      (entry.b === undefined || whole(entry.b).test(String(difference.b ?? ""))),
  );
}

/** Every difference between two stored cases that the allow list does not name. */
export function diffCases(a, b, allow = []) {
  const name = a?.name ?? b?.name ?? "";
  const differences = [];
  if (!a || !b) {
    differences.push({ field: "case", a: a ? "present" : undefined, b: b ? "present" : undefined });
  } else {
    if (a.status !== b.status) differences.push({ field: "status", a: a.status, b: b.status });
    const headersA = headerMap(a.headers);
    const headersB = headerMap(b.headers);
    for (const key of new Set([...headersA.keys(), ...headersB.keys()])) {
      const valueA = headerValue(headersA.get(key));
      const valueB = headerValue(headersB.get(key));
      if (valueA !== valueB) differences.push({ field: `headers.${key}`, a: valueA, b: valueB });
    }
    const lengthA = bodyLength(a.body);
    const lengthB = bodyLength(b.body);
    if (lengthA !== lengthB) differences.push({ field: "body.length", a: lengthA, b: lengthB });
    const valueA = bodyValue(a.body);
    const valueB = bodyValue(b.body);
    if (valueA !== valueB) differences.push({ field: "body", a: valueA, b: valueB });
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
