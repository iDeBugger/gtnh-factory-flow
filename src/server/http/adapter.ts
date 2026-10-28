/**
 * Express on one side, a route handler's web `Request` and `Response` on the other. The handlers keep the
 * signature they have under Next; this file is the only place that knows both worlds.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
} from "express";
import { BODY_HARD_CAP_BYTES } from "@/lib/server/http/request-body";
import { siteUrl } from "@/lib/site-url";
import { canonicalUrlOf } from "../middleware/normalize-path";
import type { WebHandler } from "./route-table";

/**
 * How far the server reads an unread request body after it has answered, before it closes the connection.
 *
 * An answer sent before the body has arrived (a route's 413 for a declared length over its cap) must still reach
 * the client: closing a socket with request bytes still coming in sends a TCP reset, and the client's kernel may
 * throw away the answer it has not read yet. Behind Caddy that turns the route's 413 into a 502. So the server
 * reads and discards the rest, then closes.
 *
 * Both timers stay above Caddy's 30 s body read timeout, so in production Caddy's own limits always fire first:
 * a slow but steady upload reaches its end and its 413, and one that stalls is cut by Caddy, not turned into a
 * reset by the app. The total stays at or above the idle timer. The byte bound sits 4 MiB past the hard cap;
 * Caddy's 8 MB request body limit refuses anything larger at the edge.
 */
export const DRAIN_MAX_BYTES = BODY_HARD_CAP_BYTES + 4 * 1024 * 1024;
/** Reset by every chunk that arrives: a sender that stops for this long is cut. */
export const DRAIN_IDLE_MS = 31_000;
/** The longest a drain runs, however steadily the bytes trickle in. */
export const DRAIN_TOTAL_MS = 35_000;

export interface DrainBounds {
  maxBytes: number;
  idleMs: number;
  totalMs: number;
}

export const DEFAULT_DRAIN: DrainBounds = {
  maxBytes: DRAIN_MAX_BYTES,
  idleMs: DRAIN_IDLE_MS,
  totalMs: DRAIN_TOTAL_MS,
};

/** The request body passed the hard cap: the handler's body stream errors with this. */
export class BodyTooLargeError extends Error {
  constructor(capBytes: number) {
    super(`The request body is over ${capBytes} bytes.`);
    this.name = "BodyTooLargeError";
  }
}

/** A handler threw, returned something that is not a Response, or its answer failed while being sent. */
export class RouteHandlerError extends Error {
  constructor(cause: unknown) {
    super("A route handler failed.", { cause });
    this.name = "RouteHandlerError";
  }
}

/** Body bytes read off one request, and whether the drain owns the body now. */
interface BodyState {
  bytes: number;
  draining: boolean;
  /** Detaches the handler's body stream, which errors, so the drain alone reads what is left. */
  abandon?: () => void;
}

const bodyStates = new WeakMap<IncomingMessage, BodyState>();

function bodyState(req: IncomingMessage): BodyState {
  let state = bodyStates.get(req);
  if (!state) {
    state = { bytes: 0, draining: false };
    bodyStates.set(req, state);
  }
  return state;
}

/**
 * The request body as a web stream that reads the socket only when the handler reads it (high water mark 0), so a
 * handler that never reads leaves the bytes unread, and pauses the socket when the handler falls behind. Past
 * `capBytes` it errors with `BodyTooLargeError`.
 */
function bodyStream(req: IncomingMessage, capBytes: number): ReadableStream<Uint8Array> {
  const state = bodyState(req);
  let attached = false;
  let settled = false;
  let detach = (): void => {};
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!attached) {
          attached = true;
          const settle = (end: () => void): void => {
            if (settled) return;
            settled = true;
            detach();
            end();
          };
          const onData = (chunk: Buffer): void => {
            if (settled) return;
            if (!state.draining) state.bytes += chunk.byteLength;
            if (state.bytes > capBytes) {
              req.pause();
              settle(() => controller.error(new BodyTooLargeError(capBytes)));
              return;
            }
            controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            if (!state.draining && (controller.desiredSize ?? 0) <= 0) req.pause();
          };
          const onEnd = (): void => settle(() => controller.close());
          const onError = (error: Error): void => settle(() => controller.error(error));
          const onClose = (): void => {
            if (!req.complete)
              onError(new Error("The client went away before the request body ended."));
          };
          state.abandon = () =>
            settle(() =>
              controller.error(new Error("The answer was sent before the request body was read.")),
            );
          detach = () => {
            req.off("data", onData);
            req.off("end", onEnd);
            req.off("error", onError);
            req.off("close", onClose);
          };
          // Paused first, so adding the data listener does not start the flow before the handler asks.
          req.pause();
          req.on("data", onData);
          req.on("end", onEnd);
          req.on("error", onError);
          req.on("close", onClose);
        }
        if (!settled) req.resume();
      },
      cancel() {
        settled = true;
        detach();
        if (!state.draining) req.pause();
      },
    },
    { highWaterMark: 0 },
  );
}

export interface WebRequestOptions {
  /** The body stream errors past this many bytes. */
  hardCapBytes: number;
  /** The origin of the handler's `request.url`: the site's own, never one a request header names. */
  origin: string;
}

/**
 * The web Request a handler gets: the canonical URL (after the redirects, `canonicalPath` and any gate rewrite)
 * on the site's own origin, the headers as Node keeps them, the body as a capped stream, and a signal that aborts
 * when the client goes away.
 *
 * The headers come from Node's `req.headers`, as Next built them: a repeated single-valued header (`Host`,
 * `Content-Type`, `Authorization` and the rest of Node's list) keeps its first value, cookies are joined with `; `
 * and any other repeat with `, `.
 */
