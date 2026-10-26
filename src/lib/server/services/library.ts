import { factoryProjectSchema } from "@/lib/model/schemas";
import {
  LIBRARY_DESIGN_NAME_MAX_LENGTH,
  LIBRARY_FOLDER_NAME_MAX_LENGTH,
  LIBRARY_MAX_DESIGNS,
  LIBRARY_MAX_FOLDERS,
  LIBRARY_MAX_MEMBERS,
  type DesignUpsertBody,
  type FolderUpsertBody,
  type LibraryListResponse,
  type PlanMember,
  type RemoteDesignMeta,
  type RemoteFolder,
  type SharedDesign,
} from "@/lib/library/sync-types";
import { leaseHeld } from "../cloud-plans";
import {
  isDatabaseDown,
  isDatabaseError,
  storageErrorMessage,
  withTransaction,
  type Tx,
} from "../db";
import { parseEntryIcon } from "../community-rows";
import type { SignedIn } from "../http/viewer";
import {
  CLOCK_AHEAD_MESSAGE,
  isFutureStamp,
  isIsoTimestamp,
  isLibraryId,
  rowToDesignMeta,
  rowToFolder,
} from "../library";
import { checkRateLimit } from "../limits/rate-limit";
import { notifyLive } from "../live-notify";
import { accountExists, lockAccount, usernamesFor } from "../repos/accounts";
import * as designMembers from "../repos/design-members";
import * as designs from "../repos/designs";
import * as folders from "../repos/folders";
import { designRole, type DesignRole } from "./design-role";
import { fail, ok, type ServiceResult } from "./result";

/**
 * The library: an account's designs and folders, synced from its devices,
 * and the designs shared with other accounts. A design id is unique per
 * owner only. Owners and members read a design; members save its plan and
 * name only; only the owner shares, unshares and deletes; a member never
 * sees a tombstone. While the live service holds a plan's lease, a REST save
 * carries no plan (`repos/designs` holds every lease write).
 *
 * The routes gate (configured, signed in) and parse (ids, `?owner=`, the
 * body); these take a signed-in viewer.
 */

/**
 * What a database failure the route answered with its own sentence says: the
 * database-down line, or the sentence (the database's message goes to the
 * log). Anything else is a bug and is thrown on.
 */
function storageFailure(error: unknown, fallback: string): ServiceResult<never> {
  const down = isDatabaseDown(error);
  if (!down && !isDatabaseError(error)) {
    throw error;
  }
  if (!down) {
    console.error(fallback, error);
  }
  return fail("unavailable", storageErrorMessage(error, fallback), { status: 500 });
}

const pairKey = (ownerId: string, designId: string) => `${ownerId}:${designId}`;

/**
 * The account's whole library, without plans: every design's metadata and
 * every folder, tombstones included. The browser reconciles against this
 * and fetches only the plans it is missing or that moved. Each design lists
 * who it is shared with, and `shared` lists the plans others shared with
 * this account. Any failed read fails the whole answer: the client removes
 * every shared copy the answer leaves out, so a partial list would delete
 * them.
 */
