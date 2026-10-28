import { BLUEPRINT_BODY_MAX_BYTES } from "@/lib/blueprints/types";
import { readJsonCapped } from "@/lib/server/http/request-body";
import { answeringErrors } from "@/lib/server/http/error-response";
import { serviceResponse } from "@/lib/server/http/service-response";
import { isSignedIn, readViewer } from "@/lib/server/http/viewer";
import {
  blueprintSaveAllowed,
  listBlueprints,
  saveBlueprint,
  type BlueprintBody,
} from "@/lib/server/services/blueprints";
import { isDatabaseConfigured } from "@/lib/server/services/config";

/**
 * The account's own blueprints (`listBlueprints`). There is no public shelf:
 * a request for one is answered as a route that does not exist, never with
 * the caller's own list.
 */
export const GET = answeringErrors("Blueprints could not be loaded.", async (request: Request) => {
  if (new URL(request.url).searchParams.get("scope") === "public") {
    return Response.json({ error: "There is no public blueprint list." }, { status: 404 });
  }
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const viewer = await readViewer(request);
  return serviceResponse(await listBlueprints(viewer), (value) => value);
});

/** Saves a new blueprint to the signed-in account (`saveBlueprint`). */
export const POST = answeringErrors("Blueprint could not be saved.", async (request: Request) => {
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const viewer = await readViewer(request);
  if (!isSignedIn(viewer)) {
    return Response.json({ error: "Sign in to save blueprints." }, { status: 401 });
  }
  const allowed = await blueprintSaveAllowed(viewer);
  if (!allowed.ok) {
    return serviceResponse(allowed, () => ({}));
  }

  const read = await readJsonCapped(request, BLUEPRINT_BODY_MAX_BYTES);
  if (!read.ok) {
    return read.status === 413
      ? Response.json({ error: "Blueprint is too large to save." }, { status: 413 })
      : Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const body = (read.value ?? {}) as BlueprintBody;
  return serviceResponse(await saveBlueprint(viewer, body), (value) => value);
});
