/**
 * The response headers every answer carries, built for next.config.ts.
 *
 * Beside next.config.ts and dependency-free: `next start` loads the config
 * again at run time, and the site image ships the config's own files but no
 * `src/`. Next's require hook transpiles a relative `.ts` import and knows no
 * `@/` alias.
 *
 * The document policy keeps `'unsafe-inline'` for scripts because the App
 * Router streams its payload as inline `<script>` tags whose content differs
 * per request, so no hash list covers them and a nonce would need a proxy
 * that forces dynamic rendering. What it still buys: no script, object,
 * worker or socket from another origin, no `<base>` hijack, no form posting
 * elsewhere, no framing, and fetch, XHR and WebSocket confined to the origin.
 * `img-src` allows `https:` (an annotation's picture is any https address,
 * uploads come back as the storage host's URL), `data:` (the board's SVG
 * patterns, the screenshot's SVG image) and `blob:` (the screenshot preview
 * and downloads). `base-uri 'self'`, not `'none'`: the screenshot capture
 * resolves stylesheet URLs through a `<base>` of its own. `worker-src` allows
 * `blob:` so a worker made from a blob in the page can run. `'self'` in
 * `connect-src` covers the live socket on the page's own host (ws and wss,
 * per CSP3); an absolute live URL adds its origin.
 */
export interface SecurityHeaderEnv {
  /** Outside production, Turbopack and React Refresh need `eval`: dev must never be what breaks. */
  production: boolean;
  /** NEXT_PUBLIC_LIVE_URL: a path adds nothing; an absolute ws(s) URL adds its origin to connect-src. */
  liveUrl?: string;
}

export function documentPolicy(env: SecurityHeaderEnv): string {
  const scriptSources = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"];
  if (!env.production) {
    scriptSources.push("'unsafe-eval'");
  }
  const connectSources = ["'self'"];
  const liveOrigin = originOf(env.liveUrl, ["ws:", "wss:"]);
  if (liveOrigin) {
    connectSources.push(liveOrigin);
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
 * response, not the page's. Its script lives under /_next/static, so that
 * path gets a policy of its own with `'unsafe-eval'`. A CSP header on a
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

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/**
 * In order: the site-wide rule, then the worker policy on the static chunks.
 * Next applies every matching rule and a later rule overrides the same key,
 * which is what gives the worker script its own policy.
 */
export function securityHeaders(env: SecurityHeaderEnv): HeaderRule[] {
  return [
    {
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: documentPolicy(env) },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY },
      ],
    },
    {
      source: "/_next/static/:path*",
      headers: [{ key: "Content-Security-Policy", value: workerPolicy }],
    },
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