export async function listLibrary(viewer: SignedIn): Promise<ServiceResult<LibraryListResponse>> {
  const me = viewer.userId;
  const [ownRead, folderRead, memberRead] = await Promise.allSettled([
    designs.listOwn(me, LIBRARY_MAX_DESIGNS * 2),
    folders.listOwn(me, LIBRARY_MAX_FOLDERS * 2),
    // One read for both sides of sharing: my designs' members, and the
    // designs I am a member of.
    designMembers.rowsFor(me),
  ]);
  for (const read of [ownRead, folderRead, memberRead]) {
    if (read.status === "rejected") {
      return storageFailure(read.reason, "Your plans could not be loaded.");
    }
  }
  const ownDesigns = (ownRead as PromiseFulfilledResult<designs.DesignRow[]>).value;
  const ownFolders = (folderRead as PromiseFulfilledResult<folders.FolderRow[]>).value;
  const memberRows = (memberRead as PromiseFulfilledResult<designMembers.MemberRow[]>).value;

  const ownRows = memberRows.filter((row) => row.owner_id === me);
  const sharedPairs = memberRows
    .filter((row) => row.member_id === me && row.owner_id !== me)
    .map((row) => ({ ownerId: row.owner_id, designId: row.design_id }));

  // The shared plans themselves, and everyone they are shared with.
  let sharedDesigns: Array<designs.DesignRow & { user_id: string }> = [];
  let sharedMembers: designMembers.MemberRow[] = [];
  if (sharedPairs.length > 0) {
    const [sharedRead, membersRead] = await Promise.allSettled([
      designs.sharedWith(me),
      designMembers.ofDesigns(sharedPairs),
    ]);
    for (const read of [sharedRead, membersRead]) {
      if (read.status === "rejected") {
        return storageFailure(read.reason, "Your plans could not be loaded.");
      }
    }
    sharedDesigns = (sharedRead as PromiseFulfilledResult<typeof sharedDesigns>).value;
    sharedMembers = (membersRead as PromiseFulfilledResult<typeof sharedMembers>).value;
  }

  const names = await usernamesFor([
    ...ownRows.map((row) => row.member_id),
    ...sharedMembers.map((row) => row.member_id),
    ...sharedDesigns.map((row) => row.user_id),
  ]).catch(() => new Map<string, string>());

  const membersByDesign = new Map<string, PlanMember[]>();
  for (const row of [...ownRows, ...sharedMembers]) {
    const username = names.get(row.member_id);
    if (!username) {
      continue;
    }
    const key = pairKey(row.owner_id, row.design_id);
    const list = membersByDesign.get(key) ?? [];
    if (!list.some((member) => member.id === row.member_id)) {
      list.push({ id: row.member_id, username });
    }
    membersByDesign.set(key, list);
  }

  const shared: SharedDesign[] = sharedDesigns.map((row) => ({
    ownerId: row.user_id,
    ownerName: names.get(row.user_id) ?? "",
    id: row.id,
    name: row.name,
    icon: parseEntryIcon(row.icon),
    updatedAt: row.updated_at,
    planUpdatedAt: row.plan_updated_at,
    members: membersByDesign.get(pairKey(row.user_id, row.id)) ?? [],
  }));

  return ok({
    designs: ownDesigns.map((row) => ({
      ...rowToDesignMeta(row),
      members: membersByDesign.get(pairKey(me, row.id)) ?? [],
    })),
    folders: ownFolders.map(rowToFolder),
    shared,
  });
}

export interface DesignWithPlan {
  design: RemoteDesignMeta;
  plan: unknown;
  ownerId: string;
  role: DesignRole;
  seq: number;
  live: boolean;
}

/** The plan itself, for its owner or a member. Throws when the membership check cannot be made. */
export async function readDesign(
  viewer: SignedIn,
  ownerId: string,
  designId: string,
): Promise<ServiceResult<DesignWithPlan>> {
  const role = await designRole(viewer.userId, ownerId, designId);
  if (!role) {
    return fail("not-found", "Design not found.");
  }
  let row: designs.DesignLiveRow | undefined;
  try {
    row = await designs.read(ownerId, designId, { withPlan: true });
  } catch (error) {
    return storageFailure(error, "The design could not be loaded.");
  }
  // A member never sees a tombstone: the plan is gone for them.
  if (!row || (role === "editor" && row.deleted_at)) {
    return fail("not-found", "Design not found.");
  }
  return ok({
    design: rowToDesignMeta(row),
    plan: row.plan,
    ownerId,
    role,
    seq: Number(row.seq ?? 0),
    live: leaseHeld(row.live_lease_until),
  });
}

const LIVE_REFUSAL = "This plan is open live. Its edits go through the live connection.";
const liveRefusal = () => fail("conflict", LIVE_REFUSAL, { body: { live: true } });

/**
 * Upsert. The client owns the timestamps: `updatedAt` moves on any change,
 * `planUpdatedAt` only when the plan did, and the plan rides only then. A
 * row already NEWER than the incoming one (another device wrote since) is
 * left alone and reported back (`behind`), so the client can pull it
 * instead. While the live service holds the plan, a plan body is refused
 * (409, `live: true`); metadata still lands. A member (`ownerId` another's)
 * may save the plan and its name; the owner's folders, order and stars stay
 * theirs.
 *
 * The order of checks: what needs no database, the rate limit (two round
 * trips), the role, the read, behind, the lease, the plan's schema, the
 * cap, the write.
 */
