/**
 * The static files, served as Next's own file handler served them: the client build's assets, the public folder
 * and the public dataset tree. Cache headers are serve-static's defaults (`public, max-age=0`, a weak ETag,
 * `Last-Modified`), as Next's were, and a year with `immutable` on the build's hashed assets.
 *
 * Each mount decides on the file the request would resolve to, the way `send` resolves it (decoded once, dot
 * segments normalized, joined under the root), never on a URL segment, so no spelling of a path reaches a file
 * the mount must not serve. A request a mount refuses or misses falls through to the routes, then the 404.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import express, { type Request, type RequestHandler, type Response } from "express";
import { decideDatasetPath } from "@/lib/server/dataset-path-gate";
import { canonicalParts } from "./normalize-path";
import { sendNextFileError, sendNextPlainError } from "./not-found";

/**
 * The content types Next's file handler sent, where they differ from serve-static's: Next typed files with the
 * `mime` 1 table and its charset rule (`UTF-8`, upper case, on text, JavaScript and JSON only).
 */
const NEXT_CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=UTF-8",
  ".mjs": "application/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".map": "application/json; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".html": "text/html; charset=UTF-8",
  ".txt": "text/plain; charset=UTF-8",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
};

/**
 * The types Next's compression counted as compressible, among those the site serves. Next put `Vary:
 * Accept-Encoding` on a file answer of such a type (whatever the request accepted); Caddy compresses now, and the
 * header stays as Next sent it.
 */
const COMPRESSIBLE_TYPE =
  /^(?:text\/[^;]+|[^;]+\+(?:json|text|xml)|application\/(?:javascript|json|wasm|xml)|image\/x-icon)(?:;|$)/i;

/** A file's path under `root` the way `send` resolves a URL path, or undefined when `send` would refuse it. */
export function resolveLikeSend(
  root: string,
  urlPath: string,
): { file: string; relative: string } | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const normalized = path.normalize(`.${path.sep}${decoded}`);
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(normalized)) return undefined;
  const file = path.normalize(path.join(root, normalized));
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return { file, relative };
}

function hasDotSegment(relative: string): boolean {
  return relative.split(/[\\/]/).some((segment) => segment.startsWith("."));
}

/**
 * Next's answer to any method but GET and HEAD on a file it would serve: it set `Allow: GET, HEAD` and rendered
 * its 405 page, which the app router does not have, so the answer is its plain-text 500.
 */
function fileMethodNotAllowed(res: Response): void {
  res.setHeader("allow", ["GET", "HEAD"]);
  sendNextPlainError(res);
}

/**
 * `Vary: Accept-Encoding` on a compressible answer, decided when the head is written: after `send` has set the
 * type, and gone again on a 304, which carries none. Undone when the mount falls through.
 */
function varyOnCompressibleType(res: Response): () => void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, ...args: unknown[]) {
    const type = res.getHeader("content-type");
    const cacheControl = String(res.getHeader("cache-control") ?? "");
    if (
      typeof type === "string" &&
      COMPRESSIBLE_TYPE.test(type) &&
      !/no-transform/i.test(cacheControl)
    ) {
      res.setHeader("vary", "Accept-Encoding");
    }
    return (writeHead as (...a: unknown[]) => Response).apply(this, args);
  } as Response["writeHead"];
  return () => {
    res.writeHead = writeHead;
  };
}

interface MountOptions {
  root: string;
  serve: RequestHandler;
  /** Whether the mount may serve this file at all; false falls through. */
  allows(req: Request, relative: string): boolean;
}

function guardedMount({ root, serve, allows }: MountOptions): RequestHandler {
  return (req, res, next) => {
    const resolved = resolveLikeSend(root, req.path);
    if (!resolved || !allows(req, resolved.relative)) {
      next();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      // A dot file is never served (ignored or denied), so a write to one falls through like a miss.
      if (hasDotSegment(resolved.relative)) {
        next();
        return;
      }
      stat(resolved.file).then(
        (stats) => (stats.isFile() ? fileMethodNotAllowed(res) : next()),
        () => next(),
      );
      return;
    }
    const restore = varyOnCompressibleType(res);
    serve(req, res, (error?: unknown) => {
      const status = (error as { statusCode?: unknown } | undefined)?.statusCode;
      if ((status === 412 || status === 416) && !res.headersSent) {
        sendNextFileError(res);
        return;
      }
      restore();
      next(error);
    });
  };
}

function serveStatic(root: string, options: { immutable?: boolean; dotfiles: "ignore" | "deny" }) {
  return express.static(root, {
    dotfiles: options.dotfiles,
    index: false,
    redirect: false,
    fallthrough: true,
    ...(options.immutable ? { immutable: true, maxAge: "1y" } : {}),
    setHeaders(res, file) {
      const type = NEXT_CONTENT_TYPES[path.extname(file).toLowerCase()];
      if (type) res.setHeader("content-type", type);
    },
  });
}

/** The client build's hashed files under `/assets/`, kept a year. */
export function clientAssets(clientDir: string): RequestHandler {
  const root = path.join(clientDir, "assets");
  const mount = guardedMount({
    root,
    serve: serveStatic(root, { immutable: true, dotfiles: "ignore" }),
    allows: () => true,
  });
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use("/assets", mount);
  return router;
}

/**
 * The public folder, except anything under `datasets`, decided on the resolved file and in lower case, so no
 * escaped slash, dot segment or case spelling reaches the data. The dataset tree has its own mount.
 */
export function publicFiles(publicDir: string): RequestHandler {
  return guardedMount({
    root: publicDir,
    serve: serveStatic(publicDir, { dotfiles: "ignore" }),
    allows: (_req, relative) => {
      const lower = relative.toLowerCase();
      return lower !== "datasets" && !lower.startsWith(`datasets${path.sep}`);
    },
  });
}

/**
 * The public dataset tree, served at `/datasets/gtnh`: the files beside the data (the manifest, reports, the
 * textures that are not named by their bytes). It serves a file only when the dataset gate passes the request's
 * whole canonical path in lower case, so a case-folded `RECIPES.JSON` on a case-insensitive file system is never
 * a file. A miss falls through to the textures route, as Next's file handler did.
 */
export function datasetPublicFiles(datasetsDir: string): RequestHandler {
  const mount = guardedMount({
    root: datasetsDir,
    serve: serveStatic(datasetsDir, { dotfiles: "deny" }),
    allows: (req) => decideDatasetPath(canonicalParts(req).pathname.toLowerCase()).kind === "pass",
  });
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use("/datasets/gtnh", mount);
  return router;
}
