#!/usr/bin/env node
/**
 * `npm run dev:local`: the whole site on this machine with no Supabase
 * credentials anywhere. Starts, in order:
 *
 * 1. the local database (`tools/local-db/serve.ts`): the PostgREST stand-in on
 *    127.0.0.1:54329 and Postgres's wire protocol on 127.0.0.1:54330
 *    (`DATABASE_URL` for the direct client). When Docker answers, 54330 is
 *    the compose file's pinned `postgres` image in the container
 *    `gtnh-local-db` (data in the volume of that name, kept between runs; the
 *    container stops with dev-local if dev-local started it) and the stand-in
 *    runs over it. Otherwise, or with LOCAL_DB_PGLITE=1, PGlite with data in
 *    scratch/local-db/pgdata and its socket on 54330, which is not isolated
 *    under concurrent load (serve.ts's header has the probe): fine for one
 *    player clicking around, and dev-local says so;
 * 2. the live service (`src/live/main.ts`) on :3001, journal in
 *    scratch/local-db/live-journal;
 * 3. `next dev` on :3000, uploaded files in scratch/local-db/files.
 *
 * Next.js and the live service run with LOCAL_DB=1 and a development-only
 * COMMUNITY_HASH_SALT, so sign-ins made here work only here. Ctrl+C stops
 * everything; the database closes cleanly first.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { containerMismatch } from "./local-db/container.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPort = Number(process.env.LOCAL_DB_PORT ?? 54329);
const livePort = Number(process.env.LIVE_PORT ?? 3001);
const webPort = Number(process.env.PORT ?? 3000);
const dbUrl = `http://127.0.0.1:${dbPort}`;
const pgPort = Number(process.env.LOCAL_DB_PG_PORT ?? 54330);
const directUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
const CONTAINER = "gtnh-local-db";
/** Whether this run started the container, and so stops it. */
let startedContainer = false;

const shared = {
  LOCAL_DB: "1",
  LOCAL_DB_URL: dbUrl,
  // Development only: tokens signed with it are worthless anywhere else.
  COMMUNITY_HASH_SALT: "local-development-salt-not-a-secret",
  LIVE_INTERNAL_TOKEN: "local-development-internal-token",
  LIVE_INTERNAL_URL: `http://127.0.0.1:${livePort}`,
  DATABASE_URL: directUrl,
};

/** The `postgres` image the deploy runs, digest and all, so local SQL meets the same server. */
function composePostgresImage() {
  const compose = readFileSync(path.join(root, "tools", "deploy", "docker-compose.yml"), "utf8");
  const image = /^\s*image:\s*(postgres:\S+)\s*$/m.exec(compose)?.[1];
  if (!image) {
    throw new Error("tools/deploy/docker-compose.yml names no postgres image");
  }
  return image;
}

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
}

/**
 * Starts the local Postgres container (made on first use) and answers
 * whether this run started it. Throws when it cannot.
 */
function startPostgresContainer() {
  const running = docker(["container", "inspect", "-f", "{{.State.Running}}", CONTAINER]);
  if (running.status !== 0) {
    const made = docker([
      "run",
      "--detach",
      "--name",
      CONTAINER,
      "--publish",
      `127.0.0.1:${pgPort}:5432`,
      // Development only: it listens on this machine alone and checks no password.
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--volume",
      `${CONTAINER}:/var/lib/postgresql/data`,
      composePostgresImage(),
    ]);
    if (made.status !== 0) {
      throw new Error(`docker run failed: ${made.stderr.trim()}`);
    }
    return true;
  }
  const inspected = docker([
    "container",
    "inspect",
    "-f",
    "{{json .Config.Image}} {{json .HostConfig.PortBindings}}",
    CONTAINER,
  ]).stdout.trim();
  const [image, portBindings] = inspected.split(" ").map((part) => JSON.parse(part));
  const mismatch = containerMismatch(
    { image, portBindings },
    { image: composePostgresImage(), port: pgPort, name: CONTAINER },
  );
  if (mismatch) {
    throw new Error(mismatch);
  }
  if (running.stdout.trim() === "true") {
    return false;
  }
  const started = docker(["start", CONTAINER]);
  if (started.status !== 0) {
    throw new Error(`docker start failed: ${started.stderr.trim()}`);
  }
  return true;
}

