import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { countPlanView } from "@/lib/server/services/community-plans";
import { readViewer } from "@/lib/server/http/viewer";
import { databaseDownResponse } from "@/lib/server/http/error-response";
import { serviceResponse } from "@/lib/server/http/service-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Counts one view of a post. A write of its own, so no read of the post
 * changes anything: a GET that counted was a counter anyone could run up
 * with a link or a loop, and a read must be safe to repeat. The library's
 * grid sends it once when a player opens a post's page (`countPlanView`);
 * every other read of a post is a lookup and counts nothing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Community hub is not configured." }, { status: 503 });
  }

  try {
    const { planId } = await params;
    const viewer = await readViewer(request);
    const result = await countPlanView(viewer, planId, request);
    return serviceResponse(result, (value) => ({ views: value.views }));
  } catch (error) {
    const down = databaseDownResponse(error, { headers: { "Cache-Control": "no-store" } });
    if (down) {
      return down;
    }
    console.error("view count failed", error);
    return NextResponse.json({ error: "Counting the view failed." }, { status: 500 });
  }
}
