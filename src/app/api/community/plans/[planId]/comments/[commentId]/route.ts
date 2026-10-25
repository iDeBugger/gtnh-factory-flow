import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { deleteComment } from "@/lib/server/services/comments";
import { readViewer } from "@/lib/server/http/viewer";
import { serviceResponse } from "@/lib/server/http/service-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ planId: string; commentId: string }> };

/**
 * Takes a comment down: its author, the post's owner or an admin may. A
 * tombstone, not a hole, so the thread keeps its shape server-side.
 */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Community hub is not configured." }, { status: 503 });
  }
  const viewer = await readViewer(request);
  const { planId, commentId } = await context.params;
  const result = await deleteComment(viewer, planId, commentId);
  return serviceResponse(result, (value) => value);
}
