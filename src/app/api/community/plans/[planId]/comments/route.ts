import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/http/error-response";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { addComment, commentAccess, listComments } from "@/lib/server/services/comments";
import { readViewer } from "@/lib/server/http/viewer";
import { serviceResponse } from "@/lib/server/http/service-response";
import {
  COMMENT_BODY_MAX_BYTES,
  readJsonCapped,
  REQUEST_TOO_BIG_MESSAGE,
} from "@/lib/server/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ planId: string }> };

export async function GET(request: Request, context: RouteContext) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Community hub is not configured." }, { status: 503 });
  }
  try {
    const { planId } = await context.params;
    const result = await listComments(await readViewer(request), planId);
    return serviceResponse(result, (value) => value);
  } catch (error) {
    return serverErrorResponse(error, "Comments could not be loaded.");
  }
}

export async function POST(request: Request, context: RouteContext) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Community hub is not configured." }, { status: 503 });
  }
  try {
    const viewer = await readViewer(request);
    const { planId } = await context.params;
    const access = await commentAccess(viewer, planId);
    if (!access.ok) {
      return serviceResponse(access, () => undefined);
    }

    const read = await readJsonCapped(request, COMMENT_BODY_MAX_BYTES);
    if (!read.ok) {
      return read.status === 413
        ? NextResponse.json({ error: REQUEST_TOO_BIG_MESSAGE }, { status: 413 })
        : NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    const result = await addComment(viewer, planId, access.value.planOwnerId, read.value);
    return serviceResponse(result, (value) => value);
  } catch (error) {
    return serverErrorResponse(error, "The comment could not be posted.");
  }
}
