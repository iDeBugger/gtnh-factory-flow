/**
 * `npm run dev`: the site on Express with Vite in middleware mode, on `PORT` (3000). The browser code
 * comes from Vite with hot reload; the server code runs under `tsx watch`, which restarts this process when a
 * route or server module changes. The page is the template with the boot scripts and no shell (main.tsx then
 * renders instead of hydrating), and the policy is development's (`'unsafe-inline'` and `'unsafe-eval'`). It also
 * serves the clean card harness at `/dev/clean-card`, which production has no page for.
 *
 * It listens on 127.0.0.1 unless `HOSTNAME` is set, and Vite's `/@fs/` reads only src/ and node_modules
 * (vite.config.ts), so the checkout's other files stay unserved.
 *
 * The start work is production's: the setup checks, and the prewarm when `GTNH_PREWARM_ON_STARTUP=1`.
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { RequestHandler } from "express";
import type { ViteDevServer } from "vite";
import { devListenHost, setDevBuildEnv } from "./dev-env";
import type { PageTemplate } from "./page/template";

const ROOT = path.resolve(__dirname, "../..");
const CLIENT = path.join(ROOT, "src", "client");
const HEAD_MARK = "<!--app-head-->";

/**
 * A dev page: its index.html (relative to src/client) with the boot scripts and the shell mark left empty, run
 * through Vite's HTML transform (its client and React Refresh's preamble) as the page at `url`. The head mark is
 * put back after the transform, at the head's start behind the charset and viewport, so the metadata leads. Read
 * once at start: an edit to an index.html or the boot scripts needs a restart.
 */
async function devTemplate(
  vite: ViteDevServer,
  headLead: string,
  file: string,
  url: string,
): Promise<PageTemplate> {
  const raw = await readFile(path.join(CLIENT, file), "utf8");
  const { appFontBootScript, structuredData, uiScaleBoot } = await import("../client/boot");
  const boot =
    [appFontBootScript, uiScaleBoot].map((script) => `<script>${script}</script>`).join("") +
    `<script type="application/ld+json">${JSON.stringify(structuredData())}</script>`;
  const filled = raw.replace(HEAD_MARK, "").replace("<!--app-boot-->", () => boot);
  const html = (await vite.transformIndexHtml(url, filled)).replace(
    /<head>/,
    () => `<head>${headLead}${HEAD_MARK}`,
  );
  return { html, scriptHashes: [], fontPreloads: [], assetVersions: {} };
}

async function main(): Promise<void> {
  // Before the app's modules load: packages pick their development build, and the server code its dev paths.
  (process.env as Record<string, string | undefined>).NODE_ENV ??= "development";
  const { createServer } = await import("vite");
  const server = http.createServer();
  const vite = await createServer({
    configFile: path.join(ROOT, "vite.config.ts"),
    // The HMR socket shares the site's port, so the page's connect-src 'self' covers it.
    server: { middlewareMode: true, hmr: { server } },
    appType: "custom",
  });
  // Also before the app's modules load: they read the build id and the switch once.
  setDevBuildEnv(process.env, vite.config.define);
  const [
    { checkServerSetupOrExit },
    { prewarmDatasetVersions },
    { writeServedDatasetClientFiles },
    { HEAD_LEAD },
    { createApp },
    { startWork },
    { homePage },
  ] = await Promise.all([
    import("@/lib/server/startup-checks"),
    import("@/lib/server/dataset-query"),
    import("@/lib/server/dataset-client-files"),
    import("@/lib/server/site/head"),
    import("./app"),
    import("./main"),
    import("./page/home"),
  ]);
  checkServerSetupOrExit();

  const ready = startWork(prewarmDatasetVersions, writeServedDatasetClientFiles);
  // The clean card harness (src/client/dev/clean-card), a dev-only page with the site's head: GET and HEAD.
  const cleanCard = homePage(
    await devTemplate(vite, HEAD_LEAD, "dev/clean-card/index.html", "/dev/clean-card/"),
  );
  const cleanCardPage: RequestHandler = (req, res, next) => {
    if (req.path === "/dev/clean-card" && (req.method === "GET" || req.method === "HEAD")) {
      void cleanCard(req, res, next);
      return;
    }
    next();
  };
  const publicDir = path.join(ROOT, "public");
  const app = createApp({
    env: {
      production: false,
      liveUrl: process.env.NEXT_PUBLIC_LIVE_URL,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
      modAndCommunity: process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY,
    },
    publicDir,
    datasetsDir: path.join(publicDir, "datasets", "gtnh"),
    template: await devTemplate(vite, HEAD_LEAD, "index.html", "/"),
    siteFilesDir: path.join(ROOT, "src", "server", "page", "assets"),
    ready,
    datasetBackendUrl: process.env.GTNH_DATASET_BACKEND_URL?.replace(/\/+$/, "") || undefined,
    devMiddlewares: [cleanCardPage, vite.middlewares],
  });
  server.on("request", app);

  const port = Number(process.env.PORT ?? 3000);
  const host = devListenHost(process.env);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.info(`GTNH Planner (dev) on http://${host === "127.0.0.1" ? "localhost" : host}:${port}`);

  const stop = async () => {
    await vite.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

void main().catch((error: unknown) => {
  console.error("The dev server could not start.", error);
  process.exit(1);
});
