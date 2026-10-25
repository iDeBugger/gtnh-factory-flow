import type { PlanMember } from "@/lib/library/sync-types";
import { DbQueryError, getCommunityDb, type Tx } from "../db";
import { usernamesFor } from "./accounts";

/**
 * Who a design is shared with: one row per owner, design and member. A
 * design id is unique per owner only, so every read names the owner too.
 */

export interface MemberRow {
  owner_id: string;
  design_id: string;
  member_id: string;
  added_at: string;
}

const db = () => getCommunityDb();

/** Whether `userId` is a member of the owner's design. Throws when the database does not answer. */
export async function isMember(
  userId: string,
  ownerId: string,
  designId: string,
  _tx?: Tx,
): Promise<boolean> {
  const { data, error } = await db()
    .from("library_design_members")
    .select("member_id")
    .eq("owner_id", ownerId)
    .eq("design_id", designId)
    .eq("member_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Membership check failed: ${error.message}`);
  }
  return Boolean(data);
}

/** The accounts a design is shared with, oldest first; a member whose account is gone is left out. */
export async function list(ownerId: string, designId: string, _tx?: Tx): Promise<PlanMember[]> {
  const { data, error } = await db()
    .from("library_design_members")
    .select("member_id,added_at")
    .eq("owner_id", ownerId)
    .eq("design_id", designId)
    .order("added_at", { ascending: true });
  if (error) {
    throw new Error(`Member list failed: ${error.message}`);
  }
  const ids = ((data ?? []) as Array<{ member_id: string }>).map((row) => row.member_id);
  const names = await usernamesFor(ids);
  return ids.filter((id) => names.has(id)).map((id) => ({ id, username: names.get(id)! }));
}

/**
 * Every membership on either side of `userId`, oldest first: the members of
 * their designs and the designs they are a member of. A database without
 * the members table yet answers none. Throws `DbQueryError`.
 */
export async function rowsFor(userId: string, _tx?: Tx): Promise<MemberRow[]> {
  const { data, error } = await db()
    .from("library_design_members")
    .select("owner_id,design_id,member_id,added_at")
    .or(`owner_id.eq.${userId},member_id.eq.${userId}`)
    .order("added_at", { ascending: true });
  if (error?.code === "PGRST205" || error?.code === "42P01") {
    return [];
  }
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? []) as MemberRow[];
}

/** The memberships of exactly these designs, oldest first. Throws `DbQueryError`. */
export async function ofDesigns(
  pairs: ReadonlyArray<{ ownerId: string; designId: string }>,
  _tx?: Tx,
): Promise<MemberRow[]> {
  if (pairs.length === 0) {
    return [];
  }
  const owners = [...new Set(pairs.map((pair) => pair.ownerId))];
  const ids = [...new Set(pairs.map((pair) => pair.designId))];
  const wanted = new Set(pairs.map((pair) => `${pair.ownerId}:${pair.designId}`));
  const { data, error } = await db()
    .from("library_design_members")
    .select("owner_id,design_id,member_id,added_at")
    .in("owner_id", owners)
    .in("design_id", ids)
    .order("added_at", { ascending: true });
  if (error) {
    throw new DbQueryError(error);
  }
  return ((data ?? []) as MemberRow[]).filter((row) =>
    wanted.has(`${row.owner_id}:${row.design_id}`),
  );
}

/** Adds an editor; adding one already there changes nothing. Throws `DbQueryError`. */
export async function add(
  ownerId: string,
  designId: string,
  memberId: string,
  _tx?: Tx,
): Promise<"added" | "already"> {
  const { data, error } = await db()
    .from("library_design_members")
    .upsert(
      { owner_id: ownerId, design_id: designId, member_id: memberId, role: "editor" },
      { onConflict: "owner_id,design_id,member_id", ignoreDuplicates: true },
    )
    .select("member_id");
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? []).length > 0 ? "added" : "already";
}

/** Takes one member off; true when a row went. Throws `DbQueryError`. */
export async function remove(
  ownerId: string,
  designId: string,
  memberId: string,
  _tx?: Tx,
): Promise<boolean> {
  const { count, error } = await db()
    .from("library_design_members")
    .delete({ count: "exact" })
    .eq("owner_id", ownerId)
    .eq("design_id", designId)
    .eq("member_id", memberId);
  if (error) {
    throw new DbQueryError(error);
  }
  return (count ?? 0) > 0;
}

/**
 * Drops every member of a design (designs are tombstoned, so the foreign
 * key's cascade never fires). A failure is not reported: a database without
 * the members table has nobody to drop, and the live service checks
 * membership on every join.
 */
export async function deleteOfDesign(ownerId: string, designId: string, _tx?: Tx): Promise<void> {
  await db()
    .from("library_design_members")
    .delete()
    .eq("owner_id", ownerId)
    .eq("design_id", designId);
}
