import http from "node:http";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BOARD_IMAGE_MAX_BYTES, UPLOAD_FORM_OVERHEAD_BYTES } from "@/lib/community/types";
import { PROXY_BODY_MAX_BYTES } from "@/lib/server/http/request-body";
import { createApp, type AppOptions } from "../app";
import { call, listen, type Listening } from "../test-support/serve";
import { DRAIN_IDLE_MS, DRAIN_MAX_BYTES, DRAIN_TOTAL_MS, type DrainBounds } from "./adapter";
import type { RouteEntry } from "./route-table";

/**
 * The adapter between Express and the route handlers' web Request and Response, over real sockets: headers, params,
 * the URL's origin, streaming, the hard cap, and the drain that keeps a route's early 413 deliverable.
 */

const SITE = "http://127.0.0.1:3770";
const MiB = 1024 * 1024;
const IMAGES = "/api/community/images";
const routeTooLargeBody = { error: "That image is too big: the limit is 4 MB." };
const sixMiB = Buffer.alloc(6 * MiB, 1);

let releaseStream: () => void = () => {};
let signalAborted = false;
let signalSeen: () => void = () => {};

const routes: RouteEntry[] = [
  {
    path: "/api/t/cookies",
    source: "test",
    module: {
      GET: () => {
        const headers = new Headers({ "content-type": "text/plain" });
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/; HttpOnly");
        return new Response("ok", { headers });
      },
    },
  },
  {
    path: "/api/t/own-headers",
    source: "test",
    module: {
      GET: () => {
        const headers = new Headers({
          "content-security-policy": "default-src 'none'",
          "x-frame-options": "DENY",
          vary: "Origin",
          "www-authenticate": "Basic",
          "x-own": "kept",
        });
        return new Response("ok", { headers });
      },
    },
  },
  {
    path: "/api/t/headers",
    source: "test",
    module: { POST: (request) => Response.json(Object.fromEntries(request.headers)) },
  },
  {
    path: "/api/t/throw-mid-body",
    source: "test",
    module: {
      POST: async (request) => {
        await request.body!.getReader().read();
        throw new Error("failed with the body half read");
      },
    },
  },
  {
    path: "/api/t/redirect",
    source: "test",
    module: { GET: () => Response.redirect(`${SITE}/elsewhere`, 302) },
  },
  {
    path: "/api/t/params/:id/*rest",
    source: "test",
    module: { GET: async (_request, { params }) => Response.json(await params) },
  },
  {
    path: "/api/t/url",
    source: "test",
    module: { GET: (request) => Response.json({ url: request.url }) },
  },
  {
    path: "/api/t/stream",
    source: "test",
    module: {
      GET: () => {
        const encoder = new TextEncoder();
        const released = new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("first;"));
            await released;
            controller.enqueue(encoder.encode("second"));
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/plain" } });
      },
    },
  },
  {
    path: "/api/t/read-all",
    source: "test",
    module: {
      POST: async (request) => {
        try {
          const bytes = await request.arrayBuffer();
          return Response.json({ read: bytes.byteLength });
        } catch (error) {
          return Response.json({ error: (error as Error).name });
        }
      },
    },
  },
  {
    path: "/api/t/signal",
    source: "test",
    module: {
      GET: (request) =>
        new Promise<Response>((resolve) => {
          request.signal.addEventListener("abort", () => {
            signalAborted = true;
            signalSeen();
            resolve(new Response(null, { status: 204 }));
          });
        }),
    },
  },
];

const baseOptions: AppOptions = {
  env: { production: true, siteUrl: SITE },
  publicDir: "/nonexistent",
  datasetsDir: "/nonexistent",
  extraRoutes: routes,
};

const servers: Listening[] = [];
async function serve(drain?: DrainBounds): Promise<Listening> {
  const listening = await listen(createApp({ ...baseOptions, ...(drain ? { drain } : {}) }));
  servers.push(listening);
  return listening;
}

let server: Listening;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  // The image route answers 503 unless a database is named; its 413 comes before any query.
  vi.stubEnv("DATABASE_URL", "postgres://unused@127.0.0.1:1/unused");
  server = await serve();
});

