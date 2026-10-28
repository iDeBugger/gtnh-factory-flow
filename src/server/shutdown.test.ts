import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { RouteEntry } from "./http/route-table";
import { installShutdown } from "./shutdown";

/**
 * The stop's `Connection: close` on answers the app writes itself (its 500s, 404, 405, OPTIONS and the static
 * refusal), and the drain that keeps an answer from being lost when the request's body is still arriving.
 */

let publicDir: string;
let release: () => void = () => {};
let entered = false;
let stopping: { server: http.Server; shutdown: () => Promise<void> } | undefined;
/** The server's side of every connection, so a test can see what the server has read. */
let serverSockets: net.Socket[] = [];

/** A route that waits for `release`, then throws: a 500 that is decided after the stop began. */
const heldThrow: RouteEntry = {
  path: "/api/held-throw",
  source: "test",
  module: {
    GET: async () => {
      entered = true;
      await new Promise<void>((resolve) => (release = resolve));
      throw new Error("thrown on purpose");
    },
  },
};

async function start(
  ready?: Promise<void>,
): Promise<{ port: number; shutdown: () => Promise<void> }> {
  const app = createApp({
    env: { production: true, siteUrl: "http://127.0.0.1:3770" },
    publicDir,
    datasetsDir: path.join(publicDir, "datasets", "gtnh"),
    extraRoutes: [heldThrow],
    ready,
  });
  const server = http.createServer(app);
  serverSockets = [];
  server.on("connection", (socket) => serverSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shutdown = installShutdown(server, {
    graceMs: 5_000,
    exit: () => {},
    close: async () => {},
  });
  stopping = { server, shutdown: () => shutdown() };
  return { port: (server.address() as AddressInfo).port, shutdown: () => shutdown() };
}

/** A socket that writes what it is given and records what comes back, and when the server closed it. */
function connect(port: number): Promise<{
  socket: net.Socket;
  received: () => string;
  closed: Promise<string>;
  isClosed: () => boolean;
}> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    let closed = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.on("error", () => {});
    const closedPromise = new Promise<string>((done) =>
      socket.once("close", () => {
        closed = true;
        done(received);
      }),
    );
    socket.once("connect", () =>
      resolve({ socket, received: () => received, closed: closedPromise, isClosed: () => closed }),
    );
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const began = Date.now();
  while (!check()) {
    if (Date.now() - began > ms) throw new Error("timed out");
    await wait(5);
  }
}

/**
 * Writes `text` and waits until the server has read all of it. A connection the server has read nothing from
 * is idle, and the stop closes idle connections at once, so a half-sent head must have been read before it.
 */
async function sendAndRead(socket: net.Socket, text: string): Promise<void> {
  const before = serverSockets.reduce((sum, server) => sum + server.bytesRead, 0);
  socket.write(text);
  const length = Buffer.byteLength(text);
  await until(
    () => serverSockets.reduce((sum, server) => sum + server.bytesRead, 0) >= before + length,
  );
}

beforeAll(() => {
  publicDir = mkdtempSync(path.join(tmpdir(), "shutdown-"));
  writeFileSync(path.join(publicDir, "file.txt"), "a public file\n");
});

afterAll(() => {
  rmSync(publicDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  release();
  if (stopping) {
    stopping.server.closeAllConnections();
    await new Promise<void>((resolve) => stopping!.server.close(() => resolve()));
    stopping = undefined;
  }
  vi.restoreAllMocks();
});

describe("after the stop began", () => {
  it("says Connection: close on a 500 decided after the stop, though the error answer resets the headers", async () => {
    const { port, shutdown } = await start();
    const client = await connect(port);
    client.socket.write(
      "GET /api/held-throw HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n",
    );
    entered = false;
    await until(() => entered);
    const stopped = shutdown();
    release();
    const received = await client.closed;
    expect(received).toMatch(/^HTTP\/1\.1 500 /);
    expect(received).toMatch(/\r\nConnection: close\r\n/i);
    expect(received).not.toMatch(/keep-alive/i);
    await stopped;
  });

  it("says Connection: close on the 500 for a malformed escape, sent after the stop", async () => {
    const { port, shutdown } = await start();
    const client = await connect(port);
    // Half a head, read before the stop, so the connection is busy and not closed as idle.
    await sendAndRead(client.socket, "GET /api/datasets/%E0%A4%A/catalog HTTP/1.1\r\nHost: x\r\n");
    const stopped = shutdown();
    client.socket.write("Connection: keep-alive\r\n\r\n");
    const received = await client.closed;
    expect(received).toMatch(/^HTTP\/1\.1 500 /);
    expect(received).toMatch(/\r\nConnection: close\r\n/i);
    await stopped;
  });

  for (const [label, method, target, status] of [
    ["a 404", "POST", "/no-such-page", 404],
    ["a 405", "PATCH", "/api/version", 405],
    ["an OPTIONS answer", "OPTIONS", "/api/version", 204],
    ["the static refusal of a write to a file", "POST", "/file.txt", 500],
  ] as const) {
    it(`reads the rest of a body still arriving before it closes, after ${label}`, async () => {
      const { port, shutdown } = await start();
      const client = await connect(port);
      await sendAndRead(client.socket, `${method} ${target} HTTP/1.1\r\nHost: x\r\n`);
      const stopped = shutdown();
      client.socket.write(
        "Connection: keep-alive\r\nContent-Type: text/plain\r\nContent-Length: 10\r\n\r\n12345",
      );
      await until(() => /\r\n\r\n/.test(client.received()));
      expect(client.received()).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `));
      expect(client.received()).toMatch(/\r\nConnection: close\r\n/i);
      // The answer is out, but the socket stays open while the body still arrives: a close now would reset the
      // connection under the unread bytes and could take the answer with it.
      await wait(150);
      expect(client.isClosed()).toBe(false);
      client.socket.write("67890");
      await client.closed;
      await stopped;
    });
  }
});