export async function saveDesign(
  viewer: SignedIn,
  ownerId: string,
  designId: string,
  body: Partial<DesignUpsertBody>,
): Promise<ServiceResult<{ design: RemoteDesignMeta; behind: boolean }>> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > LIBRARY_DESIGN_NAME_MAX_LENGTH) {
    return fail("bad-request", "Design names run 1 to 80 characters.");
  }
  if (
    !isIsoTimestamp(body.createdAt) ||
    !isIsoTimestamp(body.updatedAt) ||
    !isIsoTimestamp(body.planUpdatedAt)
  ) {
    return fail("bad-request", "Bad timestamps.");
  }
  // The edit stamps only: `createdAt` is sent unchanged on every push, so a
  // clock that was ahead once would refuse the design forever, and only the
  // owner's own shelf sorts on it, by their own stamp.
  if (isFutureStamp(body.updatedAt) || isFutureStamp(body.planUpdatedAt)) {
    return fail("bad-request", CLOCK_AHEAD_MESSAGE);
  }
  if (body.folderId !== null && body.folderId !== undefined && !isLibraryId(body.folderId)) {
    return fail("bad-request", "Bad folder id.");
  }
  const stamped = {
    ...body,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    planUpdatedAt: body.planUpdatedAt,
  };
  // Autosave pushes a few seconds after edits stop; a busy hour is hundreds,
  // not thousands.
  if (!(await checkRateLimit(`user:${viewer.userId}`, "library-save", 1200, 60 * 60))) {
    return fail("rate-limited", "Saving too fast. Try again later.");
  }

  const isOwner = ownerId === viewer.userId;
  // The member check stays before the transaction: a stranger is refused
  // without ever locking someone else's design row, and inside it would
  // close no window, since a member's removal takes no design lock. A
  // member removed meanwhile lands one last save, ordered before the removal.
  if (!isOwner && !(await designRole(viewer.userId, ownerId, designId))) {
    return fail("not-found", "Design not found.");
  }
  // Checked here, answered in its turn below: the parse is the request's
  // own work and needs no row lock held while it runs.
  const parsed = body.plan === undefined ? undefined : factoryProjectSchema.safeParse(body.plan);

  try {
    return await withTransaction((tx) =>
      writeDesign(tx, { viewer, ownerId, designId, name, stamped, parsed, isOwner }),
    );
  } catch (error) {
    return storageFailure(error, "The design could not be saved.");
  }
}

/**
 * The save's database part, in one transaction: the read locks the row, so
 * an owner's and a member's save cannot both pass the "behind" check; a new
 * design locks the account first, so creations arriving at once meet the
 * cap one at a time. Only `tx` is used in here.
 */
