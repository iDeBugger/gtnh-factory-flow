import { COMMUNITY_UPLOAD_BODY_MAX_BYTES, COMMUNITY_UPLOAD_MAX_BYTES } from "@/lib/community/types";
import type { DesignUpsertBody } from "@/lib/library/sync-types";
import { requestedOwner } from "@/lib/server/cloud-plans";
import { readTextCapped } from "@/lib/server/http/request-body";
import { answeringErrors } from "@/lib/server/http/error-response";
import { serviceResponse } from "@/lib/server/http/service-response";
import { isSignedIn, readViewer } from "@/lib/server/http/viewer";
import { isLibraryId } from "@/lib/server/library";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { deleteDesign, readDesign, saveDesign } from "@/lib/server/services/library";

type RouteContext = { params: Promise<{ designId: string }> };

/**
 * The plan itself, fetched when a pull finds it missing or moved. `?owner=`
 * reads a plan shared with the caller; absent, the caller's own.
 */
export const GET = answeringErrors(
  "The design could not be loaded.",
  async (request: Request, context: RouteContext) => {
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Cloud storage is not configured." }, { status: 503 });
    }
    const viewer = await readViewer(request);
    if (!isSignedIn(viewer)) {
      return Response.json({ error: "Sign in to sync your library." }, { status: 401 });
    }

    const { designId } = await context.params;
    const ownerId = requestedOwner(request, viewer.userId);
    if (!ownerId) {
      return Response.json({ error: "Bad owner id." }, { status: 400 });
    }
    return serviceResponse(await readDesign(viewer, ownerId, designId), (design) => design);
  },
);

/** Upsert (`saveDesign`): a member (`?owner=`) saves the plan and its name, the owner everything. */
export const PUT = answeringErrors(
  "The design could not be saved.",
  async (request: Request, context: RouteContext) => {
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Cloud storage is not configured." }, { status: 503 });
    }
    const viewer = await readViewer(request);
    if (!isSignedIn(viewer)) {
      return Response.json({ error: "Sign in to sync your library." }, { status: 401 });
    }
    // Everything that can refuse the request without the database goes before
    // the rate limit, which costs two round trips (a count and an insert).
    const { designId } = await context.params;
    if (!isLibraryId(designId)) {
      return Response.json({ error: "Bad design id." }, { status: 400 });
    }
    const ownerId = requestedOwner(request, viewer.userId);
    if (!ownerId) {
      return Response.json({ error: "Bad owner id." }, { status: 400 });
    }

    // Bytes first (nothing past the cap is buffered), then the player's limit
    // in characters, which is what the client counts.
    const raw = await readTextCapped(request, COMMUNITY_UPLOAD_BODY_MAX_BYTES);
    if (raw === undefined || raw.length > COMMUNITY_UPLOAD_MAX_BYTES) {
      return Response.json({ error: "This design is too large to sync." }, { status: 413 });
    }
    let body: Partial<DesignUpsertBody>;
    try {
      body = JSON.parse(raw) as Partial<DesignUpsertBody>;
    } catch {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
    return serviceResponse(await saveDesign(viewer, ownerId, designId, body), (saved) => saved);
  },
);

/** A tombstone (`deleteDesign`), the owner's alone. A member leaves through the members route. */
export const DELETE = answeringErrors(
  "The design could not be deleted.",
  async (request: Request, context: RouteContext) => {
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Cloud storage is not configured." }, { status: 503 });
    }
    const viewer = await readViewer(request);
    if (!isSignedIn(viewer)) {
      return Response.json({ error: "Sign in to sync your library." }, { status: 401 });
    }

    const { designId } = await context.params;
    const ownerId = requestedOwner(request, viewer.userId);
    if (!ownerId) {
      return Response.json({ error: "Bad owner id." }, { status: 400 });
    }
    return serviceResponse(await deleteDesign(viewer, ownerId, designId), (deleted) => deleted);
  },
);
