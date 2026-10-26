import type { CommunityVoteResponse } from "@/lib/community/types";
import { makeActorKey, makeVoterKey, saltedKey } from "../auth/keys";
import { withTransaction } from "../db";
import { clientAddress } from "../http/client-address";
import type { Viewer } from "../http/viewer";
import { checkRateLimit } from "../limits/rate-limit";
import { invalidatePlanListCache } from "../plan-list-cache";
import * as plans from "../repos/plans";
import * as votes from "../repos/votes";
import type { VoteTarget } from "../repos/votes";
import { canSeePlan, isUuid } from "./access";
import { fail, ok, type ServiceResult } from "./result";

export type { VoteTarget } from "../repos/votes";

/**
 * Anonymous votes one address may cast or switch on one post in a day. The
 * anonymous voter key is the browser's device id, which a script can make up
 * freely, so without this one address casts a vote per made-up id. Accounts
 * are keyed by account and exempt: a household behind one address can each
 * vote signed in.
 */
export const VOTES_PER_ADDRESS_PER_PLAN_PER_DAY = 3;
/** What the next anonymous voter behind that address is told: a shared network, not haste. */
export const NETWORK_VOTES_SPENT = "Too many votes from this network today. Sign in to vote.";

/** A vote as the route read it from the body. */
export interface VoteInput {
  deviceId: string;
  value: 1 | -1;
}

/** The body's vote: a device id (cut to 64 characters) and an up or down value, else "Invalid vote.". */
export function parseVoteInput(body: unknown): ServiceResult<VoteInput> {
  const sent = (body ?? {}) as { deviceId?: unknown; value?: unknown };
  const deviceId = typeof sent.deviceId === "string" ? sent.deviceId.slice(0, 64) : "";
  const value = sent.value === 1 || sent.value === -1 ? sent.value : undefined;
  if (!deviceId || value === undefined) {
    return fail("bad-request", "Invalid vote.");
  }
  return ok({ deviceId, value });
}

/** What a vote's target decides; the algorithm is the same for every target. */
interface TargetRules {
  /** The action the address's pace (60 votes in 10 minutes) is counted under. */
  paceAction: string;
  notFound: string;
  /**
   * Whether the row exists and this viewer may score it. A row the viewer may
   * not vote on reads as missing; a failed read throws to the route, which
   * logs it and answers its sentence.
   */
  mayVote(viewer: Viewer, id: string): Promise<boolean>;
  /** What else a counted vote changes. */
  afterVote(): void;
}

const RULES: Record<VoteTarget, TargetRules> = {
  // A post must be one the voter may see (`canSeePlan`): an unpublished post
  // is nobody else's to score.
  plan: {
    paceAction: "vote",
    notFound: "Plan not found.",
    async mayVote(viewer, id) {
      const row = await plans.readAccess(id);
      return Boolean(row && canSeePlan(viewer, row));
    },
    // The list's cached pages and the voter's cached votes are stale now.
    afterVote: invalidatePlanListCache,
  },
};

/**
 * Casts, switches, or (when the voter sends the vote they already hold)
 * retracts a vote on a post. Votes are keyed by account or
 * device id (`makeVoterKey`); the address only feeds the limits. In order:
 * a malformed id is a missing row, answered with no query; then the
 * address's pace; then the row, which must exist and be one the viewer may
 * vote on, with the same answer either way so the route is no oracle for
 * ids; then an
 * anonymous cast or switch counts against the address's few a day on that
 * row (a retraction does not); then the write and a recount. A failed read or
 * write throws, for the route's fixed sentence.
 */
export async function castVote(
  target: VoteTarget,
  id: string,
  viewer: Viewer,
  input: VoteInput,
  request: Request,
): Promise<ServiceResult<CommunityVoteResponse>> {
  const rules = RULES[target];
  // Before the pace: a malformed id sends no query at all, as for a view or a comment.
  if (!isUuid(id)) {
    return fail("not-found", rules.notFound);
  }
  // Then the pace, so probing well-formed ids stays limited.
  if (!(await checkRateLimit(makeActorKey(request), rules.paceAction, 60, 60 * 10))) {
    return fail("rate-limited", "Voting too fast. Slow down.");
  }
  if (!(await rules.mayVote(viewer, id))) {
    return fail("not-found", rules.notFound);
  }

  const voterKey = await makeVoterKey(request, input.deviceId);
  const existing = await votes.read(target, id, voterKey);
  const retracting = existing === input.value;
  if (!viewer.userId && !retracting) {
    const perTarget = `votes:address:${saltedKey(clientAddress(request))}:${id}`;
    if (!(await checkRateLimit(perTarget, "vote-cast", VOTES_PER_ADDRESS_PER_PLAN_PER_DAY, 24 * 60 * 60))) {
      return fail("rate-limited", NETWORK_VOTES_SPENT);
    }
  }

  // The row's lock, the vote and the recount are one transaction: the votes
  // on one row land one at a time, each recount counting every vote before
  // it, and a vote never stands without its count.
  const counted = await withTransaction(async (tx) => {
    if (!(await votes.lockParent(target, id, tx))) {
      return undefined;
    }
    if (retracting) {
      await votes.remove(target, id, voterKey, tx);
    } else {
      await votes.upsert(target, id, voterKey, input.value, tx);
    }
    return votes.recount(target, id, tx);
  });
  // Taken down since the access read.
  if (!counted) {
    return fail("not-found", rules.notFound);
  }
  rules.afterVote();
  const { upvotes, downvotes } = counted;
  return ok({ upvotes, downvotes, score: upvotes - downvotes, myVote: retracting ? undefined : input.value });
}

/** The voter's votes on every row of the target, by id; none when the read fails. */
export async function readMyVotes(target: VoteTarget, voterKey: string): Promise<Map<string, 1 | -1>> {
  try {
    return await votes.byVoter(target, voterKey);
  } catch {
    return new Map();
  }
}

/** Marks each item with the voter's own vote, so its arrows render already lit; a failed read marks none. */
export async function attachMyVotes(
  target: VoteTarget,
  items: Array<{ id: string; myVote?: 1 | -1 }>,
  voterKey: string,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  let mine: Map<string, 1 | -1>;
  try {
    mine = await votes.byVoter(
      target,
      voterKey,
      items.map((item) => item.id),
    );
  } catch {
    return;
  }
  for (const item of items) {
    item.myVote = mine.get(item.id);
  }
}
