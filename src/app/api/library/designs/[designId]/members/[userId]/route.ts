import { NextResponse } from "next/server";
import { isAccountId } from "@/lib/live/protocol";
import { requestedOwner } from "@/lib/server/cloud-plans";
import { serverErrorResponse } from "@/lib/server/http/error-response";
import { serviceResponse } from "@/lib/server/http/service-response";
import { isSignedIn, readViewer } from "@/lib/server/http/viewer";
import { isLibraryId } from "@/lib/server/library";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { addMember, removeMember, sharingAllowed } from "@/lib/server/services/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ designId: string; userId: string }> };

/**
 * Sharing a plan: the owner adds an account as an editor (PUT) or takes one
 * off (DELETE); a member takes themselves off (leaving). Each change reaches
 * the live service, so an open room updates and a removed member is dropped.
 */

async function prepare(request: Request, context: RouteContext) {
  if (!isDatabaseConfigured()) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 }),
    };
  }
  const viewer = await readViewer(request);
  if (!isSignedIn(viewer)) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Sign in to share plans." }, { status: 401 }),
    };
  }
  const { designId, userId: rawUserId } = await context.params;
  const ownerId = requestedOwner(request, viewer.userId);
  if (!ownerId || !isLibraryId(designId) || !isAccountId(rawUserId)) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Bad plan or account id." }, { status: 400 }),
    };
  }
  const allowed = await sharingAllowed(viewer);
  if (!allowed.ok) {
    return { ok: false as const, response: serviceResponse(allowed, () => ({})) };
  }
  return { ok: true as const, viewer, ownerId, designId, userId: rawUserId.toLowerCase() };
}

/** Shares the plan with an account (owner only). Sharing again is a no-op. */
export async function PUT(request: Request, context: RouteContext) {
  const ready = await prepare(request, context);
  if (!ready.ok) {
    return ready.response;
  }
  const { viewer, ownerId, designId, userId } = ready;
  try {
    return serviceResponse(await addMember(viewer, ownerId, designId, userId), (shared) => shared);
  } catch (error) {
    return serverErrorResponse(error, "The plan could not be shared.");
  }
}

/** Stops sharing with an account: the owner removing anyone, or a member leaving. */
export async function DELETE(request: Request, context: RouteContext) {
  const ready = await prepare(request, context);
  if (!ready.ok) {
    return ready.response;
  }
  const { viewer, ownerId, designId, userId } = ready;
  try {
    return serviceResponse(
      await removeMember(viewer, ownerId, designId, userId),
      (shared) => shared,
    );
  } catch (error) {
    return serverErrorResponse(error, "Sharing could not be changed.");
  }
}
