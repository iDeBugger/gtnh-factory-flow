import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { BLUEPRINT_DESCRIPTION_MAX_LENGTH } from "@/lib/blueprints/types";
import { checkRateLimit } from "@/lib/server/limits/rate-limit";
import {
  getCommunityDb,
  isCommunityConfigured,
  blueprintStorageErrorMessage,
} from "@/lib/server/db";
import { getSessionUser } from "@/lib/server/auth/sessions";
import {
  BLUEPRINT_SUMMARY_COLUMNS,
  rowToBlueprintSummary,
  type BlueprintRow,
} from "@/lib/server/blueprints";
import {
  readJsonCapped,
  REQUEST_TOO_BIG_MESSAGE,
  SMALL_JSON_MAX_BYTES,
} from "@/lib/server/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Publishes a blueprint to the network, or pulls it back. Owner only. The
 * payload never changes — publishing stamps visibility, the author's name,
 * an optional description, and the publish time. Votes survive an
 * unpublish/republish round trip; a deleted blueprint takes them with it.
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

  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign in to publish blueprints." }, { status: 401 });
  }

  if (!(await checkRateLimit(`user:${sessionUser.id}`, "blueprint-publish", 30, 60 * 60))) {
    return NextResponse.json(
      { error: "Publishing too fast. Try again later." },
      { status: 429 },
    );
  }

  const read = await readJsonCapped(request, SMALL_JSON_MAX_BYTES);
  if (!read.ok) {
    return read.status === 413
      ? NextResponse.json({ error: REQUEST_TOO_BIG_MESSAGE }, { status: 413 })
      : NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const body = read.value;
  const { publish, description } = (body ?? {}) as { publish?: unknown; description?: unknown };
  if (typeof publish !== "boolean") {
    return NextResponse.json({ error: "Invalid publish request." }, { status: 400 });
  }
  const trimmedDescription =
    typeof description === "string"
      ? description.trim().slice(0, BLUEPRINT_DESCRIPTION_MAX_LENGTH)
      : undefined;

  const { blueprintId } = await context.params;
  const db = getCommunityDb();
  const patch = publish
    ? {
        is_public: true,
        author_name: sessionUser.username,
        published_at: new Date().toISOString(),
        ...(trimmedDescription !== undefined ? { description: trimmedDescription } : undefined),
      }
    : { is_public: false };

  // Ownership is the cookie's user id; the update silently matches nothing
  // for anyone else's blueprint, which reads back as 404.
  const { data, error } = await db
    .from("blueprints")
    .update(patch)
    .eq("id", blueprintId)
    .eq("user_id", sessionUser.id)
    .select(BLUEPRINT_SUMMARY_COLUMNS)
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: blueprintStorageErrorMessage(error, "Publishing failed.") },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({ error: "Blueprint not found." }, { status: 404 });
  }

  return NextResponse.json({
    blueprint: rowToBlueprintSummary(data as BlueprintRow, sessionUser.id),
  });
}