export function toWebRequest(req: ExpressRequest, options: WebRequestOptions): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one !== undefined) headers.append(name, one);
    }
  }
  const controller = new AbortController();
  req.res?.once("close", () => {
    if (!req.res?.writableFinished) controller.abort();
  });
  const method = req.method.toUpperCase();
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal: controller.signal };
  if (method !== "GET" && method !== "HEAD") {
    init.body = bodyStream(req, options.hardCapBytes);
    init.duplex = "half";
  }
  return new Request(options.origin + canonicalUrlOf(req), init);
}

/**
 * Reads and discards the rest of a request body nobody read, within `bounds`, then closes the connection: after
 * a handler's answer, after the error answer of a handler that failed mid-body (not-found.ts), and under any
 * answer sent after the stop began (shutdown.ts). The answer says `Connection: close`. Once begun, the drain owns
 * the body: the handler's stream errors.
 *
 * Node closes a `Connection: close` socket as soon as the answer is flushed (`destroySoon`), which with request
 * bytes still arriving is the reset described at `DRAIN_MAX_BYTES`. Until the drain ends, that close is held back
 * on this one socket: on the body's end the socket closes as Node would have closed it, and on a bound it is
 * destroyed.
 */
/**
 * Whether the request has body bytes nobody has read yet. A request without a body is not complete until Node's
 * parser has finished its message, which comes after a middleware that answers at once has run.
 */
export function hasUnreadBody(req: IncomingMessage): boolean {
  if (req.complete) return false;
  return (
    req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0
  );
}

export function drainUnreadBody(
  req: IncomingMessage,
  res: ServerResponse,
  bounds: DrainBounds,
): void {
  const state = bodyState(req);
  if (state.draining) return;
  res.shouldKeepAlive = false;
  const socket = req.socket;
  state.draining = true;
  // The handler's stream would pause the request at its cap and stall the drain.
  state.abandon?.();
  let answered = false;
  let done = false;
  const held = (): void => {
    answered = true;
  };
  socket.destroySoon = held;

  const finish = (cut: boolean): void => {
    if (done) return;
    done = true;
    clearTimeout(idle);
    clearTimeout(total);
    req.off("data", onData);
    req.off("end", onEnd);
    req.off("error", onError);
    socket.off("close", onClose);
    if (socket.destroySoon === held) Reflect.deleteProperty(socket, "destroySoon");
    if (cut) socket.destroy();
    else if (answered) socket.destroySoon();
  };
  const onData = (chunk: Buffer): void => {
    state.bytes += chunk.byteLength;
    if (state.bytes > bounds.maxBytes) finish(true);
    else idle.refresh();
  };
  const onEnd = (): void => finish(false);
  const onError = (): void => finish(true);
  const onClose = (): void => finish(false);
  const idle = setTimeout(() => finish(true), bounds.idleMs);
  const total = setTimeout(() => finish(true), bounds.totalMs);
  req.on("data", onData);
  req.once("end", onEnd);
  req.once("error", onError);
  socket.once("close", onClose);
  req.resume();
}

function clientWentAway(res: ExpressResponse): boolean {
  return res.destroyed && !res.writableFinished;
}

/**
 * The headers a route's answer adds to what is already on the answer. Any other header the answer already carries
 * (the security headers) wins over the route's own of the same name, as in Next's `sendResponse`.
 */
const REPEATABLE_HEADERS = new Set([
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
  "vary",
]);

/**
 * Writes a handler's Response: its status, its headers (each Set-Cookie on its own line; see
 * `REPEATABLE_HEADERS` for a name already set), and its body piped with backpressure, none on HEAD. The
 * handler's Response is only read, never changed: some carry immutable headers (`Response.redirect`).
 */
export async function sendWebResponse(
  req: ExpressRequest,
  res: ExpressResponse,
  response: Response,
  drain: DrainBounds = DEFAULT_DRAIN,
  defaultCacheControl?: string,
): Promise<void> {
  res.statusCode = response.status;
  if (defaultCacheControl && !response.headers.has("cache-control")) {
    res.setHeader("cache-control", defaultCacheControl);
  }
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    if (REPEATABLE_HEADERS.has(name)) res.appendHeader(name, value);
    else if (res.getHeader(name) === undefined) res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (!req.complete) drainUnreadBody(req, res, drain);

  if (req.method === "HEAD" || response.body === null) {
    await response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      res,
    );
  } catch (error) {
    if (clientWentAway(res)) return;
    throw error;
  }
}

export interface HandleOptions {
  drain?: DrainBounds;
  hardCapBytes?: number;
  /** Written when the handler's answer names no Cache-Control (Next's force-static rule, app.ts). */
  defaultCacheControl?: string;
}

/** An Express handler for one route handler: params by folder name, `:id` as a string and `*rest` as an array. */
export function handle(handler: WebHandler, options: HandleOptions = {}): RequestHandler {
  const hardCapBytes = options.hardCapBytes ?? BODY_HARD_CAP_BYTES;
  return async (req, res, next) => {
    let response: Response;
    try {
      const request = toWebRequest(req, { hardCapBytes, origin: siteUrl() });
      response = await handler(request, { params: Promise.resolve({ ...req.params }) });
      if (!(response instanceof Response)) {
        throw new TypeError("The route handler returned something that is not a Response.");
      }
    } catch (error) {
      next(new RouteHandlerError(error));
      return;
    }
    try {
      await sendWebResponse(req, res, response, options.drain, options.defaultCacheControl);
    } catch (error) {
      next(new RouteHandlerError(error));
    }
  };
}
