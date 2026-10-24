import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/mod-and-community-gate";
import type { CommunityVoteResponse } from "@/lib/community/types";
import {
  checkRateLimit,
  clientAddress,
  getCommunityDb,
  getSessionUser,
  isAdminRequest,
  isCommunityConfigured,
  makeActorKey,
  makeVoterKey,
  saltedKey,
  VOTES_PER_ADDRESS_PER_PLAN_PER_DAY,
} from "@/lib/server/community";
import { invalidatePlanListCache } from "@/lib/server/plan-list-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Casts, switches, or (when re-sending the same value) retracts a vote.
 * Votes are keyed by account or device id (see makeVoterKey); the IP only
 * feeds the rate limits. The post must exist and be public, unless the
 * voter owns it: an unpublished post is nobody else's to score, and the
 * answer for one must read the same as for a post that does not exist.
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
    const body = (await request.json()) as { deviceId?: unknown; value?: unknown };
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.slice(0, 64) : "";
    const value = body.value === 1 || body.value === -1 ? body.value : undefined;
    if (!deviceId || value === undefined) {
      return NextResponse.json({ error: "Invalid vote." }, { status: 400 });
    }

    const actorKey = makeActorKey(request);
    if (!(await checkRateLimit(actorKey, "vote", 60, 60 * 10))) {
      return NextResponse.json({ error: "Voting too fast. Slow down." }, { status: 429 });
    }

    const db = getCommunityDb();
    const sessionUser = await getSessionUser(request);
    const { data: target, error: targetError } = await db
      .from("community_plans")
      .select("id,is_public,user_id")
      .eq("id", planId)
      .maybeSingle<{ id: string; is_public: boolean | null; user_id: string | null }>();
    if (targetError) {
      return NextResponse.json({ error: "Voting failed." }, { status: 500 });
    }
    const mayVote =
      target &&
      (target.is_public !== false ||
        target.user_id === sessionUser?.id ||
        sessionUser?.is_admin ||
        isAdminRequest(request));
    if (!mayVote) {
      return NextResponse.json({ error: "Plan not found." }, { status: 404 });
    }

    const voterKey = await makeVoterKey(request, deviceId);
    const { data: existing } = await db
      .from("community_votes")
      .select("value")
      .eq("plan_id", planId)
      .eq("voter_key", voterKey)
      .maybeSingle();

    // A cast or a switch from an anonymous voter counts against the address
    // for this post; a retraction does not.
    const retracting = Boolean(existing && existing.value === value);
    if (!sessionUser && !retracting) {
      const perPlan = `votes:address:${saltedKey(clientAddress(request))}:${planId}`;
      if (!(await checkRateLimit(perPlan, "vote-cast", VOTES_PER_ADDRESS_PER_PLAN_PER_DAY, 24 * 60 * 60))) {
        return NextResponse.json({ error: "Voting too fast. Slow down." }, { status: 429 });
      }
    }

    let myVote: 1 | -1 | undefined;
    if (retracting) {
      await db.from("community_votes").delete().eq("plan_id", planId).eq("voter_key", voterKey);
      myVote = undefined;
    } else {
      const { error } = await db
        .from("community_votes")
        .upsert({ plan_id: planId, voter_key: voterKey, value });
      if (error) {
        throw new Error(error.message);
      }
      myVote = value;
    }

    // Recount instead of increment: idempotent under races and self-healing.
    const [{ count: upvotes }, { count: downvotes }] = await Promise.all([
      db
        .from("community_votes")
        .select("plan_id", { count: "exact", head: true })
        .eq("plan_id", planId)
        .eq("value", 1),
      db
        .from("community_votes")
        .select("plan_id", { count: "exact", head: true })
        .eq("plan_id", planId)
        .eq("value", -1),
    ]);

    const { error: updateError } = await db
      .from("community_plans")
      .update({ upvotes: upvotes ?? 0, downvotes: downvotes ?? 0 })
      .eq("id", planId);
    if (updateError) {
      throw new Error(updateError.message);
    }

    invalidatePlanListCache();
    const response: CommunityVoteResponse = {
      upvotes: upvotes ?? 0,
      downvotes: downvotes ?? 0,
      score: (upvotes ?? 0) - (downvotes ?? 0),
      myVote,
    };
    return NextResponse.json(response);
  } catch (error) {
    // A fixed sentence: the database's own words would say whether the id exists.
    console.error("vote failed", error);
    return NextResponse.json({ error: "Voting failed." }, { status: 500 });
  }
}
