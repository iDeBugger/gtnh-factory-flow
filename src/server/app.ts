/**
 * The site as an Express 5 app. Its first middlewares do, in Next's order, what Next did without being asked:
 * the 308s for repeated slashes, backslashes and a trailing slash, then the canonical path, then the security
 * headers, then what Next's proxy did (the dataset path gate and the cross-site write check), then the dataset
 * backend and the own middlewares (Vite's) of a development server, then the static files. Then the site files, the route table (each route with
 * its OPTIONS and 405 answers), the page and `/community`, the 404 and the error answer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Express, type RequestHandler } from "express";
import { documentPolicy, type SecurityHeaderEnv } from "@/lib/server/http/security-headers";
import { DEFAULT_DRAIN, handle, type DrainBounds } from "./http/adapter";
import { ROUTES, type HttpMethod, type RouteEntry } from "./http/route-table";
import { crossSiteWriteGuard } from "./middleware/cross-site";
import { datasetBackendProxy } from "./middleware/dataset-backend";
import { datasetGate } from "./middleware/dataset-gate";
import {
  canonicalPath,
  repeatedSlashRedirect,
  routableTarget,
  trailingSlashRedirect,
} from "./middleware/normalize-path";
import {
  errorHandler,
  methodNotAllowed,
  notFound,
  optionsAnswer,
  ServerNotReadyError,
} from "./middleware/not-found";
import { securityHeaders } from "./middleware/security-headers";
import { clientAssets, datasetPublicFiles, publicFiles } from "./middleware/static";
import { renderNotFoundPage } from "./page/not-found-page";
import { communityRedirect } from "./page/community";
import { homePage } from "./page/home";
import { siteRoutes } from "./page/site-routes";
import type { PageTemplate } from "./page/template";

export interface AppOptions {
  env: SecurityHeaderEnv;
  /** The folder served at `/` (everything under its `datasets` folder excepted). */
  publicDir: string;
  /** The folder served at `/datasets/gtnh`: the published datasets. */
  datasetsDir: string;
  /** The client build: its `assets` folder is served at `/assets`. */
  clientDir?: string;
  /**
   * The built page (`loadPageTemplate`), served at `/` with its head per request. Its inline script hashes
   * become the document policy's script sources, so production needs no `'unsafe-inline'` for scripts.
   */
  template?: PageTemplate;
  /** The folder holding `favicon.ico` and `opengraph-image.png`: with it, the site files are served. */
  siteFilesDir?: string;
  /** Requests wait for this before anything answers them (the server's start checks and prewarm). */
  ready?: Promise<void>;
  /** A development server's dataset backend (`GTNH_DATASET_BACKEND_URL`). */
  datasetBackendUrl?: string;
  /** Mounted first, before the ready gate. */
  before?: RequestHandler[];
  /**
   * A development server's own middlewares (Vite's). Mounted after the redirects, the canonical path, the
   * security headers, the dataset gate and the cross-site check, so dev answers through the same gate and
   * redirects as production, and ahead of the static files and the routes.
   */
  devMiddlewares?: RequestHandler[];
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
  for (const [method, handler] of Object.entries(route.module)) {
    if (handler) app[EXPRESS_METHOD[method as HttpMethod]](route.path, handle(handler, { drain }));
  }
  app.options(route.path, optionsAnswer(route.module));
  app.all(route.path, methodNotAllowed());
}

type AppHandle = (req: IncomingMessage, res: ServerResponse, next?: unknown) => void;

/** What Next put on a force-static route's answer that named no Cache-Control: a year in shared caches. */
const STATIC_CACHE_CONTROL = "s-maxage=31536000";

/**
 * Holds every request until `ready` settles. A start that failed is logged once, here, and each request then gets
 * the 500 without its own log line.
 */
function readyGate(ready: Promise<void>): RequestHandler {
  const outcome = ready.then(
    () => undefined,
    (error: unknown) => {
      console.error("The server failed to start.", error);
      return new ServerNotReadyError(error);
    },
  );
  return (_req, _res, next) => {
    void outcome.then((failed) => (failed ? next(failed) : next()));
  };
}

export function createApp(options: AppOptions): Express {
  const env: SecurityHeaderEnv = options.template
    ? { ...options.env, scriptHashes: options.template.scriptHashes, requireScriptHashes: true }
    : options.env;
  // Built once here, so a policy that cannot be built (a page without its script hashes) stops the start
  // instead of failing every answer.
  documentPolicy(env);
  const app = express();
  // Before the router: a target it cannot parse would skip every middleware, so it is given one it can.
  // Express's types leave out `handle`, the method `app(req, res)` calls.
  const routed = app as unknown as { handle: AppHandle };
  const handle = routed.handle.bind(app);
  routed.handle = (req, res, next) => {
    req.url = routableTarget(req.url ?? "/");
    handle(req, res, next);
  };
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
  app.use(securityHeaders(env));
  app.use(datasetGate());
  app.use(crossSiteWriteGuard());
  if (options.datasetBackendUrl) app.use(datasetBackendProxy(options.datasetBackendUrl));
  for (const middleware of options.devMiddlewares ?? []) app.use(middleware);
  if (options.clientDir) app.use(clientAssets(options.clientDir));
  app.use(publicFiles(options.publicDir));
  app.use(datasetPublicFiles(options.datasetsDir));

  if (options.siteFilesDir) app.use(siteRoutes({ filesDir: options.siteFilesDir }));
  const drain = options.drain ?? DEFAULT_DRAIN;
  for (const route of [...(options.extraRoutes ?? []), ...ROUTES]) mountRoute(app, route, drain);
  if (options.template) {
    app.all("/", homePage(options.template));
    app.all("/community", communityRedirect(options.template));
  }

  const template = options.template;
  // Rendered once here, so a page template the not-found page cannot be cut from stops the start instead of
  // turning every 404 into a 500. Each answer still renders its own, with the site address it reads then.
  renderNotFoundPage(template);
  app.use(notFound(() => renderNotFoundPage(template)));
  app.use(errorHandler(env, drain));
  return app;
}
