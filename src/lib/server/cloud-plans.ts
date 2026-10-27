import { isAccountId } from "@/lib/live/protocol";

/**
 * Cloud plans: a library design shared with other accounts as editors, and
 * held by the live service while anyone has it open. The request and lease
 * helpers the library routes and service share; the rules are in
 * `services/library.ts`, the queries in `repos/designs.ts` and
 * `repos/design-members.ts`.
 *
 * - A design is addressed by its owner and its id (ids are unique only per
 *   owner): routes take `?owner=<ownerId>`, absent meaning the caller's own.
 * - The owner and the members may read it; members may edit it; only the
 *   owner shares it, and a member may leave.
 * - While `live_lease_until` is in the future the live service is the plan's
 *   only writer: REST refuses a plan body (409 `{ live: true }`).
 */

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
