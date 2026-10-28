/**
 * The answers Next gave without a route's say: OPTIONS, 405, 404, a decode error in a path param, and its 500.
 * Each matches Next's status and headers (src/server/__fixtures__/next-answers.json, pinned by app.test.ts).
 */
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { headersForPath, type SecurityHeaderEnv } from "../../../security-headers.config";
import {
  DEFAULT_DRAIN,
  drainUnreadBody,
  hasUnreadBody,
  RouteHandlerError,
  type DrainBounds,
} from "../http/adapter";
import { optionsAllow, type RouteModule } from "../http/route-table";

/** A request held for a start that failed. The failure was logged once, where it happened (app.ts). */
export class ServerNotReadyError extends Error {
  constructor(cause: unknown) {
    super("The server did not start.", { cause });
    this.name = "ServerNotReadyError";
  }
}

/** OPTIONS on a route: 204 and the sorted `Allow` Next writes for the route's exports. */
export function optionsAnswer(module: RouteModule): RequestHandler {
  const allow = optionsAllow(module);
  return (_req, res) => {
    res.statusCode = 204;
    res.setHeader("allow", allow);
    res.end();
  };
}

/** A method the route does not export: 405 with no `Allow` and no body, as Next's auto-implemented answer. */
export function methodNotAllowed(): RequestHandler {
  return (_req, res) => {
    res.statusCode = 405;
    res.end();
  };
}

/**
 * Any method but GET and HEAD on a route Next served from its revalidating cache: Next's 405 from that cache, with
 * the two allowed methods as two `Allow` lines and a plain sentence as the body.
 */
export function revalidatedMethodNotAllowed(): RequestHandler {
  return (_req, res) => {
    res.statusCode = 405;
    res.setHeader("allow", ["GET", "HEAD"]);
    res.end("Method Not Allowed");
  };
}

/** Next's no-store rule for its not-found page. */
const NOT_FOUND_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

/**
 * Any path no route, file or page answered. `page` renders the not-found page (page/not-found-page.ts) per
 * answer, as the home page renders its head, so it reads the site's address and community switch when it answers.
 */
export function notFound(page: () => string): RequestHandler {
  return (_req, res) => {
    res.statusCode = 404;
    res.setHeader("cache-control", NOT_FOUND_CACHE_CONTROL);
    res.setHeader("vary", "Accept-Encoding");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(page());
  };
}

/**
 * The router's error for a path param that is not valid percent-encoding (`decodeURIComponent` throws). Only that
 * error gets the decode answer: a handler's own errors arrive wrapped in `RouteHandlerError`, and any other
 * error with a `status` is still a 500.
 */
function isParamDecodeError(error: unknown): boolean {
  if (error instanceof RouteHandlerError) return false;
  const status = (error as { status?: unknown } | null)?.status;
  if (status !== 400) return false;
  return error instanceof URIError || (error as { cause?: unknown }).cause instanceof URIError;
}

/**
 * Next's answer to a malformed escape in a path param: its plain-text 500, sent before its header rules ran, so
 * with none of the security headers. The ETag is Next's for this body.
 */
const NEXT_PLAIN_ERROR_ETAG = '"66fci67lppl"';
const DECODE_ERROR_HEADERS: [string, string][] = [
  ["cache-control", NOT_FOUND_CACHE_CONTROL],
  ["etag", NEXT_PLAIN_ERROR_ETAG],
  ["content-type", "text/plain"],
  ["vary", "Accept-Encoding"],
];

/**
 * Next's plain-text 500 ("Internal Server Error", its ETag for that body), which it sent when a page it rendered
 * for an error did not exist. The headers already on the answer stay.
 */
export function sendNextPlainError(res: Response): void {
  res.statusCode = 500;
  for (const [name, value] of DECODE_ERROR_HEADERS) res.setHeader(name, value);
  res.end("Internal Server Error");
}

/**
 * Next's answer when `send` refused a file it had found (a failed `If-Match` or `If-Unmodified-Since`, a range
 * that is not satisfiable): it rendered an error page the app router does not have, so the status is 500 with its
 * plain-text body and that body's ETag. The file's other headers (its type, `Content-Range`) stay.
 */
export function sendNextFileError(res: Response): void {
  res.statusCode = 500;
  res.setHeader("cache-control", NOT_FOUND_CACHE_CONTROL);
  res.setHeader("etag", NEXT_PLAIN_ERROR_ETAG);
  res.end("Internal Server Error");
}

/**
 * Clears what earlier middleware put on an answer, except `Connection`: a close the stop asked for stays said
 * (shutdown.ts).
 */
function clearHeaders(res: Response): void {
  for (const name of res.getHeaderNames()) if (name !== "connection") res.removeHeader(name);
}

/**
 * Last in the chain. A param decode error answers as Next did; every other error answers Next's own 500: the
 * security headers and an empty body, never a stack. The client keeps its own fallback sentence for a 500. The
 * headers are written here again, so an error raised before the security-header middleware ran still carries
 * them. A request body left unread is drained within the adapter's bounds, then the connection closes.
 */
export function errorHandler(
  env: SecurityHeaderEnv,
  drain: DrainBounds = DEFAULT_DRAIN,
): ErrorRequestHandler {
  // Express knows an error handler by its four parameters, so the unused `next` stays.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (error: unknown, req, res, _next) => {
    if (isParamDecodeError(error)) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      clearHeaders(res);
      if (hasUnreadBody(req)) drainUnreadBody(req, res, drain);
      sendNextPlainError(res);
      return;
    }
    if (!(error instanceof ServerNotReadyError)) {
      console.error(error instanceof RouteHandlerError ? error.cause : error);
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    clearHeaders(res);
    for (const [name, value] of headersForPath(req.path, env)) res.setHeader(name, value);
    // A handler that failed with the body half read left it paused: drain the rest, then close.
    if (hasUnreadBody(req)) drainUnreadBody(req, res, drain);
    res.statusCode = 500;
    res.end();
  };
}
