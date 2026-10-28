/**
 * The request path as Next saw it. Next parses the request target with the WHATWG `URL` parser before it routes,
 * and its proxy, its redirects and its router all read that parsed form. Three middlewares do the same, in Next's
 * order:
 *
 * 1. `repeatedSlashRedirect`: a backslash or a repeated slash in the path answers 308 to the cleaned path.
 * 2. `trailingSlashRedirect`: a path other than `/` that ends in `/` answers 308 to the path without it.
 * 3. `canonicalPath`: `req.url` becomes the WHATWG pathname (dot segments, `%2e` included, resolved; every other
 *    escape kept) plus the raw query, and `req.canonicalUrl` holds the same value.
 *
 * Every later middleware and the router see only the canonical path. The raw target stays in `req.rawTarget`,
 * which only the two redirects read: they run before it is replaced. `req.originalUrl` (Express keeps the raw
 * target there) is read nowhere, so no check can be passed by spelling a path differently.
 */
import querystring from "node:querystring";
import type { RequestHandler, Response } from "express";

declare global {
  // Express's own request type is extended by merging into this namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The request target as it arrived. Read only by the two redirects in this file. */
      rawTarget?: string;
      /** The canonical path plus the raw query: what the handler's `request.url` names. */
      canonicalUrl: string;
    }
  }
}

/** Any base works: only the path and the query of the parsed URL are used. */
const PARSE_BASE = "http://n";

/** The target split at its first `?`, the fragment dropped, as Next splits it. */
function splitTarget(target: string): { path: string; query: string } {
  const noFragment = target.split("#", 1)[0]!;
  const at = noFragment.indexOf("?");
  return at < 0
    ? { path: noFragment, query: "" }
    : { path: noFragment.slice(0, at), query: noFragment.slice(at + 1) };
}

/** Next's `normalizeRepeatedSlashes`: in the path only, `\` becomes `/` and runs of `/` become one. */
export function normalizeRepeatedSlashes(target: string): string {
  const parts = target.split("?");
  const path = parts[0]!.replace(/\\/g, "/").replace(/\/\/+/g, "/");
  return parts[1] ? `${path}?${parts.slice(1).join("?")}` : path;
}

/**
 * Next's 308: `Location`, `Refresh` and the destination as the body. It goes out before the security headers are
 * set, so it carries none, and with no content type, exactly as Next sends it.
 */
function redirect308(res: Response, destination: string): void {
  res.statusCode = 308;
  res.setHeader("location", destination);
  res.setHeader("refresh", `0;url=${destination}`);
  res.end(destination);
}

function rawTargetOf(req: { rawTarget?: string; url: string }): string {
  req.rawTarget ??= req.url;
  return req.rawTarget;
}

export function repeatedSlashRedirect(): RequestHandler {
  return (req, res, next) => {
    const raw = rawTargetOf(req);
    if (!/\\|\/\//.test(raw.split("?", 1)[0]!)) {
      next();
      return;
    }
    const url = new URL(normalizeRepeatedSlashes(raw), PARSE_BASE);
    redirect308(res, url.pathname + url.search);
  };
}

/**
 * The destination of Next's trailing-slash redirect: the WHATWG pathname without its last `/` (escapes kept as
 * sent, characters WHATWG escapes escaped), then the query parsed and written again with `querystring`, as Next's
 * redirect does: `?a` becomes `?a=` and `+` becomes `%20`.
 */
export function trailingSlashDestination(raw: string): string | undefined {
  const { pathname } = new URL(raw, PARSE_BASE);
  if (pathname === "/" || !pathname.endsWith("/")) return undefined;
  const query = querystring.stringify(querystring.parse(splitTarget(raw).query));
  return pathname.slice(0, -1) + (query ? `?${query}` : "");
}

export function trailingSlashRedirect(): RequestHandler {
  return (req, res, next) => {
    const destination = trailingSlashDestination(rawTargetOf(req));
    if (destination === undefined) {
      next();
      return;
    }
    redirect308(res, destination);
  };
}

/** The WHATWG pathname of a target plus its raw query. */
export function canonicalTarget(raw: string): string {
  const { query } = splitTarget(raw);
  const { pathname } = new URL(raw, PARSE_BASE);
  return query ? `${pathname}?${query}` : pathname;
}

export function canonicalPath(): RequestHandler {
  return (req, _res, next) => {
    const canonical = canonicalTarget(rawTargetOf(req));
    req.url = canonical;
    req.canonicalUrl = canonical;
    next();
  };
}
