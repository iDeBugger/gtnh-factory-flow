import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/error-response";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/mod-and-community-gate";
import type { BoardClipboardPayload } from "@/store/factory-store";
import { getCommunityDb, isCommunityConfigured } from "@/lib/server/db";
import { getSessionUser } from "@/lib/server/auth/sessions";
import { blueprintStorageErrorMessage } from "@/lib/server/db";
import {
  BLUEPRINT_SUMMARY_COLUMNS,
  rowToBlueprintSummary,
  type BlueprintRow,
} from "@/lib/server/blueprints";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fetches a PUBLIC blueprint's payload for placing and counts the download.
 * Authors placing their own published work don't inflate their own counter —
 * the mine-tab place path uses the plain GET, and even here an owner hit is
 * left uncounted.
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
    const db = getCommunityDb();
    const { data, error } = await db
      .from("blueprints")
      .select(`${BLUEPRINT_SUMMARY_COLUMNS},payload`)
      .eq("id", blueprintId)
      .eq("is_public", true)
      .maybeSingle();
    if (error) {
      return NextResponse.json(
        { error: blueprintStorageErrorMessage(error, "Blueprint could not be loaded.") },
        { status: 500 },
      );
    }
    if (!data) {
      return NextResponse.json({ error: "Blueprint not found." }, { status: 404 });
    }

    const row = data as BlueprintRow & { payload: BoardClipboardPayload };
    const sessionUser = await getSessionUser(request);
    const isOwner = Boolean(sessionUser && row.user_id === sessionUser.id);
    if (!isOwner) {
      await db
        .from("blueprints")
        .update({ downloads: row.downloads + 1 })
        .eq("id", blueprintId);
    }

    return NextResponse.json(
      {
        blueprint: {
          ...rowToBlueprintSummary(row, sessionUser?.id),
          downloads: row.downloads + (isOwner ? 0 : 1),
          payload: row.payload,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return serverErrorResponse(error, "Downloading the blueprint failed.");
  }
}
