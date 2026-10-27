#!/usr/bin/env node
/**
 * Sends every parity case to one server and writes one normalized answer per
 * case: `<out>/<case>.json` = `{ name, request, status, headers, body }`.
 *
 *   node tools/http-parity/capture.mjs --base <url> --out <dir> --mode off|on
 *       [--only <regex>] [--host <name>] [--no-forwarded]
 *
 * Against a local server (the default) every case carries `Host:
 * parity.example` and `X-Forwarded-Proto: https` unless it names its own, so
 * an origin built from either one, or from the listen address, shows in
 * `location`. Every case asks for `Connection: keep-alive`. With `--host`
 * (stage) the cases carry that Host instead, TLS names it, `--no-forwarded`
 * drops the forwarded header (Caddy sets its own), and `localOnly` cases are
 * skipped.
 *
 * Before the first case it waits for `/api/version` and for each dataset's
 * client-file listing to be complete, so no answer depends on how far the
 * prewarm got. Asset URLs found in HTML or a `Link` header are fetched once
 * each, and named by their bytes (normalize.mjs).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rawRequest } from "./raw-http.mjs";
import { assetUrls, createNormalizeState, normalizeCase, sha256 } from "./normalize.mjs";
import { CASES, SCENARIO, VERSIONS } from "./requests.mjs";

const PLACEHOLDER = /\{([A-Za-z][\w.:@-]*)(\|uri)?\}/g;
const CASE_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 15 * 60_000;

function parseArgs(argv) {
  const options = { forwarded: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-forwarded") options.forwarded = false;
    else if (arg.startsWith("--")) options[arg.slice(2)] = argv[(index += 1)];
  }
  if (!options.base || !options.out || !["off", "on"].includes(options.mode)) {
    throw new Error(
      "usage: capture.mjs --base <url> --out <dir> --mode off|on [--only <regex>] [--host <name>] [--no-forwarded]",
    );
  }
  return options;
}

function defaultHeaders(options) {
  // Keep-alive asked for, so a server that closes the connection says so in its own `connection` header: Node's
  // client asks for a close on a socket outside an agent, and every answer would echo it.
  const headers = { Host: options.host ?? "parity.example", Connection: "keep-alive" };
  if (options.forwarded) headers["X-Forwarded-Proto"] = "https";
  return headers;
}

/** Defaults overridden by the case's own headers, by name in any case; a null case value removes the default. */
function mergeHeaders(defaults, own = {}, vars) {
  const merged = new Map();
  for (const [name, value] of Object.entries(defaults))
    merged.set(name.toLowerCase(), [name, value]);
  for (const [name, value] of Object.entries(own)) {
    if (value === null) merged.delete(name.toLowerCase());
    else merged.set(name.toLowerCase(), [name, substitute(value, vars)]);
  }
  return [...merged.values()];
}

class MissingVariable extends Error {}

function substitute(text, vars) {
  return text.replace(PLACEHOLDER, (_match, name, uri) => {
    if (!vars.has(name)) throw new MissingVariable(name);
    const value = String(vars.get(name));
    return uri ? encodeURIComponent(value) : value;
  });
}

function jsonPath(value, pathText) {
  if (!pathText) return value;
  let current = value;
  for (const part of pathText.split(".")) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current) && /^-?\d+$/.test(part)) {
      const index = Number(part);
      current = current[index < 0 ? current.length + index : index];
    } else {
      current = current[part];
    }
  }
  return current;
}

function saveValues(entry, answer, vars) {
  for (const save of entry.save ?? []) {
    let value;
    if (save.from === "json") {
      try {
        value = jsonPath(JSON.parse(answer.body.toString("utf8")), save.path);
      } catch {
        value = undefined;
      }
      if (save.pathOnly && typeof value === "string") {
        try {
          const url = new URL(value);
          value = `${url.pathname}${url.search}`;
        } catch {
          // Already a path.
        }
      }
    } else if (save.from === "header") {
      value = answer.headers.find(([name]) => name === save.name.toLowerCase())?.[1];
    } else if (save.from === "cookie") {
      for (const [name, header] of answer.headers) {
        if (name !== "set-cookie") continue;
        const pair = header.split(";")[0];
        if (pair.startsWith(`${save.name}=`) && pair.length > save.name.length + 1) value = pair;
      }
    }
    if (value !== undefined && value !== null) vars.set(save.as, value);
  }
}

function fileName(name) {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 140);
  return `${slug}-${createHash("sha1").update(name).digest("hex").slice(0, 8)}.json`;
}

function isHtml(headers) {
  return /text\/html/i.test(headers.find(([name]) => name === "content-type")?.[1] ?? "");
}

