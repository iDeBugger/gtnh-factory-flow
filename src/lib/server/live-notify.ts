import { docKey } from "@/lib/live/protocol";
import type { PlanMember } from "@/lib/library/sync-types";

/**
 * The site's notices to the live service over its internal API: sharing
 * changes, deleted designs, sign-outs everywhere. No queries here, so
 * services and routes can send one without loading a query module.
 */

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

/** How long one notice may take before it counts as not taken. */
const NOTICE_TIMEOUT_MS = 3000;

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
      // A service that never answers costs 3 s, then counts as not taken.
      const response = await fetch(`${base}/internal/${notice.kind}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
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
