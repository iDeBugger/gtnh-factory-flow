import { NextResponse } from "next/server";
import { factoryProjectSchema } from "@/lib/model/schemas";
import { COMMUNITY_UPLOAD_BODY_MAX_BYTES, COMMUNITY_UPLOAD_MAX_BYTES } from "@/lib/community/types";
import {
  LIBRARY_DESIGN_NAME_MAX_LENGTH,
  LIBRARY_MAX_DESIGNS,
  type DesignUpsertBody,
} from "@/lib/library/sync-types";
import { designRole, leaseHeld, notifyLive, requestedOwner } from "@/lib/server/cloud-plans";
import {
  checkRateLimit,
  getCommunityDb,
  getSessionUser,
  isCommunityConfigured,
  parseEntryIcon,
} from "@/lib/server/community";
import {
  CLOCK_AHEAD_MESSAGE,
  DESIGN_META_COLUMNS,
  isFutureStamp,
  isIsoTimestamp,
  isLibraryId,
  libraryStorageErrorMessage,
  readDesignRow,
  rowToDesignMeta,
  type DesignRow,
} from "@/lib/server/library";
import { readTextCapped } from "@/lib/server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ designId: string }> };

const LIVE_REFUSAL = {
  error: "This plan is open live. Its edits go through the live connection.",
  live: true,
};

/**
 * The plan itself, fetched when a pull finds it missing or moved. `?owner=`
 * reads a plan shared with the caller; absent, the caller's own.
 */
export async function GET(request: Request, context: RouteContext) {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign in to sync your library." }, { status: 401 });
  }

  const { designId } = await context.params;
  const ownerId = requestedOwner(request, sessionUser.id);
  if (!ownerId) {
    return NextResponse.json({ error: "Bad owner id." }, { status: 400 });
  }
  const db = getCommunityDb();
  const role = await designRole(db, sessionUser.id, ownerId, designId);
  if (!role) {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }
  const { data, error } = await readDesignRow(db, ownerId, designId, true);
  if (error) {
    return NextResponse.json(
      { error: libraryStorageErrorMessage(error, "The design could not be loaded.") },
      { status: 500 },
    );
  }
  // A member never sees a tombstone: the plan is gone for them.
  if (!data || (role === "editor" && data.deleted_at)) {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }
  return NextResponse.json({
    design: rowToDesignMeta(data),
    plan: data.plan,
    ownerId,
    role,
    seq: Number(data.seq ?? 0),
    live: leaseHeld(data.live_lease_until),
  });
}

/**
 * Upsert. The client owns the timestamps: `updatedAt` moves on any change,
 * `planUpdatedAt` only when the plan did, and the plan rides only then. A
 * row already NEWER than the incoming one (another device wrote since) is
 * left alone and reported back, so the client can pull it instead.
 *
 * While the live service holds the plan, a plan body is refused (409,
 * `live: true`); metadata still lands. A member (`?owner=`) may save the
 * plan and its name; the owner's folders, order and stars stay theirs.
 */
