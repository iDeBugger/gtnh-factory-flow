import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { castVote, parseVoteInput } from "@/lib/server/services/votes";
import { readViewer } from "@/lib/server/http/viewer";
import { databaseDownResponse } from "@/lib/server/http/error-response";
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
 * post (`castVote`). The post must exist and be one the voter may see: an
 * unpublished post is nobody else's to score, and the answer for one must
 * read the same as for a post that does not exist.
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
    const result = await castVote("plan", planId, viewer, input.value, request);
    return serviceResponse(result, (value) => value);
  } catch (error) {
    const down = databaseDownResponse(error, { headers: { "Cache-Control": "no-store" } });
    if (down) {
      return down;
    }
    // A fixed sentence: the database's own words would say whether the id exists.
    console.error("vote failed", error);
    return NextResponse.json(
      { error: "Voting failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
