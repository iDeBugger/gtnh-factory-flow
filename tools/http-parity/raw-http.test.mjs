import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawRequest } from "./raw-http.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("rawRequest over http", () => {
  const seen = [];
  const server = http.createServer({ requireHostHeader: false }, (req, res) => {
    seen.push({ url: req.url, headers: req.headers, socket: `${req.socket.remotePort}` });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url }));
  });
  let base;
  beforeAll(async () => {
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  afterAll(() => close(server));

  const echo = async (target, headers) => {
    const answer = await rawRequest({ base, target, headers, timeoutMs: 5000 });
    expect(answer.status).toBe(200);
    return { ...JSON.parse(answer.body.toString("utf8")), ...seen.at(-1) };
  };

  it("sends the request target byte for byte", async () => {
    for (const target of ["/a/./b", "//a", "/a\\b", "/a/%2e/b", "/a/%2E%2E/b", "/%2fdatasets/x"]) {
      expect((await echo(target)).url).toBe(target);
    }
  });

  it("sends no Host header unless the case names one, and opens a new socket per case", async () => {
    const first = await echo("/one");
    const second = await echo("/two");
    expect(first.headers.host).toBeUndefined();
    expect(first.socket).not.toBe(second.socket);
    expect((await echo("/three", { Host: "parity.example" })).headers.host).toBe("parity.example");
  });
});

describe("rawRequest over https", () => {
  let dir;
  let cert;
  let key;
  const servernames = [];
  let server;
  let port;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "raw-http-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=parity.test",
        "-addext",
        "subjectAltName=DNS:parity.test,IP:127.0.0.1",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    cert = readFileSync(path.join(dir, "cert.pem"));
    key = readFileSync(path.join(dir, "key.pem"));
    server = https.createServer({ cert, key, requireHostHeader: false }, (req, res) => {
      servernames.push(req.socket.servername);
      res.end(JSON.stringify({ host: req.headers.host ?? null }));
    });
    port = await listen(server);
  });
  afterAll(async () => {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  });

  it("speaks TLS with the given SNI and Host", async () => {
    const lookup = (hostname, options, callback) => {
      expect(hostname).toBe("parity.test");
      if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
      else callback(null, "127.0.0.1", 4);
    };
    const answer = await rawRequest({
      base: `https://parity.test:${port}`,
      target: "/",
      headers: { Host: "parity.test" },
      ca: cert,
      lookup,
      timeoutMs: 5000,
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body.toString("utf8")).host).toBe("parity.test");
    expect(servernames.at(-1)).toBe("parity.test");
  });

  it("sends no SNI for an IP host", async () => {
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      const answer = await rawRequest({
        base: `https://127.0.0.1:${port}`,
        target: "/",
        ca: cert,
        timeoutMs: 5000,
      });
      expect(answer.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }
    expect(servernames.at(-1)).toBe(false);
    expect(warnings.filter((warning) => warning.code === "DEP0123")).toEqual([]);
  });
});

describe("rawRequest against a server that stops reading", () => {
  // A plain socket server: as soon as the request head is in it answers 413, closes its side and stops reading,
  // while the client is still sending, and drops the socket a while later. Node's own HTTP server would read on
  // and discard the body, so whether the client saw the answer would be a race.
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let head = "";
    const onData = (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      socket.pause();
      socket.end(
        "HTTP/1.1 413 Payload Too Large\r\ncontent-type: text/plain\r\ncontent-length: 7\r\n\r\ntoo big",
      );
      setTimeout(() => socket.destroy(), 5000).unref();
    };
    socket.on("data", onData);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  let base;
  beforeAll(async () => {
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  afterAll(() => {
    for (const socket of sockets) socket.destroy();
    return close(server);
  });

  it("keeps the status when the server closes the socket during a large upload", async () => {
    const body = Buffer.alloc(16 * 1024 * 1024, 0x61);
    const answer = await rawRequest({
      base,
      method: "POST",
      target: "/upload",
      body,
      timeoutMs: 10_000,
    });
    expect(answer.status).toBe(413);
    expect(answer.body.toString("utf8")).toBe("too big");
    expect(answer.socketClosedEarly).toBe(true);
    expect(answer.bytesSent).toBeLessThan(body.length);
  });
});

describe("rawRequest against a server that resets mid-answer", () => {
  // The head and part of a declared body, then a reset: the answer is cut short.
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write(
        "HTTP/1.1 413 Payload Too Large\r\ncontent-type: text/plain\r\ncontent-length: 100\r\n\r\ntoo",
      );
      setTimeout(() => socket.resetAndDestroy(), 100);
    });
    socket.on("error", () => {});
  });
  let base;
  beforeAll(async () => {
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  afterAll(() => close(server));

  it("fails a strict exchange whose answer was cut short", async () => {
    await expect(
      rawRequest({ base, target: "/cut", strict: true, timeoutMs: 5000 }),
    ).rejects.toThrow(/cut short/);
  });

  it("keeps the status and what arrived when the exchange is not strict", async () => {
    const answer = await rawRequest({ base, target: "/cut", timeoutMs: 5000 });
    expect(answer.status).toBe(413);
    expect(answer.body.toString("utf8")).toBe("too");
  });
});
