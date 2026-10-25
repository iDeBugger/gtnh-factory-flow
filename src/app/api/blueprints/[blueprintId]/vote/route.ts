import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import type { BlueprintVoteResponse } from "@/lib/blueprints/types";
import { checkRateLimit } from "@/lib/server/limits/rate-limit";
import { clientAddress } from "@/lib/server/http/client-address";
import {
  getCommunityDb,
  isCommunityConfigured,
  blueprintStorageErrorMessage,
} from "@/lib/server/db";
import { getSessionUser } from "@/lib/server/auth/sessions";
import { makeActorKey, makeVoterKey, saltedKey } from "@/lib/server/auth/keys";
import {
  NETWORK_VOTES_SPENT,
  VOTES_PER_ADDRESS_PER_PLAN_PER_DAY,
} from "@/lib/server/community-rows";
import {
  readJsonCapped,
  REQUEST_TOO_BIG_MESSAGE,
  SMALL_JSON_MAX_BYTES,
} from "@/lib/server/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Casts, switches, or (when re-sending the same value) retracts a vote on a
 * PUBLIC blueprint. Keyed like plan votes (`makeVoterKey`: the signed-in
 * user, else the device id), rate-limited by the actor key, and an anonymous
 * address gets a few casts per blueprint a day (the plan vote's rule, so a
 * made-up device id is not a fresh vote). Counts are recounted rather than
 * incremented, so they are idempotent under races.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ blueprintId: string }> },
) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }

  try {
    const { blueprintId } = await context.params;
    const read = await readJsonCapped(request, SMALL_JSON_MAX_BYTES);
    if (!read.ok) {
      return read.status === 413
        ? NextResponse.json({ error: REQUEST_TOO_BIG_MESSAGE }, { status: 413 })
        : NextResponse.json({ error: "Invalid vote." }, { status: 400 });
    }
    const body = (read.value ?? {}) as { deviceId?: unknown; value?: unknown };
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.slice(0, 64) : "";
    const value = body.value === 1 || body.value === -1 ? body.value : undefined;
    if (!deviceId || value === undefined) {
      return NextResponse.json({ error: "Invalid vote." }, { status: 400 });
    }

    const actorKey = makeActorKey(request);
    if (!(await checkRateLimit(actorKey, "blueprint-vote", 60, 60 * 10))) {
      return NextResponse.json({ error: "Voting too fast. Slow down." }, { status: 429 });
    }
    const voterKey = await makeVoterKey(request, deviceId);

    const db = getCommunityDb();
    const { data: target, error: targetError } = await db
      .from("blueprints")
      .select("id,is_public")
      .eq("id", blueprintId)
      .maybeSingle();
    if (targetError) {
      return NextResponse.json(
        { error: blueprintStorageErrorMessage(targetError, "Voting failed.") },
        { status: 500 },
      );
    }
    if (!target || !target.is_public) {
      return NextResponse.json({ error: "Blueprint not found." }, { status: 404 });
    }

    const { data: existing } = await db
      .from("blueprint_votes")
      .select("value")
      .eq("blueprint_id", blueprintId)
      .eq("voter_key", voterKey)
      .maybeSingle();

    const retracting = Boolean(existing && existing.value === value);
    if (!retracting && !(await getSessionUser(request))) {
      const perBlueprint = `votes:address:${saltedKey(clientAddress(request))}:${blueprintId}`;
      if (!(await checkRateLimit(perBlueprint, "vote-cast", VOTES_PER_ADDRESS_PER_PLAN_PER_DAY, 24 * 60 * 60))) {
        return NextResponse.json({ error: NETWORK_VOTES_SPENT }, { status: 429 });
      }
    }

    let myVote: 1 | -1 | undefined;
    if (retracting) {
      await db
        .from("blueprint_votes")
        .delete()
        .eq("blueprint_id", blueprintId)
        .eq("voter_key", voterKey);
      myVote = undefined;
    } else {
      const { error } = await db
        .from("blueprint_votes")
        .upsert({ blueprint_id: blueprintId, voter_key: voterKey, value });
      if (error) {
        throw new Error(error.message);
      }
      myVote = value;
    }

    const [{ count: upvotes }, { count: downvotes }] = await Promise.all([
      db
        .from("blueprint_votes")
        .select("blueprint_id", { count: "exact", head: true })
        .eq("blueprint_id", blueprintId)
        .eq("value", 1),
      db
        .from("blueprint_votes")
        .select("blueprint_id", { count: "exact", head: true })
        .eq("blueprint_id", blueprintId)
        .eq("value", -1),
    ]);

    const { error: updateError } = await db
      .from("blueprints")
      .update({ upvotes: upvotes ?? 0, downvotes: downvotes ?? 0 })
      .eq("id", blueprintId);
    if (updateError) {
      throw new Error(updateError.message);
    }

    const response: BlueprintVoteResponse = {
      upvotes: upvotes ?? 0,
      downvotes: downvotes ?? 0,
      score: (upvotes ?? 0) - (downvotes ?? 0),
      myVote,
    };
    return NextResponse.json(response);
  } catch (error) {
    // A fixed sentence: the database's own words would say whether the id exists.
    console.error("blueprint vote failed", error);
    return NextResponse.json({ error: "Voting failed." }, { status: 500 });
  }
}
