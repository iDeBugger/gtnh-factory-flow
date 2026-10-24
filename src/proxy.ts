import { NextResponse, type NextRequest } from "next/server";

/**
 * Cross-site writes to the API are refused before any route runs. Sessions
 * are a SameSite=Lax cookie, which browsers already keep off cross-site
 * POSTs; this is the second line, for a browser that does not, and for a
 * same-site subdomain. A write (anything but GET, HEAD, OPTIONS) that carries
 * an Origin whose host is not the request's Host, an Origin that does not
 * parse, or `Sec-Fetch-Site: cross-site` answers 403. No Origin at all passes:
 * the game, curl and the live test client send none, and a cookie-less
 * request has nothing to forge. Same host passes, which covers a checkout
 * (http://localhost:<port>) and production (Caddy forwards the site's Host).
 * The live socket keeps its own origin allow-list in the live service.
 */
export function proxy(request: NextRequest): NextResponse {
  if (!isCrossSiteWrite(request)) {
    return NextResponse.next();
  }
  return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isCrossSiteWrite(request: {
  method: string;
  headers: { get(name: string): string | null };
}): boolean {
  if (READ_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    return true;
  }
  const origin = request.headers.get("origin");
  if (origin === null) {
    return false;
  }
  const host = request.headers.get("host")?.toLowerCase();
  try {
    return !host || new URL(origin).host.toLowerCase() !== host;
  } catch {
    return true;
  }
}

export const config = {
  matcher: ["/api/:path*"],
};
