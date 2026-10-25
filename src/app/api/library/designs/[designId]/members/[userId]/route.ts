import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/error-response";
import { isAccountId } from "@/lib/live/protocol";
import { LIBRARY_MAX_MEMBERS } from "@/lib/library/sync-types";
import { designRole, listMembers, notifyLive, requestedOwner } from "@/lib/server/cloud-plans";
import { checkRateLimit } from "@/lib/server/limits/rate-limit";
import { getCommunityDb, isCommunityConfigured } from "@/lib/server/db";
import { getSessionUser } from "@/lib/server/auth/sessions";
import { libraryStorageErrorMessage } from "@/lib/server/db";
import { isLibraryId, readDesignRow } from "@/lib/server/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ designId: string; userId: string }> };

/** Accounts an owner may add to their plans an hour: share spam goes nowhere fast. */
const SHARE_ADDS_PER_HOUR = 30;

/**
 * Sharing a plan: the owner adds an account as an editor (PUT) or takes one
 * off (DELETE); a member takes themselves off (leaving). Each change reaches
 * the live service, so an open room updates and a removed member is dropped.
 */

async function prepare(request: Request, context: RouteContext) {
  if (!isCommunityConfigured()) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 }),
    };
  }
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Sign in to share plans." }, { status: 401 }),
    };
  }
  const { designId, userId: rawUserId } = await context.params;
  const ownerId = requestedOwner(request, sessionUser.id);
  if (!ownerId || !isLibraryId(designId) || !isAccountId(rawUserId)) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Bad plan or account id." }, { status: 400 }),
    };
  }
  if (!(await checkRateLimit(`user:${sessionUser.id}`, "library-share", 300, 60 * 60))) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Sharing too fast. Try again later." }, { status: 429 }),
    };
  }
  return { ok: true as const, sessionUser, ownerId, designId, userId: rawUserId.toLowerCase() };
}

/** Shares the plan with an account (owner only). Sharing again is a no-op. */
export async function PUT(request: Request, context: RouteContext) {
  const ready = await prepare(request, context);
  if (!ready.ok) {
    return ready.response;
  }
  const { sessionUser, ownerId, designId, userId } = ready;
  if (ownerId !== sessionUser.id) {
    return NextResponse.json({ error: "Only the plan's owner can share it." }, { status: 403 });
  }
  if (userId === sessionUser.id) {
    return NextResponse.json({ error: "The plan is already yours." }, { status: 400 });
  }
  const db = getCommunityDb();
  try {
    const { data: design, error } = await readDesignRow(db, ownerId, designId, false);
    if (error) {
      return NextResponse.json(
        { error: libraryStorageErrorMessage(error, "The plan could not be shared.") },
        { status: 500 },
      );
    }
    if (!design || design.deleted_at) {
      return NextResponse.json({ error: "Design not found." }, { status: 404 });
    }
    const { data: account } = await db
      .from("community_users")
      .select("id")
      .eq("id", userId)
      .maybeSingle();
    if (!account) {
      return NextResponse.json({ error: "No such account." }, { status: 404 });
    }
    const before = await listMembers(db, ownerId, designId);
    let added = false;
    if (!before.some((member) => member.id === userId)) {
      if (before.length >= LIBRARY_MAX_MEMBERS) {
        return NextResponse.json(
          { error: `A plan can be shared with ${LIBRARY_MAX_MEMBERS} accounts at most.` },
          { status: 409 },
        );
      }
      // Each share shows the plan in someone else's library: an owner adds
      // at most SHARE_ADDS_PER_HOUR a hour, across all their plans.
      if (
        !(await checkRateLimit(`user:${ownerId}`, "library-share-add", SHARE_ADDS_PER_HOUR, 60 * 60))
      ) {
        return NextResponse.json(
          { error: `You can share with ${SHARE_ADDS_PER_HOUR} people an hour. Try again later.` },
          { status: 429 },
        );
      }
      const { error: insertError } = await db
        .from("library_design_members")
        .upsert(
          { owner_id: ownerId, design_id: designId, member_id: userId, role: "editor" },
          { onConflict: "owner_id,design_id,member_id", ignoreDuplicates: true },
        );
      if (insertError) {
        return NextResponse.json(
          { error: libraryStorageErrorMessage(insertError, "The plan could not be shared.") },
          { status: 500 },
        );
      }
      added = true;
    }
    const members = await listMembers(db, ownerId, designId);
    await notifyLive({
      kind: "members",
      ownerId,
      designId,
      members,
      ...(added
        ? {
            added: [userId],
            owner: { id: ownerId, username: sessionUser.username },
            name: String(design.name ?? ""),
          }
        : {}),
    });
    return NextResponse.json({ members });
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
  const { sessionUser, ownerId, designId, userId } = ready;
  const db = getCommunityDb();
  try {
    if (ownerId !== sessionUser.id) {
      const leaving =
        userId === sessionUser.id &&
        (await designRole(db, sessionUser.id, ownerId, designId)) === "editor";
      if (!leaving) {
        return NextResponse.json(
          { error: "Only the plan's owner can change who it is shared with." },
          { status: 403 },
        );
      }
    }
    const { error } = await db
      .from("library_design_members")
      .delete()
      .eq("owner_id", ownerId)
      .eq("design_id", designId)
      .eq("member_id", userId);
    if (error) {
      return NextResponse.json(
        { error: libraryStorageErrorMessage(error, "Sharing could not be changed.") },
        { status: 500 },
      );
    }
    const members = await listMembers(db, ownerId, designId);
    await notifyLive({ kind: "members", ownerId, designId, members, removed: [userId] });
    return NextResponse.json({ members });
  } catch (error) {
    return serverErrorResponse(error, "Sharing could not be changed.");
  }
}
