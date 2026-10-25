/**
 * What Next keeps of a write body while `src/proxy.ts` runs
 * (`experimental.proxyClientMaxBodySize` in next.config.ts). Because a proxy
 * runs on every path, Next copies each write body up to this size and waits
 * for its end before any route reads it, and drops the bytes past it. It sits
 * just above the largest route cap (an image or preview upload, 4 MiB plus
 * the form's 64 KiB), never below one: a body cut at this size is still over
 * every cap and still answers 413, not a 400 for a truncated JSON or form.
 * The wait for the body's end cannot be cut short in the app: Next awaits it
 * even when the proxy answers itself. Only the edge's read timeout bounds a
 * slow sender (Node's own `requestTimeout` is 300 s).
 *
 * Beside next.config.ts, which imports nothing from `src/` (the site image
 * ships no `src/`); `src/lib/server/request-body.ts` re-exports it.
 */
export const PROXY_BODY_MAX_BYTES = 4.5 * 1024 * 1024;
