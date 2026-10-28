import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TOO_BIG_MESSAGE } from "@/lib/server/http/request-body";
import { startServer, type StartedServer, type StartOptions } from "./main";
import { call } from "./test-support/serve";

const REPO = path.resolve(import.meta.dirname, "../..");
const HASH = `'sha256-${"A".repeat(43)}='`;
const LOGIN = "/api/community/auth/login";

let root: string;
const started: StartedServer[] = [];

/** A folder laid out as the server expects its working folder: the built client, the site files, public/. */
function writeRoot(dir: string): void {
  const client = path.join(dir, "dist", "client");
  mkdirSync(client, { recursive: true });
  writeFileSync(
    path.join(client, "index.html"),
    '<!doctype html><html lang="en"><head><!--app-head--></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(
    path.join(client, "page.json"),
    JSON.stringify({ scriptHashes: [HASH], fontPreloads: [], assetVersions: {} }),
  );
  mkdirSync(path.join(dir, "src", "app"), { recursive: true });
  for (const file of ["favicon.ico", "opengraph-image.png"]) {
    copyFileSync(path.join(REPO, "src", "app", file), path.join(dir, "src", "app", file));
  }
  mkdirSync(path.join(dir, "public"));
}

/** A server on a free loopback port with no signal handlers, no start checks and no real release. */
async function start(options: StartOptions = {}): Promise<StartedServer> {
  const server = await startServer({
    port: 0,
    host: "127.0.0.1",
    cwd: root,
    setupCheck: () => {},
    prewarm: async () => {},
    writeClientFiles: async () => {},
    close: async () => {},
    exit: () => {},
    signals: false,
    ...options,
  });
  started.push(server);
  return server;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Whether a new connection to the port is accepted. */
function connects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Sends `text` raw and resolves with everything the server sent once it closes the socket. */
function sendRaw(port: number, text: string): { closed: Promise<string>; socket: net.Socket } {
  const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
  let received = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => (received += chunk));
  socket.on("error", () => {});
  return {
    socket,
    closed: new Promise((resolve) => socket.once("close", () => resolve(received))),
  };
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "main-"));
  writeRoot(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("GTNH_PREWARM_ON_STARTUP", "1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3770");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const { server } of started.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("startServer", () => {
  it("runs the setup check, then the prewarm, then the client files, in that order", async () => {
    const calls: string[] = [];
    const { ready } = await start({
      setupCheck: () => calls.push("check"),
      prewarm: async () => {
        calls.push("prewarm");
      },
      writeClientFiles: async () => {
        calls.push("files");
      },
    });
    await ready;
    await tick();
    expect(calls).toEqual(["check", "prewarm", "files"]);
    expect(console.info).toHaveBeenCalledWith(
      "GTNH default dataset prewarmed; other versions load in the background.",
    );
  });

  it("prewarms nothing unless GTNH_PREWARM_ON_STARTUP is 1", async () => {
    vi.stubEnv("GTNH_PREWARM_ON_STARTUP", "");
    const prewarm = vi.fn(async () => {});
    const { ready } = await start({ prewarm });
    await ready;
    expect(prewarm).not.toHaveBeenCalled();
  });

  it("holds the first request until the prewarm settles, and serves after a failed prewarm", async () => {
    const warm = deferred();
    const held = await start({ prewarm: () => warm.promise });
    let answered = false;
    const pending = call(held.port, "GET", "/api/version").then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(answered).toBe(false);
    warm.resolve();
    expect((await pending).status).toBe(200);

    const failed = await start({ prewarm: async () => Promise.reject(new Error("no manifest")) });
    expect((await call(failed.port, "GET", "/api/version")).status).toBe(200);
    expect(console.error).toHaveBeenCalledWith(
      "GTNH dataset cache prewarm failed.",
      expect.any(Error),
    );
  });

  it("finishes an open request on shutdown, refuses new connections, closes the database and exits 143", async () => {
    const warm = deferred();
    const order: string[] = [];
    const exit = vi.fn((code: number) => order.push(`exit ${code}`));
    const close = vi.fn(async () => {
      order.push("close");
    });
    const server = await start({ prewarm: () => warm.promise, exit, close });
    const open = call(server.port, "GET", "/api/version");
    await tick();
    const stopped = server.shutdown("SIGTERM");
    await tick();
    expect(await connects(server.port)).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    warm.resolve();
    const answer = await open;
    expect(answer.status).toBe(200);
    await stopped;
    expect(order).toEqual(["close", "exit 143"]);
  });

  it("reads and answers a request body that is still arriving after the stop began", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://127.0.0.1:1/unused");
    const exit = vi.fn();
    const server = await start({ exit });
    const body = JSON.stringify({ username: "", password: "" });
    const half = Math.floor(body.length / 2);
    const { socket, closed } = sendRaw(
      server.port,
      `POST ${LOGIN} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${body.length}\r\n\r\n${body.slice(0, half)}`,
    );
    await tick();
    const stopped = server.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exit).not.toHaveBeenCalled();
    socket.write(body.slice(half));
    const received = await closed;
    await stopped;
    // The route parsed the whole body and the sign-in answered on its fields; a cut body would give
    // "Invalid request body." instead.
    expect(received).toMatch(/^HTTP\/1\.1 400 /);
    expect(received).toContain('{"error":"Username and password required."}');
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("exits 143 within the grace when a client holds a connection open", async () => {
    const exit = vi.fn();
    const server = await start({ exit, graceMs: 200 });
    // Half a request head: the connection is busy, so closing the idle ones leaves it open.
    const { closed } = sendRaw(server.port, "GET /api/version HTTP/1.1\r\nHost: x\r\n");
    await tick();
    const began = Date.now();
    await server.shutdown();
    expect(exit).toHaveBeenCalledWith(143);
    expect(Date.now() - began).toBeGreaterThanOrEqual(150);
    expect(Date.now() - began).toBeLessThan(2_000);
    await closed;
  });

  it("exits 143 within the release bound when closing the database never finishes", async () => {
    for (const graceMs of [60_000, 100]) {
      const exit = vi.fn();
      // graceMs 60 s: the server closes on its own (no request is open); 100 ms: a held request runs the grace out.
      const server = await start({
        exit,
        graceMs,
        close: () => new Promise(() => {}),
        prewarm: graceMs === 100 ? () => new Promise(() => {}) : async () => {},
      });
      if (graceMs !== 100) await server.ready;
      if (graceMs === 100) void call(server.port, "GET", "/api/version").catch(() => {});
      await tick();
      const began = Date.now();
      await server.shutdown();
      expect(exit, `grace ${graceMs}`).toHaveBeenCalledWith(143);
      expect(Date.now() - began, `grace ${graceMs}`).toBeLessThan(3_000);
    }
  }, 15_000);

  it("exits 143 on shutdown while the prewarm is still running", async () => {
    const exit = vi.fn();
    const server = await start({ exit, graceMs: 200, prewarm: () => new Promise(() => {}) });
    const held = call(server.port, "GET", "/api/version").catch((error: unknown) => error);
    await tick();
    await server.shutdown();
    expect(exit).toHaveBeenCalledWith(143);
    expect(await held).toBeInstanceOf(Error);
  });

  it("exits at once on a second signal, and with 130 on SIGINT", async () => {
    const exit = vi.fn();
    const server = await start({ exit, graceMs: 10_000, prewarm: () => new Promise(() => {}) });
    void call(server.port, "GET", "/api/version").catch(() => {});
    await tick();
    void server.shutdown("SIGINT");
    await tick();
    expect(exit).not.toHaveBeenCalled();
    void server.shutdown("SIGINT");
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("uses Node's 300 s request timeout unless told otherwise, and cuts a sender that stops halfway", async () => {
    const plain = await start();
    expect(plain.server.requestTimeout).toBe(300_000);
    expect(plain.server.headersTimeout).toBe(60_000);

    vi.stubEnv("DATABASE_URL", "postgres://127.0.0.1:1/unused");
    const short = await start({ requestTimeoutMs: 300 });
    const began = Date.now();
    const { closed } = sendRaw(
      short.port,
      `POST ${LOGIN} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"user`,
    );
    const received = await closed;
    expect(Date.now() - began).toBeLessThan(3_000);
    expect(received).toMatch(/^HTTP\/1\.1 408 /);
  });

  // The drain's byte and time bounds are adapter.test.ts's: here the whole server delivers the route's answer.
  it("answers 413 to a chunked body over the route's cap and delivers it", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://127.0.0.1:1/unused");
    const server = await start();
    const body = Buffer.alloc(64 * 1024, "a");
    const answer = await call(
      server.port,
      "POST",
      LOGIN,
      { "content-type": "application/json" },
      body,
      { chunkDelayMs: 0, strict: true },
    );
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body.toString())).toEqual({ error: REQUEST_TOO_BIG_MESSAGE });
  });

  it("does not listen when main.ts is imported", async () => {
    const listening = () =>
      (process as unknown as { _getActiveHandles(): unknown[] })
        ._getActiveHandles()
        .filter((handle) => handle instanceof net.Server && handle.listening).length;
    const before = listening();
    vi.resetModules();
    await import("./main");
    expect(listening()).toBe(before);
  });
});

describe("the source entry", () => {
  it("exits 143 on a real SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      [
        path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(REPO, "src/server/test-support/start.ts"),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PORT: "0",
          HOSTNAME: "127.0.0.1",
          GTNH_PREWARM_ON_STARTUP: "",
          DATABASE_URL: "",
          NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3770",
          TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (match) resolve(Number(match[1]));
      });
      child.once("exit", () => reject(new Error(`exited before listening: ${output}`)));
    });
    const answer = await new Promise<number>((resolve, reject) =>
      http
        .get({ host: "127.0.0.1", port, path: "/api/version" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject),
    );
    expect(answer).toBe(200);
    const code = new Promise<number | null>((resolve) =>
      child.once("exit", (exitCode) => resolve(exitCode)),
    );
    child.kill("SIGTERM");
    expect(await code).toBe(143);
  }, 60_000);
});
