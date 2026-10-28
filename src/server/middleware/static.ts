/**
 * The static files, served as Next's own file handler served them: the client build's assets, the public folder
 * and the public dataset tree. Cache headers are serve-static's defaults (`public, max-age=0`, a weak ETag,
 * `Last-Modified`), as Next's were, and a year with `immutable` on the build's hashed assets.
 *
 * Each mount decides on the file the request would resolve to, the way `send` resolves it (decoded once, dot
 * segments normalized, joined under the root), never on a URL segment, and then again on the file the system
 * opens for it (its real path), so neither a spelling of a path, a case-insensitive volume's folding (`ſ` is `s`
 * on APFS) nor a symlink reaches a file the mount must not serve. A request a mount refuses or misses falls
 * through to the routes, then the 404.
 */
import { realpath } from "node:fs";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import express, { type Request, type RequestHandler, type Response } from "express";
import { decideDatasetPath } from "@/lib/server/dataset-path-gate";
import { canonicalParts } from "./normalize-path";
import { sendNextFileError, sendNextPlainError } from "./not-found";

/**
 * The file types of the `mime` 1 table where it differs from serve-static's (mime-db), or where the site's files
 * pin it: the parity fixtures hold these. Any other extension takes serve-static's type.
 */
const MIME1_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".css": "text/css",
  ".html": "text/html",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
};

/**
 * A file answer's `Content-Type`, by `mime` 1's charset rule: `charset=UTF-8` (upper case) on a type that starts
 * with `text/`, `application/javascript` or `application/json`, and no charset on any other.
 */
export function fileContentType(type: string): string {
  const base = type.split(";", 1)[0]!.trim();
  return /^text\/|^application\/(javascript|json)/.test(base) ? `${base}; charset=UTF-8` : base;
}

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

/** A file as the system opens it: its real path, and that path relative to the real root. */
export interface RealFile {
  file: string;
  relative: string;
}

/** The system's own `realpath`, which names each folder and file as the volume spells it on disk. */
const realpathNative = promisify(realpath.native);

/** The real path of `path`, or undefined when nothing is there. */
async function realPathOf(file: string): Promise<string | undefined> {
  try {
    return await realpathNative(file);
  } catch {
    return undefined;
  }
}

/**
 * The file `file` opens, by its real path (every symlink followed, every name as the volume spells it on disk),
 * when that is inside the real `root`; undefined when nothing is there or it lies outside the root.
 */
export async function realFileUnder(root: string, file: string): Promise<RealFile | undefined> {
  const realFile = await realPathOf(file);
  if (!realFile) return undefined;
  const realRoot = await realPathOf(root);
  if (!realRoot) return undefined;
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return { file: realFile, relative };
}

interface MountOptions {
  root: string;
  serve: RequestHandler;
  /** Whether the mount may serve this file, by its spelling; false falls through. */
  allows(req: Request, relative: string): boolean;
  /** Whether the mount may serve the file the system opens; false falls through. */
  allowsReal(req: Request, real: RealFile): boolean | Promise<boolean>;
}

/** Whether `file` is `folder` or inside it. */
function isWithin(file: string, folder: string): boolean {
  return file === folder || file.startsWith(`${folder}${path.sep}`);
}

function guardedMount({ root, serve, allows, allowsReal }: MountOptions): RequestHandler {
  return (req, res, next) => {
    const resolved = resolveLikeSend(root, req.path);
    if (!resolved || !allows(req, resolved.relative)) {
      next();
      return;
    }
    // A dot file is never served (ignored or denied), so a write to one falls through like a miss, unopened.
    if (req.method !== "GET" && req.method !== "HEAD" && hasDotSegment(resolved.relative)) {
      next();
      return;
    }
    realFileUnder(root, resolved.file)
      .then(async (real) => (real && (await allowsReal(req, real)) ? real : undefined))
      .then(
        (real) => (real ? serveAllowed(req, res, next, resolved.file, serve) : next()),
        (error: unknown) => next(error),
      );
  };
}

function serveAllowed(
  req: Request,
  res: Response,
  next: (error?: unknown) => void,
  file: string,
  serve: RequestHandler,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    stat(file).then(
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
}

function serveStatic(root: string, options: { immutable?: boolean; dotfiles: "ignore" | "deny" }) {
  return express.static(root, {
    dotfiles: options.dotfiles,
    index: false,
    redirect: false,
    fallthrough: true,
    ...(options.immutable ? { immutable: true, maxAge: "1y" } : {}),
    setHeaders(res, file) {
      const extension = path.extname(file).toLowerCase();
      let type = MIME1_TYPES[extension];
      if (!type) {
        // serve-static's own type for the extension, from Express's table, before the charset rule.
        (res as unknown as Response).type(extension || "bin");
        type = String(res.getHeader("content-type"));
      }
      res.setHeader("content-type", fileContentType(type));
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
    allowsReal: () => true,
  });
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use("/assets", mount);
  return router;
}

/** Whether a path relative to the public root names `datasets` or anything under it, in any case. */
function namesDatasets(relative: string): boolean {
  const lower = relative.toLowerCase();
  return lower === "datasets" || lower.startsWith(`datasets${path.sep}`);
}

/**
 * The public folder, except anything under `datasets`. The refusal is decided on the resolved file in lower
 * case, so no escaped slash, dot segment or case spelling reaches the data, and then on the file the system
 * opens, which must not lie under the real `datasets` folder (a link to it, or a name the volume folds onto it).
 * The dataset tree has its own mount.
 */
export function publicFiles(publicDir: string): RequestHandler {
  return guardedMount({
    root: publicDir,
    serve: serveStatic(publicDir, { dotfiles: "ignore" }),
    allows: (_req, relative) => !namesDatasets(relative),
    allowsReal: async (_req, real) => {
      if (namesDatasets(real.relative)) return false;
      const datasets = await realPathOf(path.join(publicDir, "datasets"));
      return !datasets || !isWithin(real.file, datasets);
    },
  });
}

/**
 * The public dataset tree, served at `/datasets/gtnh`: the files beside the data (the manifest, reports, the
 * textures that are not named by their bytes). It serves a file only when the dataset gate passes the request's
 * whole canonical path in lower case, and again on the real path of the file it opens, so a case-folded
 * `RECIPES.JSON` or `recipeſ.json` on a case-insensitive file system, or a link to a refused file, is never a
 * file. A miss falls through to the textures route, as Next's file handler did.
 */
export function datasetPublicFiles(datasetsDir: string): RequestHandler {
  const mount = guardedMount({
    root: datasetsDir,
    serve: serveStatic(datasetsDir, { dotfiles: "deny" }),
    allows: (req) => decideDatasetPath(canonicalParts(req).pathname.toLowerCase()).kind === "pass",
    allowsReal: (_req, real) =>
      decideDatasetPath(`/datasets/gtnh/${real.relative.split(path.sep).join("/")}`.toLowerCase())
        .kind === "pass",
  });
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use("/datasets/gtnh", mount);
  return router;
}