afterEach(() => {
  signalAborted = false;
});

afterAll(async () => {
  await Promise.all(servers.map((listening) => listening.close()));
  vi.unstubAllEnvs();
});

function header(headers: [string, string][], name: string): string[] {
  return headers.filter(([key]) => key === name).map(([, value]) => value);
}

const serverBytesRead = (listening: Listening): number =>
  listening.sockets.reduce((sum, socket) => sum + socket.bytesRead, 0);

const waitFor = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * A client on a bare socket: sends the head of an upload with a declared length, then what `send` writes, and
 * resolves with the milliseconds until the server closed the connection and what the server sent.
 */
function closedAfter(
  port: number,
  declared: number,
  send: (socket: net.Socket) => void,
  target = IMAGES,
): Promise<{ ms: number; received: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let started = 0;
    let received = "";
    socket.on("error", () => {});
    // Read what arrives, so the server's close is seen.
    socket.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
    socket.on("close", () => resolve({ ms: Date.now() - started, received }));
    socket.on("connect", () => {
      socket.write(
        `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary=x\r\n` +
          `Content-Length: ${declared}\r\n\r\n`,
      );
      started = Date.now();
      send(socket);
    });
    setTimeout(() => reject(new Error("never closed")), 10_000);
  });
}

describe("the adapter", () => {
  it("passes several Set-Cookie headers through one by one", async () => {
    const answer = await call(server.port, "GET", "/api/t/cookies");
    expect(header(answer.headers, "set-cookie")).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly"]);
  });

  it("keeps the security headers over a route's own of the same name, and adds Vary and the rest, as Next did", async () => {
    const site = await call(server.port, "GET", "/api/t/url");
    const answer = await call(server.port, "GET", "/api/t/own-headers");
    expect(header(answer.headers, "content-security-policy")).toEqual(
      header(site.headers, "content-security-policy"),
    );
    expect(header(answer.headers, "content-security-policy")[0]).not.toBe("default-src 'none'");
    expect(header(answer.headers, "x-frame-options")).toEqual(["SAMEORIGIN"]);
    expect(header(answer.headers, "vary")).toEqual(["Origin"]);
    expect(header(answer.headers, "www-authenticate")).toEqual(["Basic"]);
    expect(header(answer.headers, "x-own")).toEqual(["kept"]);
  });

  it("gives the handler a repeated request header as Node and Next keep it: the first of a single-valued one", async () => {
    const answer = await call(
      server.port,
      "POST",
      "/api/t/headers",
      [
        ["host", "first.example"],
        ["host", "second.example"],
        ["content-type", "multipart/form-data; boundary=x"],
        ["content-type", "text/plain"],
        ["authorization", "Bearer one"],
        ["authorization", "Bearer two"],
        ["x-many", "a"],
        ["x-many", "b"],
        ["cookie", "a=1"],
        ["cookie", "b=2"],
        ["content-length", "0"],
      ],
      "",
    );
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body.toString())).toMatchObject({
      host: "first.example",
      "content-type": "multipart/form-data; boundary=x",
      authorization: "Bearer one",
      "x-many": "a, b",
      cookie: "a=1; b=2",
    });
  });

  it("copies the headers of a Response whose headers are immutable, without changing them", async () => {
    const answer = await call(server.port, "GET", "/api/t/redirect");
    expect(answer.status).toBe(302);
    expect(header(answer.headers, "location")).toEqual([`${SITE}/elsewhere`]);
    expect(header(answer.headers, "x-frame-options")).toEqual(["SAMEORIGIN"]);
  });

  it("passes params from :id and *rest as the handler's context", async () => {
    const answer = await call(server.port, "GET", "/api/t/params/a%20b/x/y%2Fz");
    expect(JSON.parse(answer.body.toString())).toEqual({ id: "a b", rest: ["x", "y/z"] });
  });

  it("gives the handler a URL on siteUrl()'s origin, whatever Host says", async () => {
    const answer = await call(server.port, "GET", "/api/t/url?q=1", { host: "evil.example" });
    expect(JSON.parse(answer.body.toString())).toEqual({ url: `${SITE}/api/t/url?q=1` });
  });

  it("gives the handler the canonical URL, not the raw target", async () => {
    const answer = await call(server.port, "GET", "/api/t/x/../url?a=%zz");
    expect(JSON.parse(answer.body.toString())).toEqual({ url: `${SITE}/api/t/url?a=%zz` });
  });

  it("streams a body of unknown length without buffering it", async () => {
    const first = await new Promise<{ chunk: string; rest: Promise<string>; encoding?: string }>(
      (resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port: server.port, path: "/api/t/stream" }, (response) => {
            response.setEncoding("utf8");
            let rest = "";
            const ended = new Promise<string>((done) => response.on("end", () => done(rest)));
            response.once("data", (chunk: string) => {
              response.on("data", (more: string) => (rest += more));
              resolve({ chunk, rest: ended, encoding: response.headers["transfer-encoding"] });
            });
          })
          .on("error", reject);
      },
    );
    expect(first.chunk).toBe("first;");
    expect(first.encoding).toBe("chunked");
    releaseStream();
    expect(await first.rest).toBe("second");
  });

  it("errors the request body past the hard cap", async () => {
    const body = Buffer.alloc(PROXY_BODY_MAX_BYTES + 64 * 1024, 2);
    const answer = await call(server.port, "POST", "/api/t/read-all", {}, body);
    expect(JSON.parse(answer.body.toString())).toEqual({ error: "BodyTooLargeError" });
  });

  it("reads a body under the hard cap whole, and keeps the connection open", async () => {
    const answer = await call(server.port, "POST", "/api/t/read-all", {}, Buffer.alloc(MiB, 3));
    expect(JSON.parse(answer.body.toString())).toEqual({ read: MiB });
    expect(header(answer.headers, "connection")).toEqual(["keep-alive"]);
  });

  it("gives every client of a concurrent batch the route's 413 status and body for an over-cap Content-Length upload", async () => {
    const answers = await Promise.all(
      Array.from({ length: 30 }, () =>
        call(
          server.port,
          "POST",
          IMAGES,
          {
            "content-type": "multipart/form-data; boundary=x",
            "content-length": String(sixMiB.length),
          },
          sixMiB,
          { strict: true },
        ),
      ),
    );
    for (const answer of answers) {
      expect(answer.status).toBe(413);
      expect(JSON.parse(answer.body.toString())).toEqual(routeTooLargeBody);
      expect(header(answer.headers, "connection")).toEqual(["close"]);
    }
  }, 60_000);

  it("stops draining at the byte bound and closes", async () => {
    const bounded = await serve({ maxBytes: MiB, idleMs: 10_000, totalMs: 20_000 });
    const sixtyFourMiB = Buffer.alloc(64 * MiB, 4);
    const answer = await call(
      bounded.port,
      "POST",
      IMAGES,
      { "content-type": "multipart/form-data; boundary=x", "content-length": String(64 * MiB) },
      sixtyFourMiB,
    ).catch((error: NodeJS.ErrnoException) => ({ error }));
    if ("status" in answer) expect(answer.status).toBe(413);
    else expect(answer.error.code).toMatch(/^(ECONNRESET|EPIPE)$/);
    await waitFor(() => bounded.sockets.every((socket) => socket.destroyed));
    expect(serverBytesRead(bounded)).toBeLessThanOrEqual(
      MiB + BOARD_IMAGE_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES + 64 * 1024,
    );
  }, 30_000);

  it("delivers the 413 to a slow but steady over-cap upload that runs longer than the idle bound in total", async () => {
    const slow = await serve({ maxBytes: DRAIN_MAX_BYTES, idleMs: 300, totalMs: 5_000 });
    const answer = await call(
      slow.port,
      "POST",
      IMAGES,
      {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(sixMiB.length),
      },
      sixMiB,
      { strict: true, chunkDelayMs: 20 },
    );
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body.toString())).toEqual(routeTooLargeBody);

    // A sender that ignores the early answer and sends its whole body, 64 KiB every 20 ms (about 2 s, more than
    // six idle bounds): every chunk resets the idle timer, so the drain reads to the end, and only then closes.
    const sent = { bytes: 0 };
    const steady = await closedAfter(slow.port, sixMiB.length, (socket) => {
      const timer = setInterval(() => {
        if (socket.destroyed || sent.bytes >= sixMiB.length) return clearInterval(timer);
        socket.write(sixMiB.subarray(sent.bytes, sent.bytes + 64 * 1024));
        sent.bytes += 64 * 1024;
      }, 20);
    });
    expect(steady.received).toMatch(/^HTTP\/1\.1 413 /);
    expect(steady.received).toContain(JSON.stringify(routeTooLargeBody));
    expect(sent.bytes).toBe(sixMiB.length);
    expect(steady.ms).toBeGreaterThan(1_500);
  }, 30_000);

  it("stops draining at the idle bound when the sender stalls, and at the total bound when it trickles", async () => {
    const bounded = await serve({ maxBytes: DRAIN_MAX_BYTES, idleMs: 300, totalMs: 1_000 });
    const stalled = await closedAfter(bounded.port, 6 * MiB, (socket) => {
      socket.write(Buffer.alloc(64 * 1024));
    });
    expect(stalled.ms).toBeGreaterThanOrEqual(250);
    expect(stalled.ms).toBeLessThan(900);

    const trickled = await closedAfter(bounded.port, 6 * MiB, (socket) => {
      const timer = setInterval(() => {
        if (socket.destroyed) clearInterval(timer);
        else socket.write("x");
      }, 200);
      socket.on("close", () => clearInterval(timer));
    });
    expect(trickled.ms).toBeGreaterThanOrEqual(900);
    expect(trickled.ms).toBeLessThan(2_000);
  }, 30_000);

  it("drains the rest of the body and closes when a handler fails mid-body, so the 500 arrives and nothing hangs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A client that sends the whole body whatever it is told, past the hard cap, so the handler's own body
      // stream would have paused the request and stalled the drain.
      const fresh = await serve();
      const { ms, received } = await closedAfter(
        fresh.port,
        6 * MiB,
        (socket) => socket.write(sixMiB),
        "/api/t/throw-mid-body",
      );
      expect(received).toMatch(/^HTTP\/1\.1 500 /);
      expect(received.toLowerCase()).toContain("connection: close");
      expect(ms).toBeLessThan(3_000);
      expect(serverBytesRead(fresh)).toBeGreaterThan(6 * MiB);
      expect(log).toHaveBeenCalledTimes(1);

      const bounded = await serve({ maxBytes: MiB, idleMs: 300, totalMs: 1_000 });
      const started = Date.now();
      const cut = await call(
        bounded.port,
        "POST",
        "/api/t/throw-mid-body",
        { "content-length": String(64 * MiB) },
        Buffer.alloc(64 * MiB, 1),
        { timeoutMs: 5_000 },
      ).catch((error: NodeJS.ErrnoException) => ({ error }));
      if ("status" in cut) expect(cut.status).toBe(500);
      else expect(cut.error.code).toMatch(/^(ECONNRESET|EPIPE)$/);
      await waitFor(() => bounded.sockets.every((socket) => socket.destroyed));
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(serverBytesRead(bounded)).toBeLessThanOrEqual(MiB + 512 * 1024);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the drain's default idle and total bounds above Caddy's 30 s body timeout", () => {
    expect(DRAIN_IDLE_MS).toBe(31_000);
    expect(DRAIN_TOTAL_MS).toBeGreaterThanOrEqual(35_000);
    expect(DRAIN_TOTAL_MS).toBeGreaterThanOrEqual(DRAIN_IDLE_MS);
    expect(DRAIN_MAX_BYTES).toBe(PROXY_BODY_MAX_BYTES + 4 * MiB);
  });

  it("aborts the request signal when the client goes away", async () => {
    const seen = new Promise<void>((resolve) => {
      signalSeen = resolve;
    });
    const socket = net.connect(server.port, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    socket.write("GET /api/t/signal HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(signalAborted).toBe(false);
    socket.destroy();
    await seen;
    expect(signalAborted).toBe(true);
  });
});
