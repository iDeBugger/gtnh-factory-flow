import type { DbClient } from "./community";
import { docKey, isAccountId } from "@/lib/live/protocol";
import type { PlanMember } from "@/lib/library/sync-types";
import { fetchWithDbTimeout } from "./community";
import { sameSecret } from "./secret";

// The live service checks its internal token with the same helper.
export { sameSecret };

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

/** Usernames by account id. */
export async function usernamesFor(
  db: DbClient,
  ids: Iterable<string>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  if (unique.length === 0) {
    return names;
  }
  const { data, error } = await db.from("community_users").select("id,username").in("id", unique);
  if (error) {
    throw new Error(`Account lookup failed: ${error.message}`);
  }
  for (const row of (data ?? []) as Array<{ id: string; username: string }>) {
    names.set(row.id, row.username);
  }
  return names;
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

// ---------------------------------------------------------------------------
// Telling the live service


export type LiveNotice =
  | {
      kind: "members";
      ownerId: string;
      designId: string;
      members: PlanMember[];
      /** Accounts just added (they hear `shared`) and just removed (`unshared`). */
      added?: string[];
      removed?: string[];
      owner?: { id: string; username: string };
      name?: string;
    }
  | { kind: "deleted"; ownerId: string; designId: string }
  /** The account signed out everywhere: its open sockets are to close. */
  | { kind: "signed-out"; userId: string };

function noticeBody(notice: LiveNotice): unknown {
  if (notice.kind === "signed-out") {
    return { userId: notice.userId };
  }
  const doc = docKey(notice.ownerId, notice.designId);
  if (notice.kind === "members") {
    return {
      doc,
      members: notice.members,
      added: notice.added,
      removed: notice.removed,
      owner: notice.owner,
      name: notice.name,
    };
  }
  return { doc };
}

/** Waits before each retry of a notice the live service did not take (down, or restarting). */
export const LIVE_NOTICE_RETRY_MS = [1000, 4000, 15_000] as const;

/**
 * Tells the live service that sharing changed, a design went or an account
 * signed out everywhere, so open rooms update and anyone no longer allowed
 * is dropped. Quick: one attempt
 * is awaited; when the service does not take it (no answer, or a 5xx) it is
 * tried again in the background, `retryMs` apart. The change is already in
 * the database, which the service reads again at every lease renewal (30 s),
 * so a notice lost for good is late, never wrong for long. Nothing happens
 * unless LIVE_INTERNAL_URL and LIVE_INTERNAL_TOKEN are set.
 */
export async function notifyLive(
  notice: LiveNotice,
  retryMs: readonly number[] = LIVE_NOTICE_RETRY_MS,
): Promise<boolean> {
  const base = process.env.LIVE_INTERNAL_URL?.replace(/\/+$/, "");
  const token = process.env.LIVE_INTERNAL_TOKEN;
  if (!base || !token) {
    return false;
  }
  const body = JSON.stringify(noticeBody(notice));
  const send = async (): Promise<"taken" | "refused" | "again"> => {
    try {
      const response = await fetchWithDbTimeout(
        `${base}/internal/${notice.kind}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body,
        },
        3000,
      );
      return response.ok ? "taken" : response.status >= 500 ? "again" : "refused";
    } catch {
      return "again";
    }
  };
  const first = await send();
  if (first !== "again") {
    return first === "taken";
  }
  void (async () => {
    for (const wait of retryMs) {
      await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
      if ((await send()) !== "again") {
        return;
      }
    }
  })();
  return false;
}