async function writeDesign(
  tx: Tx,
  save: {
    viewer: SignedIn;
    ownerId: string;
    designId: string;
    name: string;
    stamped: Partial<DesignUpsertBody> & {
      createdAt: string;
      updatedAt: string;
      planUpdatedAt: string;
    };
    parsed: ReturnType<typeof factoryProjectSchema.safeParse> | undefined;
    isOwner: boolean;
  },
): Promise<ServiceResult<{ design: RemoteDesignMeta; behind: boolean }>> {
  const { viewer, ownerId, designId, name, stamped, parsed, isOwner } = save;
  const forUpdate = { withPlan: false, forUpdate: true };
  let current = await designs.read(ownerId, designId, forUpdate, tx);
  if (!current && isOwner) {
    // A new design: wait for this account's other creations, then read
    // again, since one of them may have been this same design.
    await lockAccount(viewer.userId, tx);
    current = await designs.read(ownerId, designId, forUpdate, tx);
  }
  if (!isOwner && (!current || current.deleted_at)) {
    return fail("not-found", "Design not found.");
  }

  // Another device wrote later than this one: the caller is behind, and its
  // pull will sort it out. Nothing is overwritten.
  if (current && Date.parse(current.updated_at) > Date.parse(stamped.updatedAt)) {
    return ok({ design: rowToDesignMeta(current), behind: true });
  }

  let plan: unknown;
  if (parsed !== undefined) {
    if (current && leaseHeld(current.live_lease_until)) {
      return liveRefusal();
    }
    if (!parsed.success) {
      return fail("bad-request", "The plan is not valid.");
    }
    plan = parsed.data;
  } else if (!current) {
    return fail("bad-request", "A new design needs its plan.");
  }

  if (!current && (await designs.countLive(viewer.userId, tx)) >= LIBRARY_MAX_DESIGNS) {
    return fail(
      "conflict",
      `Your plans are full (${LIBRARY_MAX_DESIGNS} designs). Delete some first.`,
    );
  }

  if (!current) {
    // An INSERT for a row that does not exist: an upsert forms the insert
    // row first, and a metadata-only save (no plan) would trip the NOT NULL
    // on plan before the conflict was ever checked.
    const inserted = await designs.insert(
      { ...ownerFields(viewer.userId, designId, name, stamped), plan },
      tx,
    );
    return ok({ design: rowToDesignMeta(inserted), behind: false });
  }
  // A plan lands only while no live lease is held (the condition stays on
  // the write, as the live service's own writes keep theirs).
  const opts = { requireLeaseFree: plan !== undefined, now: new Date().toISOString() };
  const written = isOwner
    ? await designs.saveAsOwner(
        ownerId,
        designId,
        {
          ...ownerFields(viewer.userId, designId, name, stamped),
          ...(plan !== undefined ? { plan } : {}),
        },
        opts,
        tx,
      )
    : await designs.saveAsMember(
        ownerId,
        designId,
        {
          name,
          updated_at: stamped.updatedAt,
          plan_updated_at: stamped.planUpdatedAt,
          ...(plan !== undefined ? { plan } : {}),
        },
        opts,
        tx,
      );
  if (!written) {
    return liveRefusal();
  }
  return ok({ design: rowToDesignMeta(written), behind: false });
}

/** The fields the owner's save writes, from the body the checks above passed. */
function ownerFields(
  userId: string,
  designId: string,
  name: string,
  body: Partial<DesignUpsertBody> & { createdAt: string; updatedAt: string; planUpdatedAt: string },
) {
  return {
    user_id: userId,
    id: designId,
    name,
    icon: parseEntryIcon(body.icon),
    folder_id: body.folderId ?? null,
    closed: body.closed === true,
    favorite: body.favorite === true,
    sort_order: Number.isInteger(body.order) ? (body.order as number) : null,
    community_plan_id:
      typeof body.communityPlanId === "string" && body.communityPlanId.length <= 64
        ? body.communityPlanId
        : null,
    created_at: body.createdAt,
    updated_at: body.updatedAt,
    plan_updated_at: body.planUpdatedAt,
    // Writing a design brings it back: a tombstone is only ever older.
    deleted_at: null,
  };
}

/**
 * A tombstone, never a hole: other devices need to hear about it. Only the
 * owner deletes; the plan's members lose it at once (their rows go, and the
 * live service drops them from an open room). A member leaves through
 * `removeMember` instead.
 */
export async function deleteDesign(
  viewer: SignedIn,
  ownerId: string,
  designId: string,
): Promise<ServiceResult<{ ok: true; deletedAt: string }>> {
  if (ownerId !== viewer.userId) {
    return fail("forbidden", "Only the plan's owner can delete it.");
  }
  const now = new Date().toISOString();
  try {
    // One transaction: a design is never deleted with its members left on it.
    await withTransaction(async (tx) => {
      await designs.tombstone(viewer.userId, designId, now, tx);
      await designMembers.deleteOfDesign(viewer.userId, designId, tx);
    });
  } catch (error) {
    return storageFailure(error, "The design could not be deleted.");
  }
  await notifyLive({ kind: "deleted", ownerId: viewer.userId, designId });
  return ok({ ok: true, deletedAt: now });
}

/** Who a plan is shared with: for its owner and its members. Throws when a read fails unexpectedly. */
export async function listDesignMembers(
  viewer: SignedIn,
  ownerId: string,
  designId: string,
): Promise<
  ServiceResult<{ ownerId: string; ownerName: string; role: DesignRole; members: PlanMember[] }>
