import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { castVote, parseVoteInput } from "@/lib/server/services/votes";
import { readViewer } from "@/lib/server/http/viewer";
import { serviceResponse } from "@/lib/server/http/service-response";
import {
  readJsonCapped,
  REQUEST_TOO_BIG_MESSAGE,
  SMALL_JSON_MAX_BYTES,
} from "@/lib/server/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Casts, switches, or (when re-sending the same value) retracts a vote on a
 * PUBLIC blueprint, by the plan vote's algorithm (`castVote`): keyed by the
 * signed-in user, else the device id, paced by address, and an anonymous
 * address gets a few casts per blueprint a day, so a made-up device id is
 * not a fresh vote.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ blueprintId: string }> },
) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
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
    const input = parseVoteInput(read.value);
    if (!input.ok) {
      return serviceResponse(input, () => undefined);
    }
    const viewer = await readViewer(request);
    const result = await castVote("blueprint", blueprintId, viewer, input.value, request);
    return serviceResponse(result, (value) => value);
  } catch (error) {
    // A fixed sentence: the database's own words would say whether the id exists.
    console.error("blueprint vote failed", error);
    return NextResponse.json({ error: "Voting failed." }, { status: 500 });
  }
}
