/**
 * The site's production server. It runs the start checks, listens at once and holds every request until the start
 * work is done, prewarms the datasets when asked to, and stops cleanly on SIGTERM.
 *
 * This module exports `startServer` and `startWork` (which the dev server shares); it never listens on import.
 * The bundle's `server.mjs` (tools/build/build-server.mjs) sets NODE_ENV and calls `startServer`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { writeServedDatasetClientFiles } from "@/lib/server/dataset-client-files";
import { prewarmDatasetVersions } from "@/lib/server/dataset-query";
import { closeServerResources } from "@/lib/server/lifecycle";
import { checkServerSetupOrExit } from "@/lib/server/startup-checks";
import type { SecurityHeaderEnv } from "@/lib/server/http/security-headers";
import { createApp } from "./app";
import { loadPageTemplate } from "./page/template";
import { installShutdown } from "./shutdown";

export interface StartOptions {
  /** `PORT`, else 3000. 0 takes a free port (the result names it). */
  port?: number;
  /** `HOSTNAME`, else 0.0.0.0: in the container, Caddy reaches the server through the published port. */
  host?: string;
  /** The folder holding `dist/client`, `public` and the site files. */
  cwd?: string;
  prewarm?: () => Promise<void>;
  writeClientFiles?: () => Promise<void>;
  setupCheck?: () => void;
  /** Node's and Next's 300 s, set explicitly: a sender that has not finished its request by then is cut. */
  requestTimeoutMs?: number;
  /** How long open requests may run on after SIGTERM: under compose's 30 s stop timeout. */
  graceMs?: number;
  exit?: (code: number) => void;
  /** What the stop releases after the last request: the database pool. */
  close?: () => Promise<void>;
  /** Whether SIGTERM and SIGINT run the stop. Tests call `shutdown` instead. */
  signals?: boolean;
}

export interface StartedServer {
  server: http.Server;
  /** Settles when requests are let through: after the prewarm, when one runs. */
  ready: Promise<void>;
  port: number;
  /** The stop a signal runs. */
  shutdown: (signal?: "SIGTERM" | "SIGINT") => Promise<void>;
}

const REQUEST_TIMEOUT_MS = 300_000;
const GRACE_MS = 15_000;

/**
 * The work requests wait for, in production and dev alike: with `GTNH_PREWARM_ON_STARTUP=1`, the default
 * dataset version's prewarm (a failure is logged and requests are let through all the same), then the static
 * dataset answers in the background, which requests never wait for.
 */
export async function startWork(
  prewarm: () => Promise<void>,
  writeClientFiles: () => Promise<void>,
): Promise<void> {
  if (process.env.GTNH_PREWARM_ON_STARTUP !== "1") return;
  try {
    // Resolves once the default version is warm; the others follow in the background.
    await prewarm();
    console.info("GTNH default dataset prewarmed; other versions load in the background.");
  } catch (error) {
    console.error("GTNH dataset cache prewarm failed.", error);
  }
  // It logs its own failures.
  void writeClientFiles();
}

/** The security headers' inputs: NEXT_PUBLIC_* as the build inlined them, production from NODE_ENV. */
function securityEnv(): SecurityHeaderEnv {
  return {
    production: process.env.NODE_ENV === "production",
    liveUrl: process.env.NEXT_PUBLIC_LIVE_URL,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    modAndCommunity: process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY,
  };
}

export async function startServer(options: StartOptions = {}): Promise<StartedServer> {
  (options.setupCheck ?? checkServerSetupOrExit)();
  const cwd = options.cwd ?? process.cwd();
  const ready = startWork(
    options.prewarm ?? prewarmDatasetVersions,
    options.writeClientFiles ?? writeServedDatasetClientFiles,
  );
  const clientDir = path.join(cwd, "dist", "client");
  const publicDir = path.join(cwd, "public");
  const app = createApp({
    env: securityEnv(),
    publicDir,
    datasetsDir: path.join(publicDir, "datasets", "gtnh"),
    clientDir,
    template: loadPageTemplate(clientDir),
    siteFilesDir: path.join(cwd, "src", "server", "page", "assets"),
    ready,
    datasetBackendUrl: process.env.GTNH_DATASET_BACKEND_URL?.replace(/\/+$/, "") || undefined,
  });

  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const server = http.createServer(
    {
      requestTimeout,
      // Node's defaults (60 s for the headers, a check every 30 s), held under a shorter request timeout.
      headersTimeout: Math.min(60_000, requestTimeout),
      connectionsCheckingInterval: Math.min(30_000, Math.max(10, Math.floor(requestTimeout / 4))),
    },
    app,
  );
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? (process.env.HOSTNAME || "0.0.0.0");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo).port;

  const shutdown = installShutdown(server, {
    graceMs: options.graceMs ?? GRACE_MS,
    exit: options.exit ?? ((code) => process.exit(code)),
    close: options.close ?? closeServerResources,
  });
  if (options.signals ?? true) {
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }
  // Only once the stop is in place: whoever waits for this line may send SIGTERM at once.
  console.info(`GTNH Planner listening on http://${host}:${bound}`);
  return { server, ready, port: bound, shutdown };
}