> {
  const role = await designRole(viewer.userId, ownerId, designId);
  let row: designs.DesignLiveRow | undefined;
  try {
    row = await designs.read(ownerId, designId, { withPlan: false });
  } catch (error) {
    return storageFailure(error, "The plan's members could not be loaded.");
  }
  if (!role || !row || row.deleted_at) {
    return fail("not-found", "Design not found.");
  }
  const [members, owner] = await Promise.all([
    designMembers.list(ownerId, designId),
    usernamesFor([ownerId]),
  ]);
  return ok({ ownerId, ownerName: owner.get(ownerId) ?? "", role, members });
}

/**
 * Every sharing change, by the owner or a leaving member, is limited per
 * account before anything else is checked.
 */
export async function sharingAllowed(viewer: SignedIn): Promise<ServiceResult<void>> {
  if (!(await checkRateLimit(`user:${viewer.userId}`, "library-share", 300, 60 * 60))) {
    return fail("rate-limited", "Sharing too fast. Try again later.");
  }
  return ok(undefined);
}

/** Accounts an owner may add to their plans an hour: share spam goes nowhere fast. */
const SHARE_ADDS_PER_HOUR = 30;

/**
 * Shares the plan with an account (owner only); sharing again changes
 * nothing. The live service hears, so an open room updates.
 */
export async function addMember(
  viewer: SignedIn,
  ownerId: string,
  designId: string,
  userId: string,
): Promise<ServiceResult<{ members: PlanMember[] }>> {
  if (ownerId !== viewer.userId) {
    return fail("forbidden", "Only the plan's owner can share it.");
  }
  if (userId === viewer.userId) {
    return fail("bad-request", "The plan is already yours.");
  }
  let design: designs.DesignLiveRow | undefined;
  try {
    design = await designs.read(ownerId, designId, { withPlan: false });
  } catch (error) {
    return storageFailure(error, "The plan could not be shared.");
  }
  if (!design || design.deleted_at) {
    return fail("not-found", "Design not found.");
  }
  // A failed lookup reads as no such account, as it always has.
  if (!(await accountExists(userId).catch(() => false))) {
    return fail("not-found", "No such account.");
  }
  const before = await designMembers.list(ownerId, designId);
  let added = false;
  // The answer's list is read in the change's own transaction: a read after
  // the commit could fail with the share stored, and answer it as a failure.
  let members = before;
  if (!before.some((member) => member.id === userId)) {
    if (before.length >= LIBRARY_MAX_MEMBERS) {
      return fail("conflict", `A plan can be shared with ${LIBRARY_MAX_MEMBERS} accounts at most.`);
    }
    // Each share shows the plan in someone else's library: an owner adds
    // at most SHARE_ADDS_PER_HOUR a hour, across all their plans.
    if (
      !(await checkRateLimit(`user:${ownerId}`, "library-share-add", SHARE_ADDS_PER_HOUR, 60 * 60))
    ) {
      return fail(
        "rate-limited",
        `You can share with ${SHARE_ADDS_PER_HOUR} people an hour. Try again later.`,
      );
    }
    let outcome: "added" | "already" | "gone" | "full";
    try {
      // The checks above again, in one transaction under the design's row
      // lock, so shares arriving at once meet the cap one at a time.
      ({ outcome, members } = await withTransaction(async (tx) => {
        if (!(await designMembers.lockDesign(ownerId, designId, tx))) {
          return { outcome: "gone" as const, members: before };
        }
        const current = await designMembers.list(ownerId, designId, tx);
        if (current.some((member) => member.id === userId)) {
          return { outcome: "already" as const, members: current };
        }
        if (current.length >= LIBRARY_MAX_MEMBERS) {
          return { outcome: "full" as const, members: current };
        }
        const done = await designMembers.add(ownerId, designId, userId, tx);
        return { outcome: done, members: await designMembers.list(ownerId, designId, tx) };
      }));
    } catch (error) {
      return storageFailure(error, "The plan could not be shared.");
    }
    if (outcome === "gone") {
      return fail("not-found", "Design not found.");
    }
    if (outcome === "full") {
      return fail("conflict", `A plan can be shared with ${LIBRARY_MAX_MEMBERS} accounts at most.`);
    }
    added = outcome === "added";
  }
  await notifyLive({
    kind: "members",
    ownerId,
    designId,
    members,
    ...(added
      ? {
          added: [userId],
          owner: { id: ownerId, username: viewer.username },
          name: String(design.name ?? ""),
        }
      : {}),
  });
  return ok({ members });
}

