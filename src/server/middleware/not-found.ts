/**
 * The answers Next gave without a route's say: OPTIONS, 405, 404, a decode error in a path param, and its 500.
 * Each matches Next's status and headers (src/server/__fixtures__/next-answers.json, pinned by app.test.ts).
 */
import type { ErrorRequestHandler, RequestHandler } from "express";
import { headersForPath, type SecurityHeaderEnv } from "../../../security-headers.config";
import { RouteHandlerError } from "../http/adapter";
import { optionsAllow, type RouteModule } from "../http/route-table";

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

/** What Next's not-found page says, as a page of its own. */
const NOT_FOUND_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
  "<title>404: This page could not be found.</title></head>" +
  "<body><h1>404</h1><h2>This page could not be found.</h2></body></html>";

/** Any path no route, file or page answered. */
export function notFound(): RequestHandler {
  return (_req, res) => {
    res.statusCode = 404;
    res.setHeader("cache-control", NOT_FOUND_CACHE_CONTROL);
    res.setHeader("vary", "Accept-Encoding");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(NOT_FOUND_PAGE);
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
const DECODE_ERROR_HEADERS: [string, string][] = [
  ["cache-control", NOT_FOUND_CACHE_CONTROL],
  ["etag", '"66fci67lppl"'],
  ["content-type", "text/plain"],
  ["vary", "Accept-Encoding"],
];

/**
 * Last in the chain. A param decode error answers as Next did; every other error answers Next's own 500: the
 * security headers and an empty body, never a stack. The client keeps its own fallback sentence for a 500. The
 * headers are written here again, so an error raised before the security-header middleware ran still carries
 * them.
 */
export function errorHandler(env: SecurityHeaderEnv): ErrorRequestHandler {
  // Express knows an error handler by its four parameters, so the unused `next` stays.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (error: unknown, req, res, _next) => {
    if (isParamDecodeError(error)) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      res.statusCode = 500;
      for (const [name, value] of DECODE_ERROR_HEADERS) res.setHeader(name, value);
      res.end("Internal Server Error");
      return;
    }
    console.error(error instanceof RouteHandlerError ? error.cause : error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    for (const name of res.getHeaderNames()) res.removeHeader(name);
    for (const [name, value] of headersForPath(req.path, env)) res.setHeader(name, value);
    res.statusCode = 500;
    res.end();
  };
}
