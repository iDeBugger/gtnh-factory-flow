import { NextResponse, type NextRequest } from "next/server";
import { decideDatasetPath } from "@/lib/server/dataset-path-gate";
import { PROXY_BODY_MAX_BYTES, REQUEST_TOO_BIG_MESSAGE } from "@/lib/server/request-body";
import {
  BLUEPRINT_TOO_BIG,
  DESIGN_TOO_BIG,
  FEEDBACK_TOO_BIG,
  IMAGE_TOO_BIG,
  PLAN_UPLOAD_TOO_BIG,
  PREVIEW_TOO_BIG,
} from "@/lib/server/too-big";

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
  // The dataset files first, on the raw path: see dataset-path-gate.ts for
  // why only a request-level look at the decoded path can gate them.
  const pathname = new URL(request.url).pathname;
  const dataset = decideDatasetPath(pathname);
  if (dataset.kind === "refuse") {
    return NextResponse.json(
      { error: "Invalid dataset path." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (dataset.kind === "rewrite") {
    return NextResponse.rewrite(new URL(dataset.pathname, request.url));
  }
  if (pathname.startsWith("/api/") && isCrossSiteWrite(request)) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  // Next waits for a write's whole body before any route runs (request-body.ts,
  // PROXY_BODY_MAX_BYTES), so a declared length no route accepts is refused
  // here, before a byte of it is waited for, in the route's own words.
  if (!READ_METHODS.has(request.method.toUpperCase()) && declaredLength(request) > PROXY_BODY_MAX_BYTES) {
    return NextResponse.json({ error: tooBigSentence(pathname) }, { status: 413 });
  }
  return NextResponse.next();
}

function declaredLength(request: { headers: { get(name: string): string | null } }): number {
  const length = Number(request.headers.get("content-length") ?? 0);
  return Number.isFinite(length) ? length : 0;
}

/**
 * The 413 sentence of the route at `pathname`, for a body over every cap:
 * the same words the route itself answers past its cap (too-big.ts).
 */
const TOO_BIG_SENTENCES: [RegExp, string][] = [
  [/^\/api\/feedback\/?$/, FEEDBACK_TOO_BIG],
  [/^\/api\/community\/images\/?$/, IMAGE_TOO_BIG],
  [/^\/api\/community\/plans\/[^/]+\/preview\/?$/, PREVIEW_TOO_BIG],
  [/^\/api\/community\/plans(\/[^/]+)?\/?$/, PLAN_UPLOAD_TOO_BIG],
  [/^\/api\/library\/designs\/[^/]+\/?$/, DESIGN_TOO_BIG],
  [/^\/api\/blueprints(\/[^/]+)?\/?$/, BLUEPRINT_TOO_BIG],
];

export function tooBigSentence(pathname: string): string {
  return TOO_BIG_SENTENCES.find(([path]) => path.test(pathname))?.[1] ?? REQUEST_TOO_BIG_MESSAGE;
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

// Every path but the framework's own: the dataset gate must see any spelling
// of a dataset path, and an encoded letter in "datasets" would slip past a
// prefix matcher. The cross-site check applies to the API only (above).
export const config = {
  matcher: ["/((?!_next/).*)"],
};
