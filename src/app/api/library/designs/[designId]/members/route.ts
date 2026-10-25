import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/http/error-response";
import { designRole, listMembers, requestedOwner, usernamesFor } from "@/lib/server/cloud-plans";
import { getCommunityDb, isCommunityConfigured, libraryStorageErrorMessage } from "@/lib/server/db";
import { getSessionUser } from "@/lib/server/auth/sessions";
import { readDesignRow } from "@/lib/server/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ designId: string }> };

/** Who a plan is shared with: for its owner and its members. `?owner=` names a plan shared with the caller. */
export async function GET(request: Request, context: RouteContext) {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign in to share plans." }, { status: 401 });
  }
  const { designId } = await context.params;
  const ownerId = requestedOwner(request, sessionUser.id);
  if (!ownerId) {
    return NextResponse.json({ error: "Bad owner id." }, { status: 400 });
  }
  const db = getCommunityDb();
  try {
    const role = await designRole(db, sessionUser.id, ownerId, designId);
    const { data, error } = await readDesignRow(db, ownerId, designId, false);
    if (error) {
      return NextResponse.json(
        { error: libraryStorageErrorMessage(error, "The plan's members could not be loaded.") },
        { status: 500 },
      );
    }
    if (!role || !data || data.deleted_at) {
      return NextResponse.json({ error: "Design not found." }, { status: 404 });
    }
    const [members, owner] = await Promise.all([
      listMembers(db, ownerId, designId),
      usernamesFor(db, [ownerId]),
    ]);
    return NextResponse.json({ ownerId, ownerName: owner.get(ownerId) ?? "", role, members });
  } catch (error) {
    return serverErrorResponse(error, "The plan's members could not be loaded.");
  }
}
