import type { PlanMember } from "@/lib/library/sync-types";
import { getDb, type Tx } from "../db";
import { sqlRules } from "./visibility";

/**
 * Who a design is shared with: one row per owner, design and member. A
 * design id is unique per owner only, so every read names the owner too.
 * Repositories take an optional transaction last; a failure throws (a down
 * database as `DatabaseDownError`).
 */

export interface MemberRow {
  owner_id: string;
  design_id: string;
  member_id: string;
  added_at: string;
}

const MEMBER_COLUMNS = ["owner_id", "design_id", "member_id", "added_at"] as const;

/** Whether `userId` is a member of the owner's design. */
export async function isMember(
  userId: string,
  ownerId: string,
  designId: string,
  tx?: Tx,
): Promise<boolean> {
  const row = await (tx ?? getDb())
    .selectFrom("library_design_members")
    .select("member_id")
    .where("owner_id", "=", ownerId)
    .where("design_id", "=", designId)
    .where("member_id", "=", userId)
    .executeTakeFirst();
  return row !== undefined;
}

/** The accounts a design is shared with, oldest first; a member whose account is gone is left out. */
export async function list(ownerId: string, designId: string, tx?: Tx): Promise<PlanMember[]> {
  return (tx ?? getDb())
    .selectFrom("library_design_members")
    .innerJoin("community_users", "community_users.id", "library_design_members.member_id")
    .select(["community_users.id", "community_users.username"])
    .where("library_design_members.owner_id", "=", ownerId)
    .where("library_design_members.design_id", "=", designId)
    .orderBy("library_design_members.added_at", "asc")
    .execute();
}

/**
 * Every membership on either side of `userId`, oldest first: the members of
 * their designs and the designs they are a member of.
 */
export async function rowsFor(userId: string, tx?: Tx): Promise<MemberRow[]> {
  return (tx ?? getDb())
    .selectFrom("library_design_members")
    .select(MEMBER_COLUMNS)
    .where((eb) => eb.or([eb("owner_id", "=", userId), eb("member_id", "=", userId)]))
    .orderBy("added_at", "asc")
    .execute();
}

/** The memberships of exactly these designs, oldest first. */
export async function ofDesigns(
  pairs: ReadonlyArray<{ ownerId: string; designId: string }>,
  tx?: Tx,
): Promise<MemberRow[]> {
  if (pairs.length === 0) {
    return [];
  }
  return (tx ?? getDb())
    .selectFrom("library_design_members")
    .select(MEMBER_COLUMNS)
    .where((eb) =>
      eb(
        eb.refTuple("owner_id", "design_id"),
        "in",
        pairs.map((pair) => eb.tuple(pair.ownerId, pair.designId)),
      ),
    )
    .orderBy("added_at", "asc")
    .execute();
}

/**
 * Locks the design's row until the transaction ends, so the member count a
 * share checks cannot change before its insert. False when the design is
 * missing or deleted.
 */
export async function lockDesign(ownerId: string, designId: string, tx: Tx): Promise<boolean> {
  const row = await tx
    .selectFrom("library_designs")
    .select("id")
    .where(sqlRules.designKey(ownerId, designId))
    .where(sqlRules.notTombstoned())
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}

/** Adds an editor; adding one already there changes nothing. */
export async function add(
  ownerId: string,
  designId: string,
  memberId: string,
  tx?: Tx,
): Promise<"added" | "already"> {
  const row = await (tx ?? getDb())
    .insertInto("library_design_members")
    .values({ owner_id: ownerId, design_id: designId, member_id: memberId, role: "editor" })
    .onConflict((oc) => oc.columns(["owner_id", "design_id", "member_id"]).doNothing())
    .returning("member_id")
    .executeTakeFirst();
  return row ? "added" : "already";
}

/** Takes one member off; true when a row went. */
export async function remove(
  ownerId: string,
  designId: string,
  memberId: string,
  tx?: Tx,
): Promise<boolean> {
  const result = await (tx ?? getDb())
    .deleteFrom("library_design_members")
    .where("owner_id", "=", ownerId)
    .where("design_id", "=", designId)
    .where("member_id", "=", memberId)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/**
 * Drops every member of a design (designs are tombstoned, so the foreign
 * key's cascade never fires). The delete runs in the tombstone's
 * transaction, so a design is never deleted with its members left behind.
 */
export async function deleteOfDesign(ownerId: string, designId: string, tx?: Tx): Promise<void> {
  await (tx ?? getDb())
    .deleteFrom("library_design_members")
    .where("owner_id", "=", ownerId)
    .where("design_id", "=", designId)
    .execute();
}
