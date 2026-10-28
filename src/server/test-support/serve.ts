import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Express } from "express";
import { rawRequest } from "../../../tools/http-parity/raw-http.mjs";
import type { RawAnswer } from "../../../tools/http-parity/requests.mjs";

export interface Listening {
  port: number;
  server: http.Server;
  /** Every socket the server accepted, in order. */
  sockets: Socket[];
  close(): Promise<void>;
}

/** The app on an ephemeral loopback port. */
export async function listen(app: Express): Promise<Listening> {
  const server = http.createServer(app);
  const sockets: Socket[] = [];
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    server,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface CallOptions {
  /** A reset before the whole answer was read fails the call. */
  strict?: boolean;
  /** Sends the body in 64 KiB chunks with this pause between them (the declared length is kept). */
  chunkDelayMs?: number;
  timeoutMs?: number;
}

/**
 * One raw exchange: the target goes out byte for byte, never through `fetch`. `Host` names the server unless the
 * call sets its own, and `Connection: keep-alive` is asked for, so a close in the answer is the server's choice.
 * Rejects with the socket error when no answer head arrived.
 */
export function call(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body?: string | Buffer,
  options: CallOptions = {},
): Promise<RawAnswer> {
  const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  const pairs: [string, string][] = [];
  if (!names.has("host")) pairs.push(["host", `127.0.0.1:${port}`]);
  if (!names.has("connection")) pairs.push(["connection", "keep-alive"]);
  pairs.push(...Object.entries(headers));
  const chunks =
    body !== undefined && options.chunkDelayMs !== undefined
      ? Array.from({ length: Math.ceil(Buffer.byteLength(body) / 65_536) }, (_, index) =>
          Buffer.from(body).subarray(index * 65_536, (index + 1) * 65_536),
        )
      : undefined;
  return rawRequest({
    base: `http://127.0.0.1:${port}`,
    method,
    target,
    headers: pairs,
    ...(chunks ? { chunks, chunkDelayMs: options.chunkDelayMs } : { body }),
    strict: options.strict,
    timeoutMs: options.timeoutMs,
  });
}