const dockerAnswers = () =>
  process.env.LOCAL_DB_PGLITE !== "1" &&
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 }).status === 0;

const bin = {
  tsx: path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
  next: path.join(root, "node_modules", "next", "dist", "bin", "next"),
};

const children = [];

function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${name}] `;
  const relay = (stream, out) => {
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (text) => {
      buffered += text;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        out.write(line.startsWith(prefix) ? `${line}\n` : `${prefix}${line}\n`);
      }
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code ?? "signal"})`);
    if (!stopping) {
      void stop(1);
    }
  });
  children.push(child);
  return child;
}

async function waitFor(url, label, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} did not start within ${timeoutMs / 1000} s`);
}

let stopping = false;
async function stop(code = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  // The live service first (it stores open plans), then the database, both
  // gently: on Windows a child process gets no signal.
  await fetch(`${shared.LIVE_INTERNAL_URL}/internal/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${shared.LIVE_INTERNAL_TOKEN}` },
  }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await fetch(`${dbUrl}/__local-db/shutdown`, { method: "POST" }).catch(() => undefined);
  const exited = children.map(
    (child) =>
      new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve))),
  );
  await Promise.race([Promise.all(exited), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (startedContainer) {
    docker(["stop", CONTAINER]);
  }
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

// What `npm run dev` does first (its predev script).
spawnSync(process.execPath, ["tools/copy-highs-wasm.mjs"], { cwd: root, stdio: "inherit" });

const dbEnv = { LOCAL_DB_PORT: String(dbPort), LOCAL_DB_PG_PORT: String(pgPort) };
if (dockerAnswers()) {
  startedContainer = startPostgresContainer();
  dbEnv.LOCAL_DB_POSTGRES_URL = directUrl;
  console.log(`[dev-local] Postgres in Docker (${CONTAINER}) on 127.0.0.1:${pgPort}`);
} else {
  // The PGlite socket allows 4 connections: 2 each for Next and the live
  // service, released after a second idle so the other can take its turn.
  Object.assign(shared, { DATABASE_POOL_MAX: "2", DATABASE_POOL_IDLE_MS: "1000" });
  const why = process.env.LOCAL_DB_PGLITE === "1" ? "LOCAL_DB_PGLITE=1" : "Docker is not answering";
  console.log(
    `[dev-local] ${why}: the direct client uses PGlite's socket on 127.0.0.1:${pgPort}, ` +
      "which is not isolated under concurrent queries. Start Docker for a real Postgres.",
  );
}

start("local-db", [bin.tsx, "tools/local-db/serve.ts"], dbEnv);
await waitFor(`${dbUrl}/rest/v1/community_users?select=id&limit=1`, "The local database", 120_000);

if (existsSync(path.join(root, "src", "live", "main.ts"))) {
  start("live", [bin.tsx, "src/live/main.ts"], {
    ...shared,
    LIVE_PORT: String(livePort),
    LIVE_JOURNAL_DIR: path.join(root, "scratch", "local-db", "live-journal"),
    LIVE_ALLOWED_ORIGINS: `http://localhost:${webPort},http://127.0.0.1:${webPort}`,
  });
}

start("next", [bin.next, "dev", "--port", String(webPort)], {
  ...shared,
  NEXT_PUBLIC_LIVE_URL: `ws://localhost:${livePort}/live`,
  // Board images and plan previews.
  FILE_STORE_DIR: path.join(root, "scratch", "local-db", "files"),
  // The origin uploaded board images and other absolute links name.
  NEXT_PUBLIC_SITE_URL: `http://localhost:${webPort}`,
});

console.log(`[dev-local] http://localhost:${webPort} with the local database at ${dbUrl}`);
