import { APP_VERSION } from "@/lib/version";

/**
 * What the SERVER is running, so a tab left open across a deploy can notice it
 * runs an old bundle (see `useDeployedVersion`, which reads `version` only),
 * and so a deploy can tell its own build is the one answering: `build` is the
 * build's identity (`<version>-<sha8>`, `NEXT_PUBLIC_GTNH_BUILD_ID`, inlined at
 * build by next.config.ts), which changes with every commit even when
 * APP_VERSION does not. Deliberately uncached: a cached answer is exactly the
 * stale reading it exists to detect.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  return Response.json(
    { version: APP_VERSION, build: process.env.NEXT_PUBLIC_GTNH_BUILD_ID ?? "" },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
