/**
 * The site as an Express 5 app. Its first middlewares do, in Next's order, what Next did without being asked:
 * the 308s for repeated slashes, backslashes and a trailing slash, then the canonical path, then the security
 * headers. Then the route table, each route with its OPTIONS and 405 answers, then 404 and the error answer.
 */
import express, { type Express, type RequestHandler } from "express";
import type { SecurityHeaderEnv } from "../../security-headers.config";
import { DEFAULT_DRAIN, handle, type DrainBounds } from "./http/adapter";
import { ROUTES, type HttpMethod, type RouteEntry } from "./http/route-table";
import {
  canonicalPath,
  repeatedSlashRedirect,
  trailingSlashRedirect,
} from "./middleware/normalize-path";
import {
  errorHandler,
  methodNotAllowed,
  notFound,
  optionsAnswer,
  revalidatedMethodNotAllowed,
} from "./middleware/not-found";
import { securityHeaders } from "./middleware/security-headers";

export interface AppOptions {
  env: SecurityHeaderEnv;
  publicDir: string;
  datasetsDir: string;
  clientDir?: string;
  /** The page handler, after the routes. */
  page?: RequestHandler;
  /** Requests wait for this before anything answers them (the server's start checks and prewarm). */
  ready?: Promise<void>;
  datasetBackendUrl?: string;
  /** Mounted first, before the ready gate. */
  before?: RequestHandler[];
  /** For tests only: routes mounted ahead of the table. Production passes none. */
  extraRoutes?: RouteEntry[];
  /** For tests only: the drain's bounds instead of the defaults in adapter.ts. */
  drain?: DrainBounds;
}

const EXPRESS_METHOD: Record<
  HttpMethod,
  "get" | "head" | "post" | "put" | "patch" | "delete" | "options"
> = {
  GET: "get",
  HEAD: "head",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
  OPTIONS: "options",
};

/**
 * One route: its handlers, then OPTIONS, then 405 for any other method, all on its own path. Mounted as one block
 * in the table's order, so a path that matches this route is answered by it whatever the method, as in Next.
 */
function mountRoute(app: Express, route: RouteEntry, drain: DrainBounds): void {
  if (route.serving === "static" && route.module.GET) {
    app.all(
      route.path,
      handle(route.module.GET, { drain, defaultCacheControl: STATIC_CACHE_CONTROL }),
    );
    return;
  }
  if (route.serving === "revalidate") {
    if (route.module.GET) app.get(route.path, handle(route.module.GET, { drain }));
    app.all(route.path, revalidatedMethodNotAllowed());
    return;
  }
  for (const [method, handler] of Object.entries(route.module)) {
    if (handler) app[EXPRESS_METHOD[method as HttpMethod]](route.path, handle(handler, { drain }));
  }
  app.options(route.path, optionsAnswer(route.module));
  app.all(route.path, methodNotAllowed());
}

/** What Next put on a force-static route's answer that named no Cache-Control: a year in shared caches. */
const STATIC_CACHE_CONTROL = "s-maxage=31536000";

function readyGate(ready: Promise<void>): RequestHandler {
  return (_req, _res, next) => {
    ready.then(() => next(), next);
  };
}

export function createApp(options: AppOptions): Express {
  const app = express();
  // Settings before any middleware: Next's router is case-sensitive and strict about a trailing slash (the
  // redirect handles that), sends no X-Powered-By and no ETag on a route answer, and its query is plain.
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("query parser", "simple");

  for (const middleware of options.before ?? []) app.use(middleware);
  if (options.ready) app.use(readyGate(options.ready));
  app.use(repeatedSlashRedirect());
  app.use(trailingSlashRedirect());
  app.use(canonicalPath());
  app.use(securityHeaders(options.env));

  const drain = options.drain ?? DEFAULT_DRAIN;
  for (const route of [...(options.extraRoutes ?? []), ...ROUTES]) mountRoute(app, route, drain);
  if (options.page) app.use(options.page);

  app.use(notFound());
  app.use(errorHandler(options.env));
  return app;
}
