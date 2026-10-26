import { entryIconSchema } from "@/lib/model/schemas";
import type { CommunityPlanSummary, EntryIcon, PlanResourceStat } from "@/lib/community/types";

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

/** The columns a listing reads: everything but the plan JSON. */
export const PLAN_SUMMARY_FIELDS = [
  "id",
  "name",
  "description",
  "game_version",
  "dataset_version",
  "tags",
  "is_public",
  "icon",
  "needs",
  "outputs",
  "total_eu_t",
  "machine_count",
  "node_count",
  "storage_count",
  "edge_count",
  "highest_tier",
  "highest_tier_index",
  "upvotes",
  "downvotes",
  "score",
  "downloads",
  "views",
  "created_at",
  "updated_at",
  "user_id",
  "author_name",
  "comment_count",
  "last_comment_at",
  "last_activity_at",
] as const;

/** The same columns as a PostgREST select list. */
export const PLAN_SUMMARY_COLUMNS = PLAN_SUMMARY_FIELDS.join(",");

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
