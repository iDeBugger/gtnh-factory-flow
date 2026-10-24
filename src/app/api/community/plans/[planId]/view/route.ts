import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/mod-and-community-gate";
import {
  checkRateLimit,
  getCommunityDb,
  getSessionUser,
  isAdminRequest,
  isCommunityConfigured,
  makeActorKey,
} from "@/lib/server/community";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Views one address may count in a minute: a loop runs a counter up no faster than this. */
const VIEWS_PER_MINUTE = 60;

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
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Community hub is not configured." }, { status: 503 });
  }

  try {
    const { planId } = await params;
    if (!(await checkRateLimit(makeActorKey(request), "view", VIEWS_PER_MINUTE, 60))) {
      return NextResponse.json({ error: "Too many requests. Slow down." }, { status: 429 });
    }

    const db = getCommunityDb();
    const { data, error } = await db
      .from("community_plans")
      .select("views,is_public,user_id")
      .eq("id", planId)
      .maybeSingle<{ views: number; is_public: boolean | null; user_id: string | null }>();
    if (error) {
      return NextResponse.json({ error: "Counting the view failed." }, { status: 500 });
    }
    // Unpublished posts exist only for their owner (and the site admin).
    if (data?.is_public === false) {
      const sessionUser = await getSessionUser(request);
      if (data.user_id !== sessionUser?.id && !sessionUser?.is_admin && !isAdminRequest(request)) {
        return NextResponse.json({ error: "Plan not found." }, { status: 404 });
      }
    }
    if (!data) {
      return NextResponse.json({ error: "Plan not found." }, { status: 404 });
    }

    const views = data.views + 1;
    const { error: updateError } = await db.from("community_plans").update({ views }).eq("id", planId);
    if (updateError) {
      return NextResponse.json({ error: "Counting the view failed." }, { status: 500 });
    }
    return NextResponse.json({ views });
  } catch (error) {
    console.error("view count failed", error);
    return NextResponse.json({ error: "Counting the view failed." }, { status: 500 });
  }
}
