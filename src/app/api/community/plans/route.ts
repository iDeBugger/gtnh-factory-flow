import { serverErrorResponse } from "@/lib/server/http/error-response";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { COMMUNITY_UPLOAD_BODY_MAX_BYTES, COMMUNITY_UPLOAD_MAX_BYTES } from "@/lib/community/types";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import {
  listPlans,
  publishPlan,
  readPlanListInput,
  type PlanPostBody,
} from "@/lib/server/services/community-plans";
import { readViewer } from "@/lib/server/http/viewer";
import { serviceResponse } from "@/lib/server/http/service-response";
import { readTextCapped } from "@/lib/server/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Community hub is not configured." }, { status: 503 });
  }

  try {
    const input = readPlanListInput(new URL(request.url).searchParams);
    const viewer = await readViewer(request);
    const result = await listPlans(viewer, input, request);
    return serviceResponse(
      result,
      (value) => value.body,
      (value) => (value.noStore ? { headers: { "Cache-Control": "no-store" } } : {}),
    );
  } catch (error) {
    return serverErrorResponse(error, "Listing community plans failed.");
  }
}

export async function POST(request: Request) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Community hub is not configured." }, { status: 503 });
  }

  try {
    // Bytes first (nothing past the cap is buffered), then the player's
    // limit in characters, which is what the client counts.
    const raw = await readTextCapped(request, COMMUNITY_UPLOAD_BODY_MAX_BYTES);
    if (raw === undefined || raw.length > COMMUNITY_UPLOAD_MAX_BYTES) {
      return Response.json({ error: "Upload too large." }, { status: 413 });
    }
    const body = JSON.parse(raw) as PlanPostBody;
    const viewer = await readViewer(request);
    const result = await publishPlan(viewer, body, request);
    return serviceResponse(result, (value) => ({ id: value.id }), { status: 201 });
  } catch (error) {
    return serverErrorResponse(error, "Sharing the plan failed.");
  }
}
