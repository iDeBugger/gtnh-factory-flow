import type { DbClient } from "./db";
import { isAccountId } from "@/lib/live/protocol";
import type { PlanMember } from "@/lib/library/sync-types";
import * as accounts from "./repos/accounts";

/**
 * Cloud plans: a library design shared with other accounts as editors, and
 * held by the live service while anyone has it open. Shared by the library
 * routes and the live service.
 *
 * - A design is addressed by its owner and its id (ids are unique only per
 *   owner): routes take `?owner=<ownerId>`, absent meaning the caller's own.
 * - The owner and the members may read it; members may edit it; only the
 *   owner shares it, and a member may leave.
 * - While `live_lease_until` is in the future the live service is the plan's
 *   only writer: REST refuses a plan body (409 `{ live: true }`).
 */

export type DesignRole = "owner" | "editor";

/** The design a request is about: `?owner=` or the caller's own. Undefined when `owner` is malformed. */
export function requestedOwner(request: Request, sessionUserId: string): string | undefined {
  const owner = new URL(request.url).searchParams.get("owner");
  if (owner === null || owner === "") {
    return sessionUserId;
  }
  return isAccountId(owner) ? owner.toLowerCase() : undefined;
}

/** True while the live service holds the plan. */
export function leaseHeld(until: string | null | undefined, now = Date.now()): boolean {
  return typeof until === "string" && Date.parse(until) > now;
}

/**
 * What `userId` may do with the design: "owner", "editor" (a member of a live
 * design), or null (nothing, or no such design). A tombstoned design has no
 * members.
 */
export async function designRole(
  db: DbClient,
  userId: string,
  ownerId: string,
  designId: string,
): Promise<DesignRole | null> {
  if (userId === ownerId) {
    return "owner";
  }
  const { data, error } = await db
    .from("library_design_members")
    .select("member_id")
    .eq("owner_id", ownerId)
    .eq("design_id", designId)
    .eq("member_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Membership check failed: ${error.message}`);
  }
  return data ? "editor" : null;
}

/** Usernames by account id (`repos/accounts`; the client argument goes with Task 4's move). */
export function usernamesFor(_db: DbClient, ids: Iterable<string>): Promise<Map<string, string>> {
  return accounts.usernamesFor(ids);
}

/** The accounts a design is shared with, oldest first. */
export async function listMembers(
  db: DbClient,
  ownerId: string,
  designId: string,
): Promise<PlanMember[]> {
  const { data, error } = await db
    .from("library_design_members")
    .select("member_id,added_at")
    .eq("owner_id", ownerId)
    .eq("design_id", designId)
    .order("added_at", { ascending: true });
  if (error) {
    throw new Error(`Member list failed: ${error.message}`);
  }
  const ids = ((data ?? []) as Array<{ member_id: string }>).map((row) => row.member_id);
  const names = await usernamesFor(db, ids);
  return ids.filter((id) => names.has(id)).map((id) => ({ id, username: names.get(id)! }));
}
