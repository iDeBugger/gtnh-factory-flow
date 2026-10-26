import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import {
  readJsonCapped,
  REQUEST_TOO_BIG_MESSAGE,
  SMALL_JSON_MAX_BYTES,
} from "@/lib/server/http/request-body";
import { serviceResponse } from "@/lib/server/http/service-response";
import { isSignedIn, readViewer } from "@/lib/server/http/viewer";
import {
  blueprintPublishAllowed,
  publishBlueprint,
  type BlueprintPublishBody,
} from "@/lib/server/services/blueprints";
import { isDatabaseConfigured } from "@/lib/server/services/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Publishes the owner's blueprint to the network, or pulls it back (`publishBlueprint`). */
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
  const viewer = await readViewer(request);
  if (!isSignedIn(viewer)) {
    return NextResponse.json({ error: "Sign in to publish blueprints." }, { status: 401 });
  }
  const allowed = await blueprintPublishAllowed(viewer);
  if (!allowed.ok) {
    return serviceResponse(allowed, () => ({}));
  }

  const read = await readJsonCapped(request, SMALL_JSON_MAX_BYTES);
  if (!read.ok) {
    return read.status === 413
      ? NextResponse.json({ error: REQUEST_TOO_BIG_MESSAGE }, { status: 413 })
      : NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const body = (read.value ?? {}) as BlueprintPublishBody;
  const { blueprintId } = await context.params;
  return serviceResponse(await publishBlueprint(viewer, blueprintId, body), (value) => value);
}