async function hashAssets(answer, options, assetHashes) {
  const texts = [];
  if (isHtml(answer.headers)) texts.push(answer.body.toString("utf8"));
  for (const [name, value] of answer.headers) if (name === "link") texts.push(value);
  for (const text of texts) {
    for (const url of assetUrls(text)) {
      if (assetHashes.has(url)) continue;
      try {
        const asset = await rawRequest({
          base: options.base,
          target: url,
          headers: mergeHeaders(defaultHeaders(options), {}, new Map()),
          timeoutMs: 60_000,
        });
        assetHashes.set(url, asset.status === 200 ? sha256(asset.body) : `status-${asset.status}`);
      } catch {
        assetHashes.set(url, undefined);
      }
    }
  }
}

async function waitFor(check, label) {
  const until = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > until)
      throw new Error(`capture: ${label} not ready within ${READY_TIMEOUT_MS / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function prepare(options, vars) {
  const headers = mergeHeaders(defaultHeaders(options), {}, vars);
  const get = (target) => rawRequest({ base: options.base, target, headers, timeoutMs: 60_000 });
  await waitFor(async () => {
    const answer = await get("/api/version");
    if (answer.status !== 200) return false;
    vars.set("build", JSON.parse(answer.body.toString("utf8")).build);
    return true;
  }, "/api/version");
  const manifest = JSON.parse(
    (await get("/datasets/gtnh/datasets.manifest.json")).body.toString("utf8"),
  );
  for (const version of manifest.versions ?? [])
    vars.set(`hash:${version.id}`, version.checksumSha256 ?? "");
  for (const version of VERSIONS) {
    await waitFor(async () => {
      const answer = await get(`/api/datasets/${version}/client-files`);
      return answer.status === 200 && JSON.parse(answer.body.toString("utf8")).complete === true;
    }, `${version} client files`);
  }
}

export async function capture(options) {
  const local = !options.host;
  const only = options.only ? new RegExp(options.only) : undefined;
  mkdirSync(options.out, { recursive: true });
  for (const file of readdirSync(options.out))
    if (file.endsWith(".json")) rmSync(path.join(options.out, file));

  const vars = new Map();
  await prepare(options, vars);

  const state = createNormalizeState();
  const assetHashes = new Map();
  const defaults = defaultHeaders(options);
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of [...CASES, ...SCENARIO]) {
    if (!entry.modes.includes(options.mode)) continue;
    if (entry.localOnly && !local) continue;
    if (only && !only.test(entry.name)) continue;
    const request = { method: entry.method, target: entry.target };
    if (entry.route) request.route = entry.route;
    let stored;
    try {
      const missing = (entry.needs ?? []).filter((name) => !vars.has(name));
      if (missing.length > 0) throw new MissingVariable(missing.join(", "));
      const target = substitute(entry.target, vars);
      const headers = mergeHeaders(defaults, entry.headers, vars);
      let body = typeof entry.body === "function" ? entry.body(vars) : entry.body;
      if (typeof body === "string") body = Buffer.from(body);
      const chunks = entry.chunked && body ? splitChunks(body) : undefined;
      sent += 1;
      const answer = await rawRequest({
        base: options.base,
        method: entry.method,
        target,
        headers,
        body: chunks ? undefined : body,
        chunks,
        timeoutMs: CASE_TIMEOUT_MS,
        strict: entry.strict === true,
      });
      await hashAssets(answer, options, assetHashes);
      stored = normalizeCase(answer, { name: entry.name, request, state, assetHashes, target });
      saveValues(entry, answer, vars);
    } catch (error) {
      if (error instanceof MissingVariable) {
        skipped += 1;
        stored = {
          name: entry.name,
          request,
          status: 0,
          headers: [],
          body: { text: `<skipped: no ${error.message}>` },
        };
      } else {
        failed += 1;
        stored = {
          name: entry.name,
          request,
          status: -1,
          headers: [],
          body: { text: `<failed: ${error.message}>` },
        };
        console.error(`FAILED ${entry.name}: ${error.message}`);
      }
    }
    writeFileSync(
      path.join(options.out, fileName(entry.name)),
      `${JSON.stringify(stored, null, 2)}\n`,
    );
  }
  console.log(
    `${sent + skipped} cases (${sent} sent, ${skipped} skipped for a missing value), ${failed} failed to connect or read`,
  );
  return { sent, skipped, failed };
}

function splitChunks(body) {
  const chunks = [];
  for (let offset = 0; offset < body.length; offset += 4096)
    chunks.push(body.subarray(offset, offset + 4096));
  return chunks;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  capture(parseArgs(process.argv.slice(2))).then(
    ({ failed }) => process.exit(failed > 0 ? 1 : 0),
    (error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
}
