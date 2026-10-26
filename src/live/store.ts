import type { LiveMember } from "@/lib/live/protocol";
import { forgetSessionUser, loadSessionUser } from "@/lib/server/auth/sessions";
import { usernamesFor } from "@/lib/server/repos/accounts";
import * as designMembers from "@/lib/server/repos/design-members";
import * as designs from "@/lib/server/repos/designs";
import type { LeaseOutcome } from "@/lib/server/repos/designs";
import { designRole, type DesignRole } from "@/lib/server/services/design-role";
import type { LivePlan } from "@/lib/live/ops";

/**
 * The live service's reads and writes: an adapter over the site's
 * repositories, so the lease has one writer (`repos/designs.ts`) for the
 * live service and the REST save. Never a write per edit: a room writes when
 * it opens (the lease), every 30 s (the lease again), and when it flushes (at
 * most every 8 s while edited).
 *
 * A lease is a token as well as a time: taking one writes a fresh random
 * token, and every later renewal, flush and release is conditional on it. A
 * room whose lease is no longer its own (another took it, or it lapsed and a
 * REST save cleared it) hears "lost" and stops writing.
 */

export type { LeaseOutcome };

export interface PlanStore {
  /**
   * The account behind a verified session, or undefined when it is gone; throws when the database does not
   * answer. `epoch` is the account's session epoch: a token made under another value is refused.
   */
  account(userId: string): Promise<{ id: string; username: string; epoch: number } | undefined>;
  /** Forget what `account` cached about an account, so the next lookup reads its row. */
  forgetAccount(userId: string): void;
  /** What the account may do with the design: "owner", "editor" or null. */
  role(userId: string, ownerId: string, designId: string): Promise<DesignRole | null>;
  /**
   * The plan's stored size in bytes (the `plan_bytes` column), so a room can
   * be budgeted before the plan is read; undefined when the design is missing
   * or deleted. Throws when the database does not answer.
   */
  size(ownerId: string, designId: string): Promise<number | undefined>;
  /**
   * Takes the lease with `token` whoever held it (one live service per
   * database) and reads the plan. Undefined when the design is missing or deleted.
   */
  lease(
    ownerId: string,
    designId: string,
    token: string,
    until: Date,
  ): Promise<{ plan: LivePlan; seq: number } | undefined>;
  /** Extends the lease, while it is `token`'s. */
  renew(ownerId: string, designId: string, token: string, until: Date): Promise<LeaseOutcome>;
  /**
   * Writes the plan and its seq while the lease is `token`'s, extending it
   * (or ending it: `until` null).
   */
  flush(
    ownerId: string,
    designId: string,
    token: string,
    plan: LivePlan,
    seq: number,
    until: Date | null,
  ): Promise<LeaseOutcome>;
  /** Ends the lease without writing the plan, when it is still `token`'s. */
  release(ownerId: string, designId: string, token: string): Promise<void>;
  /** The accounts the design is shared with. */
  members(ownerId: string, designId: string): Promise<LiveMember[]>;
  usernames(ids: string[]): Promise<Map<string, string>>;
}

export function databasePlanStore(): PlanStore {
  return {
    async account(userId) {
      const user = await loadSessionUser(userId);
      return user ? { id: user.id, username: user.username, epoch: user.session_epoch } : undefined;
    },
    forgetAccount: forgetSessionUser,
    role: (userId, ownerId, designId) => designRole(userId, ownerId, designId),
    size: (ownerId, designId) => designs.planBytes(ownerId, designId),
    lease: (ownerId, designId, token, until) => designs.takeLease(ownerId, designId, token, until),
    renew: (ownerId, designId, token, until) => designs.renewLease(ownerId, designId, token, until),
    flush: (ownerId, designId, token, plan, seq, until) =>
      designs.flushPlan(ownerId, designId, token, plan, seq, until, new Date().toISOString()),
    release: (ownerId, designId, token) => designs.releaseLease(ownerId, designId, token),
    members: (ownerId, designId) => designMembers.list(ownerId, designId),
    usernames: (ids) => usernamesFor(ids),
  };
}
