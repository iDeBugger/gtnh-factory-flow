import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Plain Node HTTP to and from the Fetch API's Request and Response, for the
 * small servers beside Next.js (the live service, the local database host).
 */

/** The request as a Fetch API Request; the body is read whole, refused past `maxBytes`. */
export async function toWebRequest(
  req: IncomingMessage,
  maxBytes = 8 * 1024 * 1024,
): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const method = (req.method ?? "GET").toUpperCase();
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > maxBytes) {
        throw new BodyTooLargeError();
      }
      chunks.push(buffer);
    }
    const whole = Buffer.concat(chunks);
    body = whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength) as ArrayBuffer;
  }
  return new Request(url, { method, headers, body });
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}

/** Writes a Fetch API Response to a Node response. */
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body) {
    res.end(Buffer.from(await response.arrayBuffer()));
  } else {
    res.end();
  }
}
