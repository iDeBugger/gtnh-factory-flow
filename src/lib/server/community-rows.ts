import { entryIconSchema } from "@/lib/model/schemas";
import type { CommunityPlanSummary, EntryIcon, PlanResourceStat } from "@/lib/community/types";
import { getCommunityDb } from "./db";

/**
 * Anonymous votes one address may cast or switch on one post (or blueprint)
 * in a day. The anonymous voter key is the browser's device id, which a
 * script can make up freely, so without this one address casts a vote per
 * made-up id. Accounts are keyed by account and exempt: a household behind
 * one address can each vote signed in.
 */
export const VOTES_PER_ADDRESS_PER_PLAN_PER_DAY = 3;
/** What the next anonymous voter behind that address is told: a shared network, not haste. */
export const NETWORK_VOTES_SPENT = "Too many votes from this network today. Sign in to vote.";

/**
 * The one item face an author picks for a shared entry. Client-supplied but
 * harmless: it only ever renders as an icon. Anything that doesn't parse
 * becomes "no icon", never a rejection. The schema lives with the model; this
 * is the server's lenient reading.
 */
export function parseEntryIcon(value: unknown): EntryIcon | null {
  const parsed = entryIconSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The columns before the activity trio: what a database not yet migrated can answer. */
export const PLAN_SUMMARY_COLUMNS_LEGACY =
  "id,name,description,game_version,dataset_version,tags,is_public,icon,needs,outputs," +
  "total_eu_t,machine_count,node_count,storage_count,edge_count,highest_tier," +
  "highest_tier_index,upvotes,downvotes,score,downloads,views,created_at,updated_at," +
  "user_id,author_name";
/** The activity columns, which a later migration added; a sort on one needs them. */
export const PLAN_ACTIVITY_COLUMNS = new Set(["comment_count", "last_comment_at", "last_activity_at"]);

/** Columns returned for plan listings (everything except the plan JSON). */
export const PLAN_SUMMARY_COLUMNS =
  "id,name,description,game_version,dataset_version,tags,is_public,icon,needs,outputs," +
  "total_eu_t,machine_count,node_count,storage_count,edge_count,highest_tier," +
  "highest_tier_index,upvotes,downvotes,score,downloads,views,created_at,updated_at," +
  "user_id,author_name,comment_count,last_comment_at,last_activity_at";

export interface PlanRow {
  id: string;
  name: string;
  description: string;
  game_version: string;
  dataset_version: string;
  tags: string[] | null;
  is_public: boolean | null;
  icon: EntryIcon | null;
  needs: PlanResourceStat[];
  outputs: PlanResourceStat[];
  total_eu_t: number;
  machine_count: number;
  node_count: number;
  storage_count: number;
  edge_count: number;
  highest_tier: string | null;
  highest_tier_index: number;
  upvotes: number;
  downvotes: number;
  score: number;
  downloads: number;
  views: number;
  created_at: string;
  updated_at: string | null;
  user_id: string | null;
  author_name: string;
  comment_count: number | null;
  last_comment_at: string | null;
  last_activity_at: string | null;
}

export function rowToPlanSummary(row: PlanRow, sessionUserId?: string): CommunityPlanSummary {
  return {
    authorName: row.author_name || undefined,
    isMine: Boolean(sessionUserId && row.user_id === sessionUserId),
    id: row.id,
    name: row.name,
    description: row.description,
    gameVersion: row.game_version,
    datasetVersionId: row.dataset_version,
    tags: row.tags ?? [],
    isPublic: row.is_public ?? true,
    icon: row.icon ?? undefined,
    needs: row.needs ?? [],
    outputs: row.outputs ?? [],
    totalEuT: row.total_eu_t,
    machineCount: row.machine_count,
    nodeCount: row.node_count,
    storageCount: row.storage_count,
    edgeCount: row.edge_count,
    highestTier: (row.highest_tier ?? undefined) as CommunityPlanSummary["highestTier"],
    highestTierIndex: row.highest_tier_index,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    score: row.score,
    downloads: row.downloads,
    views: row.views,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    commentCount: row.comment_count ?? 0,
    lastCommentAt: row.last_comment_at ?? undefined,
    lastActivityAt: row.last_activity_at ?? undefined,
  };
}

/**
 * Every vote one voter key has cast on posts, by post id; none when the read
 * fails. The list reads them all at once and keeps them a minute, since a
 * voter's votes change only when they vote, which empties the cache.
 */
export async function readPlanVotesByVoter(voterKey: string): Promise<Map<string, 1 | -1>> {
  const { data } = await getCommunityDb()
    .from("community_votes")
    .select("plan_id,value")
    .eq("voter_key", voterKey)
    .returns<Array<{ plan_id: string; value: 1 | -1 }>>();
  return new Map((data ?? []).map((vote) => [vote.plan_id, vote.value]));
}

export async function attachMyVotes(
  plans: CommunityPlanSummary[],
  actorKey: string,
): Promise<void> {
  if (plans.length === 0) {
    return;
  }

  const db = getCommunityDb();
  const { data, error } = await db
    .from("community_votes")
    .select("plan_id,value")
    .eq("voter_key", actorKey)
    .in(
      "plan_id",
      plans.map((plan) => plan.id),
    );

  if (error || !data) {
    return;
  }

  const votesByPlan = new Map(data.map((vote) => [vote.plan_id as string, vote.value as 1 | -1]));
  for (const plan of plans) {
    plan.myVote = votesByPlan.get(plan.id);
  }
}
