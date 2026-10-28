import { NextResponse, type NextRequest } from "next/server";
import { decideDatasetPath } from "@/lib/server/dataset-path-gate";
import { isCrossSiteWrite } from "@/lib/server/http/cross-site";

/**
 * The dataset path gate (dataset-path-gate.ts), then the cross-site write
 * check on the API (cross-site.ts), before any route runs.
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
  return NextResponse.next();
}

// Every path but the framework's own: the dataset gate must see any spelling
// of a dataset path, and an encoded letter in "datasets" would slip past a
// prefix matcher. The cross-site check applies to the API only (above).
export const config = {
  matcher: ["/((?!_next/).*)"],
};
