import { answeringErrors } from "@/lib/server/http/error-response";
import { serviceResponse } from "@/lib/server/http/service-response";
import { isSignedIn, readViewer } from "@/lib/server/http/viewer";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { listLibrary } from "@/lib/server/services/library";

/**
 * The account's whole library, without plans: every design's metadata and
 * every folder, tombstones included, each design's members, and the plans
 * others shared with this account (`listLibrary`).
 */
export const GET = answeringErrors("Your plans could not be loaded.", async (request: Request) => {
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const viewer = await readViewer(request);
  if (!isSignedIn(viewer)) {
    return Response.json({ error: "Sign in to sync your library." }, { status: 401 });
  }
  return serviceResponse(await listLibrary(viewer), (library) => library);
});
