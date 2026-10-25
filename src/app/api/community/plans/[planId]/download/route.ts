import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/error-response";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/mod-and-community-gate";
import {
  getCommunityDb,
  getSessionUser,
  isAdminRequest,
  isCommunityConfigured,
} from "@/lib/server/community";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns the full plan JSON and counts the download. */
export async function POST(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Community hub is not configured." }, { status: 503 });
  }

  try {
    const { planId } = await params;
    const db = getCommunityDb();

    const { data, error } = await db
      .from("community_plans")
      .select("plan,downloads,name,is_public,user_id")
      .eq("id", planId)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "Plan not found." }, { status: 404 });
    }

    // Unpublished posts download only for their owner (and the site admin).
    if (data.is_public === false && !isAdminRequest(request)) {
      const sessionUser = await getSessionUser(request);
      if (data.user_id !== sessionUser?.id && !sessionUser?.is_admin) {
        return NextResponse.json({ error: "Plan not found." }, { status: 404 });
      }
    }

    await db
      .from("community_plans")
      .update({ downloads: (data.downloads as number) + 1 })
      .eq("id", planId);

    return NextResponse.json(
      { name: data.name, plan: data.plan },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return serverErrorResponse(error, "Downloading the plan failed.");
  }
}
