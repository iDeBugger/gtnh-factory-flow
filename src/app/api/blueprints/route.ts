import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { BLUEPRINT_BODY_MAX_BYTES } from "@/lib/blueprints/types";
import { readJsonCapped } from "@/lib/server/http/request-body";
import { serviceResponse } from "@/lib/server/http/service-response";
import { isSignedIn, readViewer } from "@/lib/server/http/viewer";
import {
  blueprintSaveAllowed,
  listBlueprints,
  saveBlueprint,
  type BlueprintBody,
} from "@/lib/server/services/blueprints";
import { isDatabaseConfigured } from "@/lib/server/services/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The account's own blueprints, or with `?scope=public` the public shelf (`listBlueprints`). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const shelf = url.searchParams.get("scope") === "public";
  // The public shelf is the community library, absent with the setting off
  // whatever the server's storage; an account's own blueprints stay
  // whatever the setting.
  if (shelf && !isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const viewer = await readViewer(request);
  const result = await listBlueprints(
    viewer,
    shelf
      ? {
          shelf: "public",
          sort: url.searchParams.get("sort"),
          search: url.searchParams.get("search") ?? "",
          page: url.searchParams.get("page"),
          deviceId: url.searchParams.get("deviceId") ?? "",
        }
      : { shelf: "mine" },
    request,
  );
  return serviceResponse(result, (value) => value);
}

/** Saves a new blueprint to the signed-in account (`saveBlueprint`). */
export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const viewer = await readViewer(request);
  if (!isSignedIn(viewer)) {
    return NextResponse.json({ error: "Sign in to save blueprints." }, { status: 401 });
  }
  const allowed = await blueprintSaveAllowed(viewer);
  if (!allowed.ok) {
    return serviceResponse(allowed, () => ({}));
  }

  const read = await readJsonCapped(request, BLUEPRINT_BODY_MAX_BYTES);
  if (!read.ok) {
    return read.status === 413
      ? NextResponse.json({ error: "Blueprint is too large to save." }, { status: 413 })
      : NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const body = (read.value ?? {}) as BlueprintBody;
  return serviceResponse(await saveBlueprint(viewer, body), (value) => value);
}
