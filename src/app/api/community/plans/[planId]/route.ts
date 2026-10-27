import { serverErrorResponse } from "@/lib/server/http/error-response";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { COMMUNITY_UPLOAD_BODY_MAX_BYTES, COMMUNITY_UPLOAD_MAX_BYTES } from "@/lib/community/types";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import {
  deletePlan,
  editPlan,
  readPlan,
  type PlanPostBody,
} from "@/lib/server/services/community-plans";
import { readViewer } from "@/lib/server/http/viewer";
import { serviceResponse } from "@/lib/server/http/service-response";
import { readTextCapped } from "@/lib/server/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unconfigured = () =>
  Response.json({ error: "Community hub is not configured." }, { status: 503 });

/**
 * Plan detail. A read that writes nothing: a view is counted by
 * `POST .../view`, which the client sends when a player opens a post. The
 * stat card is refreshed here when it is stale, which is a value no caller
 * can steer.
 */
export async function GET(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return unconfigured();
  }

  try {
    const { planId } = await params;
    const deviceId = new URL(request.url).searchParams.get("deviceId") ?? undefined;
    const viewer = await readViewer(request);
    const result = await readPlan(viewer, planId, deviceId, request);
    return serviceResponse(result, (value) => value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return serverErrorResponse(error, "Loading the plan failed.");
  }
}

/** Updates a post in place. Only the signed-in owner may do this. */
export async function PUT(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return unconfigured();
  }

  try {
    const { planId } = await params;
    const raw = await readTextCapped(request, COMMUNITY_UPLOAD_BODY_MAX_BYTES);
    if (raw === undefined || raw.length > COMMUNITY_UPLOAD_MAX_BYTES) {
      return Response.json({ error: "Upload too large." }, { status: 413 });
    }
    const body = JSON.parse(raw) as PlanPostBody;
    const viewer = await readViewer(request);
    const result = await editPlan(viewer, planId, body);
    return serviceResponse(result, (value) => ({ id: value.id }));
  } catch (error) {
    return serverErrorResponse(error, "Updating the plan failed.");
  }
}

/** Deletes a post: the signed-in owner or the site admin (account or header). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ planId: string }> },
) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return unconfigured();
  }

  try {
    const { planId } = await params;
    const viewer = await readViewer(request);
    const result = await deletePlan(viewer, planId);
    return serviceResponse(result, (value) => value);
  } catch (error) {
    return serverErrorResponse(error, "Deleting the plan failed.");
  }
}
