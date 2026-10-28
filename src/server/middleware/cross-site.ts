import type { Request, RequestHandler } from "express";
import { isCrossSiteWrite } from "@/lib/server/http/cross-site";

const REFUSED_BODY = JSON.stringify({ error: "Cross-site request refused." });

/** A request header as Node keeps it: the first value of a single-valued name, the others joined. */
function headerOf(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Refuses a cross-site write to the API (cross-site.ts) with 403. It reads the canonical path only, the pathname
 * Next's proxy checked: `/x/../api/...` and `/x/%2e%2e/api/...` are the API, `/API/...` is not (it matches no
 * route and answers 404), and the `//` and trailing-slash spellings were redirected before this runs. The
 * answer says it varies on the encoding (`Vary: Accept-Encoding`), as the parity fixtures pin.
 */
export function crossSiteWriteGuard(): RequestHandler {
  return (req, res, next) => {
    const request = { method: req.method, headers: { get: (name: string) => headerOf(req, name) } };
    if (!req.path.startsWith("/api/") || !isCrossSiteWrite(request)) {
      next();
      return;
    }
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.setHeader("vary", "Accept-Encoding");
    res.end(REFUSED_BODY);
  };
}
