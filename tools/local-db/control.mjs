/**
 * The local database's control listener (tools/local-db/serve.ts), on
 * 127.0.0.1 only: `GET /__local-db/ready` once the database is served, and
 * `POST /__local-db/shutdown`, which dev-local sends to stop it (on Windows a
 * child gets no signal).
 *
 * The shutdown needs the header below. A page open in the developer's
 * browser can send a plain POST to any local port without asking, but a
 * request with a custom header is preflighted first, and this listener
 * answers no preflight, so no page can stop the database.
 */

export const CONTROL_HEADER = "x-local-db";
export const CONTROL_HEADER_VALUE = "1";

/** The listener's request handler; `onShutdown` runs after the answer is sent. */
export function controlHandler({ onShutdown }) {
  return (req, res) => {
    if (req.method === "POST" && req.url === "/__local-db/shutdown") {
      if (req.headers[CONTROL_HEADER] !== CONTROL_HEADER_VALUE) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200).end();
      onShutdown();
      return;
    }
    if (req.method === "GET" && req.url === "/__local-db/ready") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ready");
      return;
    }
    res.writeHead(404).end();
  };
}
