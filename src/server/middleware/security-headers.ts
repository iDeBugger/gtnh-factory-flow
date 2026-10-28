import type { RequestHandler } from "express";
import { headersForPath, type SecurityHeaderEnv } from "@/lib/server/http/security-headers";

/**
 * The security headers on every answer after the redirects: the document policy, or the worker policy under
 * /assets. It runs after `canonicalPath`, so the policy follows the path the router sees. A route's
 * own header of the same name is dropped, as Next dropped it (adapter.ts, `REPEATABLE_HEADERS`).
 */
export function securityHeaders(env: SecurityHeaderEnv): RequestHandler {
  return (req, res, next) => {
    for (const [name, value] of headersForPath(req.path, env)) res.setHeader(name, value);
    next();
  };
}