/** Stops sharing with an account: the owner removing anyone, or a member leaving. */
export async function removeMember(
  viewer: SignedIn,
  ownerId: string,
  designId: string,
  userId: string,
): Promise<ServiceResult<{ members: PlanMember[] }>> {
  if (ownerId !== viewer.userId) {
    const leaving =
      userId === viewer.userId && (await designRole(viewer.userId, ownerId, designId)) === "editor";
    if (!leaving) {
      return fail("forbidden", "Only the plan's owner can change who it is shared with.");
    }
  }
  let members: PlanMember[];
  try {
    // The answer's list in the change's own transaction, as in `addMember`.
    members = await withTransaction(async (tx) => {
      await designMembers.remove(ownerId, designId, userId, tx);
      return designMembers.list(ownerId, designId, tx);
    });
  } catch (error) {
    return storageFailure(error, "Sharing could not be changed.");
  }
  await notifyLive({ kind: "members", ownerId, designId, members, removed: [userId] });
  return ok({ members });
}

/** Folder saves are limited per account before anything else is checked. */
export async function folderSaveAllowed(viewer: SignedIn): Promise<ServiceResult<void>> {
  if (!(await checkRateLimit(`user:${viewer.userId}`, "library-folder", 300, 60 * 60))) {
    return fail("rate-limited", "Saving too fast. Try again later.");
  }
  return ok(undefined);
}

/** Upsert, client timestamps, newer row wins: as `saveDesign`. */
export async function saveFolder(
  viewer: SignedIn,
  folderId: string,
  body: Partial<FolderUpsertBody>,
): Promise<ServiceResult<{ folder: RemoteFolder; behind: boolean }>> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > LIBRARY_FOLDER_NAME_MAX_LENGTH) {
    return fail("bad-request", "Folder names run 1 to 60 characters.");
  }
  if (!isIsoTimestamp(body.createdAt) || !isIsoTimestamp(body.updatedAt)) {
    return fail("bad-request", "Bad timestamps.");
  }
  // The edit stamp only: `createdAt` is sent unchanged on every push (see `saveDesign`).
  if (isFutureStamp(body.updatedAt)) {
    return fail("bad-request", CLOCK_AHEAD_MESSAGE);
  }

  const { createdAt, updatedAt } = body;
  try {
    // One transaction, as `saveDesign`: the read locks the folder, and a new
    // folder locks the account first, so the cap holds against saves at once.
    return await withTransaction(async (tx): Promise<ServiceResult<{ folder: RemoteFolder; behind: boolean }>> => {
      let current = await folders.read(viewer.userId, folderId, { forUpdate: true }, tx);
      if (!current) {
        await lockAccount(viewer.userId, tx);
        current = await folders.read(viewer.userId, folderId, { forUpdate: true }, tx);
      }
      if (current && Date.parse(current.updated_at) > Date.parse(updatedAt)) {
        return ok({ folder: rowToFolder(current), behind: true });
      }
      if (!current && (await folders.countLive(viewer.userId, tx)) >= LIBRARY_MAX_FOLDERS) {
        return fail("conflict", "Too many folders.");
      }
      const saved = await folders.upsert(
        { user_id: viewer.userId, id: folderId, name, created_at: createdAt, updated_at: updatedAt },
        tx,
      );
      return ok({ folder: rowToFolder(saved), behind: false });
    });
  } catch (error) {
    return storageFailure(error, "The folder could not be saved.");
  }
}

/** A folder's tombstone. */
export async function deleteFolder(
  viewer: SignedIn,
  folderId: string,
): Promise<ServiceResult<{ ok: true; deletedAt: string }>> {
  const now = new Date().toISOString();
  try {
    await folders.tombstone(viewer.userId, folderId, now);
  } catch (error) {
    return storageFailure(error, "The folder could not be deleted.");
  }
  return ok({ ok: true, deletedAt: now });
}
