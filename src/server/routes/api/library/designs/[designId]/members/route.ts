import { requestedOwner } from "@/lib/server/cloud-plans";
import { answeringErrors } from "@/lib/server/http/error-response";
import { serviceResponse } from "@/lib/server/http/service-response";
import { isSignedIn, readViewer } from "@/lib/server/http/viewer";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { listDesignMembers } from "@/lib/server/services/library";

type RouteContext = { params: Promise<{ designId: string }> };

/** Who a plan is shared with: for its owner and its members. `?owner=` names a plan shared with the caller. */
export const GET = answeringErrors(
  "The plan's members could not be loaded.",
  async (request: Request, context: RouteContext) => {
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Cloud storage is not configured." }, { status: 503 });
    }
    const viewer = await readViewer(request);
    if (!isSignedIn(viewer)) {
      return Response.json({ error: "Sign in to share plans." }, { status: 401 });
    }
    const { designId } = await context.params;
    const ownerId = requestedOwner(request, viewer.userId);
    if (!ownerId) {
      return Response.json({ error: "Bad owner id." }, { status: 400 });
    }
    return serviceResponse(
      await listDesignMembers(viewer, ownerId, designId),
      (members) => members,
    );
  },
);
