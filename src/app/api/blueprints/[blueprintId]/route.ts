import { NextResponse } from "next/server";
import { BLUEPRINT_BODY_MAX_BYTES } from "@/lib/blueprints/types";
import { readJsonCapped } from "@/lib/server/http/request-body";
import { serviceResponse } from "@/lib/server/http/service-response";
import { isSignedIn, readViewer } from "@/lib/server/http/viewer";
import {
  blueprintEditAllowed,
  deleteBlueprint,
  readBlueprint,
  updateBlueprint,
  type BlueprintBody,
} from "@/lib/server/services/blueprints";
import { isDatabaseConfigured } from "@/lib/server/services/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ blueprintId: string }> };

const unconfigured = () =>
  NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });

/** The owner's blueprint with its payload, fetched only when it is placed (`readBlueprint`). */
export async function GET(request: Request, context: RouteContext) {
  if (!isDatabaseConfigured()) {
    return unconfigured();
  }
  const viewer = await readViewer(request);
  const { blueprintId } = await context.params;
  return serviceResponse(await readBlueprint(viewer, blueprintId), (value) => value);
}

/** Edits the owner's blueprint in place (`updateBlueprint`). */
export async function PUT(request: Request, context: RouteContext) {
  if (!isDatabaseConfigured()) {
    return unconfigured();
  }
  const viewer = await readViewer(request);
  if (!isSignedIn(viewer)) {
    return NextResponse.json({ error: "Sign in to edit blueprints." }, { status: 401 });
  }
  const allowed = await blueprintEditAllowed(viewer);
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
  const { blueprintId } = await context.params;
  return serviceResponse(await updateBlueprint(viewer, blueprintId, body), (value) => value);
}

/** Deletes the owner's blueprint (`deleteBlueprint`). */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isDatabaseConfigured()) {
    return unconfigured();
  }
  const viewer = await readViewer(request);
  if (!isSignedIn(viewer)) {
    return NextResponse.json({ error: "Sign in to use blueprints." }, { status: 401 });
  }
  const { blueprintId } = await context.params;
  return serviceResponse(await deleteBlueprint(viewer, blueprintId), (value) => value);
}
