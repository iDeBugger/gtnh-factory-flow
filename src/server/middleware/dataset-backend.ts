/**
 * A development server without datasets of its own forwards the dataset requests to another instance of this app
 * (`GTNH_DATASET_BACKEND_URL`), before the static files are looked up. It runs after the dataset gate, so the index
 * gzips, the shards, the client files and the raw recipes file have already gone to the local dataset-files route;
 * only the content-named textures among them are forwarded from there.
 *
 * No forwarded segment can be `.` or `..`, plain or encoded: the version and every dataset file segment are a
 * published name's characters and never start with a dot, and an API segment (a recipe id holds `:` and arrives
 * encoded) never starts with a dot or `%`. Like Next's rewrite rules, the fixed words of each pattern match in any
 * case.
 */
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream";
import type { RequestHandler } from "express";
import { canonicalParts } from "./normalize-path";

/** A published dataset name's characters, never starting with a dot. */
const PUBLISHED_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** Any API path segment that does not start with a dot or a percent escape. */
const API_SEGMENT = /^[^/.%][^/]*$/;
const CONTENT_NAMED_TEXTURE_ROOTS = new Set(["rendered", "icons"]);

/** Headers that belong to one connection, never forwarded either way. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** How long the backend may take to answer before the request fails. */
const BACKEND_TIMEOUT_MS = 30_000;

/** The backend path a request path is forwarded to, or undefined when it stays local. */
export function datasetBackendPath(pathname: string): string | undefined {
  const segments = pathname.split("/").slice(1);
  const word = (index: number) => segments[index]?.toLowerCase();
  const [, , version = "", ...rest] = segments;
  const tail = rest.map((segment) => `/${segment}`).join("");
  if (segments.length >= 3 && word(0) === "api" && word(1) === "datasets") {
    return PUBLISHED_SEGMENT.test(version) && rest.every((segment) => API_SEGMENT.test(segment))
      ? `/api/datasets/${version}${tail}`
      : undefined;
  }
  if (segments.length >= 3 && word(0) === "datasets" && word(1) === "gtnh") {
    return PUBLISHED_SEGMENT.test(version) &&
      rest.every((segment) => PUBLISHED_SEGMENT.test(segment))
      ? `/datasets/gtnh/${version}${tail}`
      : undefined;
  }
  const [, filesVersion = "", textures = "", root = "", file = ""] = segments;
  if (
    segments.length === 5 &&
    word(0) === "dataset-files" &&
    textures.toLowerCase() === "textures" &&
    CONTENT_NAMED_TEXTURE_ROOTS.has(root.toLowerCase()) &&
    PUBLISHED_SEGMENT.test(filesVersion) &&
    PUBLISHED_SEGMENT.test(file)
  ) {
    return `/datasets/gtnh/${filesVersion}/textures/${root}/${file}`;
  }
  return undefined;
}

function connectionHeaders(headers: http.IncomingHttpHeaders): Set<string> {
  const named = String(headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...HOP_BY_HOP, ...named]);
}

/**
 * Forwards a matching request to `baseUrl` (trailing slashes dropped) with its method, query, headers and body,
 * the backend's Host and the original one in `X-Forwarded-Host`, and streams the answer back with its status and
 * headers. A backend that fails answers Next's proxy error: 500, "Internal Server Error".
 */
export function datasetBackendProxy(baseUrl: string): RequestHandler {
  const base = baseUrl.replace(/\/+$/, "");
  return (req, res, next) => {
    const { pathname, search } = canonicalParts(req);
    const backendPath = datasetBackendPath(pathname);
    if (backendPath === undefined) {
      next();
      return;
    }
    const target = new URL(base + backendPath + search);
    const skip = connectionHeaders(req.headers);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !skip.has(name)) headers[name] = value;
    }
    headers.host = target.host;
    headers["x-forwarded-host"] = req.headers.host ?? "";

    const failed = (error: unknown): void => {
      // A client that went away took the forwarded request with it: nothing to answer or report.
      if (res.destroyed) return;
      console.error(`Failed to proxy ${target.href}`, error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = 500;
      res.end("Internal Server Error");
    };
    const client = target.protocol === "https:" ? https : http;
    const upstream = client.request(target, { method: req.method, headers }, (answer) => {
      res.statusCode = answer.statusCode ?? 502;
      const drop = connectionHeaders(answer.headers);
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !drop.has(name)) res.setHeader(name, value);
      }
      pipeline(answer, res, () => {});
    });
    upstream.setTimeout(BACKEND_TIMEOUT_MS, () =>
      upstream.destroy(new Error("The dataset backend did not answer in time.")),
    );
    upstream.on("error", failed);
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };
}
