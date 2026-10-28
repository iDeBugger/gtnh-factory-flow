import { databaseDownResponse, serverErrorResponse } from "@/lib/server/http/error-response";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { BOARD_IMAGE_MAX_BYTES, UPLOAD_FORM_OVERHEAD_BYTES } from "@/lib/community/types";
import { getPlanPreviewPng } from "@/lib/server/services/plan-preview";
import { readFormDataCapped } from "@/lib/server/http/request-body";
import { isFileStoreConfigured } from "@/lib/server/file-store";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import {
  previewAccess,
  previewUploadAccess,
  storePlanPreview,
} from "@/lib/server/services/community-plans";
import { readViewer } from "@/lib/server/http/viewer";
import { serviceResponse } from "@/lib/server/http/service-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The post's board photograph, shown on its library page. Stored in the file
 * store's PRIVATE `plan-previews` bucket AT the plan's id (no schema column,
 * no URL to validate: the object name comes from the id, and re-sharing
 * overwrites in place) and served only through the GET below, which checks
 * the post: no other route serves that bucket.
 *
 * Owner-only, unlike board-image uploads: this picture is the post's public
 * face, so only the person who owns the post gets to stamp it. The header is
 * checked so the bucket holds only real PNGs: an IHDR with both sides within
 * `PLAN_PREVIEW_MAX_SIDE`. A re-share overwrites one object, so the cost of
 * a flood is storage churn; an account gets a few dozen an hour, counted
 * after the checks so junk spends no share.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ planId: string }> },
) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured() || !isFileStoreConfigured()) {
    return Response.json({ error: "Community hub is not configured." }, { status: 503 });
  }

  try {
    const { planId } = await params;
    const access = await previewUploadAccess(await readViewer(request), planId);
    if (!access.ok) {
      return serviceResponse(access, () => undefined);
    }

    const form = await readFormDataCapped(
      request,
      BOARD_IMAGE_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES,
    );
    if (!form) {
      return Response.json(
        { error: "That preview is too big: the limit is 4 MB." },
        { status: 413 },
      );
    }
    const file = form.get("image");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "No image in the upload." }, { status: 400 });
    }
    if (file.size > BOARD_IMAGE_MAX_BYTES) {
      return Response.json(
        { error: "That preview is too big: the limit is 4 MB." },
        { status: 413 },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await storePlanPreview(access.value.userId, access.value.planId, bytes);
    return serviceResponse(stored, (value) => value);
  } catch (error) {
    return serverErrorResponse(error, "Preview upload failed.");
  }
}

/**
 * The photograph itself, for the library's preview page. A public post's is
 * public, so anyone may look; an
 * unpublished post's is its owner's (and the admin's) alone, and the answer
 * for one reads the same as for a post with no picture, so a stranger learns
 * nothing the detail route would not tell them.
 */
export async function GET(request: Request, context: { params: Promise<{ planId: string }> }) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  const none = Response.json({ error: "No preview." }, { status: 404 });
  if (!isDatabaseConfigured()) {
    return none;
  }
  const { planId } = await context.params;
  // A failed account lookup answers as every other failure here does: a
  // picture's request has no use for an error body, and none reveals nothing.
  // A database that is down says so, as on every route.
  let viewer;
  try {
    viewer = await readViewer(request);
  } catch (error) {
    return databaseDownResponse(error, { headers: { "Cache-Control": "no-store" } }) ?? none;
  }
  const access = await previewAccess(viewer, planId);
  if (!access.ok) {
    return access.error.kind === "unavailable" ? serviceResponse(access, () => undefined) : none;
  }
  const unpublished = access.value.unpublished;
  const png = await getPlanPreviewPng(planId);
  if (!png) {
    return none;
  }
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      // Re-sharing overwrites in place, so a short cache keeps a public
      // picture honest. A private one depends on the cookie and must never
      // sit in a shared cache.
      "Cache-Control": unpublished ? "private, no-store" : "public, max-age=300",
    },
  });
}