export async function PUT(request: Request, context: RouteContext) {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign in to sync your library." }, { status: 401 });
  }
  // Everything that can refuse the request without the database goes before
  // the rate limit, which costs two round trips (a count and an insert).
  const { designId } = await context.params;
  if (!isLibraryId(designId)) {
    return NextResponse.json({ error: "Bad design id." }, { status: 400 });
  }
  const ownerId = requestedOwner(request, sessionUser.id);
  if (!ownerId) {
    return NextResponse.json({ error: "Bad owner id." }, { status: 400 });
  }

  // Bytes first (nothing past the cap is buffered), then the player's limit
  // in characters, which is what the client counts.
  const raw = await readTextCapped(request, COMMUNITY_UPLOAD_BODY_MAX_BYTES);
  if (raw === undefined || raw.length > COMMUNITY_UPLOAD_MAX_BYTES) {
    return NextResponse.json({ error: "This design is too large to sync." }, { status: 413 });
  }
  let body: Partial<DesignUpsertBody>;
  try {
    body = JSON.parse(raw) as Partial<DesignUpsertBody>;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > LIBRARY_DESIGN_NAME_MAX_LENGTH) {
    return NextResponse.json({ error: "Design names run 1 to 80 characters." }, { status: 400 });
  }
  if (
    !isIsoTimestamp(body.createdAt) ||
    !isIsoTimestamp(body.updatedAt) ||
    !isIsoTimestamp(body.planUpdatedAt)
  ) {
    return NextResponse.json({ error: "Bad timestamps." }, { status: 400 });
  }
  // The edit stamps only: `createdAt` is sent unchanged on every push, so a
  // clock that was ahead once would refuse the design forever, and only the
  // owner's own shelf sorts on it, by their own stamp.
  if (isFutureStamp(body.updatedAt) || isFutureStamp(body.planUpdatedAt)) {
    return NextResponse.json({ error: CLOCK_AHEAD_MESSAGE }, { status: 400 });
  }
  if (body.folderId !== null && body.folderId !== undefined && !isLibraryId(body.folderId)) {
    return NextResponse.json({ error: "Bad folder id." }, { status: 400 });
  }
  // Autosave pushes a few seconds after edits stop; a busy hour is hundreds,
  // not thousands.
  if (!(await checkRateLimit(`user:${sessionUser.id}`, "library-save", 1200, 60 * 60))) {
    return NextResponse.json({ error: "Saving too fast. Try again later." }, { status: 429 });
  }

  const db = getCommunityDb();
  const isOwner = ownerId === sessionUser.id;
  if (!isOwner && !(await designRole(db, sessionUser.id, ownerId, designId))) {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }
  const {
    data: current,
    error: readError,
    cloudColumns,
  } = await readDesignRow(db, ownerId, designId, false);
  if (readError) {
    return NextResponse.json(
      { error: libraryStorageErrorMessage(readError, "The design could not be saved.") },
      { status: 500 },
    );
  }
  if (!isOwner && (!current || current.deleted_at)) {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }

  // Another device wrote later than this one: the caller is behind, and its
  // pull will sort it out. Nothing is overwritten.
  if (current && Date.parse(current.updated_at) > Date.parse(body.updatedAt)) {
    return NextResponse.json({ design: rowToDesignMeta(current), behind: true });
  }

  let plan: unknown;
  if (body.plan !== undefined) {
    if (current && leaseHeld(current.live_lease_until)) {
      return NextResponse.json(LIVE_REFUSAL, { status: 409 });
    }
    const parsed = factoryProjectSchema.safeParse(body.plan);
    if (!parsed.success) {
      return NextResponse.json({ error: "The plan is not valid." }, { status: 400 });
    }
    plan = parsed.data;
  } else if (!current) {
    return NextResponse.json({ error: "A new design needs its plan." }, { status: 400 });
  }

  if (!current) {
    const { count } = await db
      .from("library_designs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", sessionUser.id)
      .is("deleted_at", null);
    if ((count ?? 0) >= LIBRARY_MAX_DESIGNS) {
      return NextResponse.json(
        { error: `Your plans are full (${LIBRARY_MAX_DESIGNS} designs). Delete some first.` },
        { status: 409 },
      );
    }
  }

  const row: Record<string, unknown> = isOwner
    ? {
        user_id: sessionUser.id,
        id: designId,
        name,
        icon: parseEntryIcon(body.icon),
        folder_id: body.folderId ?? null,
        closed: body.closed === true,
        favorite: body.favorite === true,
        sort_order: Number.isInteger(body.order) ? body.order : null,
        community_plan_id:
          typeof body.communityPlanId === "string" && body.communityPlanId.length <= 64
            ? body.communityPlanId
            : null,
        created_at: body.createdAt,
        updated_at: body.updatedAt,
        plan_updated_at: body.planUpdatedAt,
        // Writing a design brings it back: a tombstone is only ever older.
        deleted_at: null,
      }
    : {
        name,
        updated_at: body.updatedAt,
        plan_updated_at: body.planUpdatedAt,
      };
  if (plan !== undefined) {
    row.plan = plan;
    if (cloudColumns && current) {
      // A lapsed lease's room must not write over this plan: its writes are
      // conditional on its token, which this clears.
      row.live_lease_token = null;
    }
  }

  // An UPDATE for a row that exists, an INSERT for one that does not: an
  // upsert forms the insert row first, and a metadata-only save (no plan)
  // would trip the NOT NULL on plan before the conflict was ever checked.
  // A plan lands only while no live lease is held: the live service may
  // have taken one since the read above.
  const writeRow = () => {
    if (!current) {
      return db.from("library_designs").insert(row).select(DESIGN_META_COLUMNS).single();
    }
    const update = db.from("library_designs").update(row).eq("user_id", ownerId).eq("id", designId);
    const unleased =
      plan !== undefined && cloudColumns
        ? update.or(`live_lease_until.is.null,live_lease_until.lt.${new Date().toISOString()}`)
        : update;
    return unleased.select(DESIGN_META_COLUMNS).maybeSingle();
  };
  const { data, error } = await writeRow();
  if (current && !error && !data) {
    return NextResponse.json(LIVE_REFUSAL, { status: 409 });
  }
  if (error || !data) {
    return NextResponse.json(
      { error: libraryStorageErrorMessage(error, "The design could not be saved.") },
      { status: 500 },
    );
  }
  return NextResponse.json({ design: rowToDesignMeta(data as DesignRow), behind: false });
}

/**
 * A tombstone, never a hole: other devices need to hear about it. Only the
 * owner deletes; the plan's members lose it at once (their rows go, and the
 * live service drops them from an open room). A member leaves through the
 * members route instead.
 */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign in to sync your library." }, { status: 401 });
  }

  const { designId } = await context.params;
  const ownerId = requestedOwner(request, sessionUser.id);
  if (!ownerId) {
    return NextResponse.json({ error: "Bad owner id." }, { status: 400 });
  }
  if (ownerId !== sessionUser.id) {
    return NextResponse.json({ error: "Only the plan's owner can delete it." }, { status: 403 });
  }
  const now = new Date().toISOString();
  const db = getCommunityDb();
  const { error } = await db
    .from("library_designs")
    .update({ deleted_at: now, updated_at: now, plan: {} })
    .eq("user_id", sessionUser.id)
    .eq("id", designId);
  if (error) {
    return NextResponse.json(
      { error: libraryStorageErrorMessage(error, "The design could not be deleted.") },
      { status: 500 },
    );
  }
  // A database without the members table has nobody to drop.
  await db
    .from("library_design_members")
    .delete()
    .eq("owner_id", sessionUser.id)
    .eq("design_id", designId);
  await notifyLive({ kind: "deleted", ownerId: sessionUser.id, designId });
  return NextResponse.json({ ok: true, deletedAt: now });
}
