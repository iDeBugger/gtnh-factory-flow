import { MOD_PORTS } from "@/lib/mod-link/mod-link";

/**
 * The response headers every answer carries (src/server/middleware/security-headers.ts sets them).
 *
 * In production the document policy names the page's inline scripts by their hashes, fixed at build
 * (`scriptHashes`), instead of `'unsafe-inline'`; the dev server's own inline scripts are not hashed, so dev
 * keeps it. What the policy buys besides: no script, object, worker or socket from another origin, no `<base>`
 * hijack, no form posting elsewhere, no framing, and fetch, XHR and WebSocket confined to the origin. `img-src`
 * allows `https:` (an annotation's picture is any https address, uploads come back as the storage host's URL),
 * `data:` (the board's SVG patterns, the screenshot's SVG image) and `blob:` (the screenshot preview and
 * downloads). `base-uri 'self'`, not `'none'`: the screenshot capture resolves stylesheet URLs through a
 * `<base>` of its own. `worker-src` allows `blob:` so a worker made from a blob in the page can run. `'self'` in
 * `connect-src` covers the live socket on the page's own host (ws and wss, per CSP3); an absolute live URL adds
 * its origin, and the site's own URL adds its socket origin (`wss://` for https), since WebKit before CSP3 did
 * not let `'self'` match a socket. A build with the mod and community switch on adds the ten loopback origins
 * the mod listens on (`MOD_LOOPBACK_ORIGINS`): "Open in the mod" probes and posts to them. CSP has no port
 * ranges.
 */
export interface SecurityHeaderEnv {
  /** Outside production, Vite's dev client and React Refresh need `eval`: dev must never be what breaks. */
  production: boolean;
  /** NEXT_PUBLIC_LIVE_URL: a path adds nothing; an absolute ws(s) URL adds its origin to connect-src. */
  liveUrl?: string;
  /** NEXT_PUBLIC_SITE_URL: an absolute http(s) URL adds its host as ws(s) to connect-src. */
  siteUrl?: string;
  /** NEXT_PUBLIC_MOD_AND_COMMUNITY at build: exactly "on" (any case, trimmed) adds the mod's loopback origins. */
  modAndCommunity?: string;
  /**
   * The quoted `'sha256-...'` sources of every inline script the page carries, fixed at build. In production
   * `script-src` names them instead of `'unsafe-inline'`. Absent or empty, the policy keeps `'unsafe-inline'`,
   * unless `requireScriptHashes` says the page has them.
   */
  scriptHashes?: string[];
  /**
   * The page's inline scripts are hashed at build (the Express server with its prerendered page). In production
   * an absent or empty `scriptHashes` then throws instead of falling back to `'unsafe-inline'`: a build that lost
   * its hash list must stop the server, not quietly serve the weaker policy, which no browser check would notice.
   */
  requireScriptHashes?: boolean;
}

/** The origins of the mod's `WebsiteListener`: 127.0.0.1 on the ports the mod link tries (`MOD_PORTS`). */
export const MOD_LOOPBACK_ORIGINS = MOD_PORTS.map((port) => `http://127.0.0.1:${port}`);

export function documentPolicy(env: SecurityHeaderEnv): string {
  // Outside production the dev server injects inline scripts of its own (React Refresh), which no build-time
  // hash list names, so only production trades 'unsafe-inline' for the hashes.
  const hashes = env.production ? (env.scriptHashes ?? []) : [];
  if (env.production && env.requireScriptHashes && hashes.length === 0) {
    throw new Error(
      "The page's script hashes are missing: the policy would fall back to 'unsafe-inline'.",
    );
  }
  const scriptSources =
    hashes.length > 0
      ? ["'self'", ...hashes, "'wasm-unsafe-eval'"]
      : ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"];
  if (!env.production) {
    scriptSources.push("'unsafe-eval'");
  }
  const connectSources = ["'self'"];
  const liveOrigin = originOf(env.liveUrl, ["ws:", "wss:"]);
  const siteSocket = originOf(env.siteUrl, ["http:", "https:"])?.replace(/^http/, "ws");
  const modOrigins = env.modAndCommunity?.trim().toLowerCase() === "on" ? MOD_LOOPBACK_ORIGINS : [];
  for (const origin of [siteSocket, liveOrigin, ...modOrigins]) {
    if (origin && !connectSources.includes(origin)) {
      connectSources.push(origin);
    }
  }
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self' blob:",
    "media-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * The solver worker evaluates the HiGHS glue with `new Function` and compiles
 * its wasm, and a dedicated worker takes its policy from its own script's
 * response, not the page's. Its script lives under /assets, so that path
 * gets a policy of its own with `'unsafe-eval'`. A CSP header on a
 * chunk the page loads as a classic `<script>` has no effect, so this costs
 * the main thread nothing.
 */
export const workerPolicy =
  "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'";

/**
 * Browsers that have seen the site over TLS keep asking for it that way for
 * six months, so a pasted http:// link or a captive portal never carries the
 * session cookie in the clear. No includeSubDomains: a staging subdomain may
 * not be TLS.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=15552000";

/** The paths whose answers carry `workerPolicy`: the client build's assets. */
const WORKER_POLICY_PREFIXES = ["/assets"];

/**
 * The security headers one answer carries, names in lower case: the document policy, or the worker policy under
 * the asset folder, then the framing, sniffing, referrer and transport rules.
 */
export function headersForPath(pathname: string, env: SecurityHeaderEnv): [string, string][] {
  const worker = WORKER_POLICY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return [
    ["content-security-policy", worker ? workerPolicy : documentPolicy(env)],
    ["x-frame-options", "SAMEORIGIN"],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["strict-transport-security", STRICT_TRANSPORT_SECURITY],
  ];
}

/** The origin of an absolute URL with one of `schemes`, else undefined (a path, blank or junk adds nothing). */
function originOf(value: string | undefined, schemes: string[]): string | undefined {
  if (!value || value.startsWith("/")) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return schemes.includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
