import { applyPlanSearch, type PlanSearch } from "@/lib/community/search-query";
import type { EntryIcon, PlanResourceStat } from "@/lib/community/types";
import {
  communityStorageErrorMessage,
  getCommunityDb,
  isMissingColumnError,
  type Tx,
} from "../db";
import {
  PLAN_ACTIVITY_COLUMNS,
  PLAN_SUMMARY_COLUMNS,
  PLAN_SUMMARY_COLUMNS_LEGACY,
  type PlanRow,
} from "../community-rows";
import { publicPlans } from "./visibility";

/**
 * Community posts (`community_plans`). Who may see or change a post is the
 * services' rule (`services/access.ts`); these only read and write rows.
 * Repositories take an optional transaction last; until the direct client
 * lands there is none and `tx` is unused.
 */

/** The columns a list may sort on: a closed set, so no request text names a column. */
export type PlanSortColumn =
  | "created_at"
  | "score"
  | "downloads"
  | "views"
  | "machine_count"
  | "node_count"
  | "total_eu_t"
  | "highest_tier_index"
  | "comment_count"
  | "last_comment_at"
  | "last_activity_at";

/** One resource a post must make or take, matched on these keys inside the stat arrays. */
export interface PlanResourceKey {
  kind: string;
  resourceId: string;
}

export interface PlanListQuery {
  search: PlanSearch;
  maxTierIndex?: number;
  gameVersion?: string;
  maxEuT?: number;
  makes: PlanResourceKey[];
  takes: PlanResourceKey[];
  /** The public shelf, or one account's own posts, published or not. */
  shelf: { kind: "public" } | { kind: "mine"; userId: string };
  sort: { column: PlanSortColumn; ascending: boolean; nullsLast: boolean };
  offset: number;
  limit: number;
}

/**
 * One page of posts and the count of every post the query matches, however
 * far past the end the page is. A database still without the activity
 * columns answers with the old ones, and a sort that needs them falls back
 * to newest first, so the list never blanks between a deploy and the schema
 * paste. Throws when the database does not answer.
 */
export async function list(
  query: PlanListQuery,
  _tx?: Tx,
): Promise<{ rows: PlanRow[]; total: number }> {
  const db = getCommunityDb();
  const { column, ascending, nullsLast } = query.sort;
  const load = async (legacy: boolean): Promise<{ rows: PlanRow[]; total: number }> => {
    const orderColumn = legacy && PLAN_ACTIVITY_COLUMNS.has(column) ? "created_at" : column;
    let builder = db
      .from("community_plans")
      .select(legacy ? PLAN_SUMMARY_COLUMNS_LEGACY : PLAN_SUMMARY_COLUMNS, { count: "exact" });
    builder = applyPlanSearch(builder, query.search);
    if (query.maxTierIndex !== undefined) {
      builder = builder.lte("highest_tier_index", query.maxTierIndex);
    }
    if (query.gameVersion) {
      builder = builder.eq("game_version", query.gameVersion);
    }
    if (query.maxEuT !== undefined) {
      builder = builder.lte("total_eu_t", query.maxEuT);
    }
    // JSON containment: the stat arrays hold {kind, resourceId, ...} and
    // @> matches on the keys given, so the rate is free to differ.
    for (const resource of query.makes) {
      builder = builder.contains("outputs", JSON.stringify([resource]));
    }
    for (const resource of query.takes) {
      builder = builder.contains("needs", JSON.stringify([resource]));
    }
    builder = query.shelf.kind === "mine" ? builder.eq("user_id", query.shelf.userId) : publicPlans(builder);
    const { data, count, error } = await builder
      .order(orderColumn, { ascending, nullsFirst: nullsLast ? false : undefined })
      .order("created_at", { ascending: false })
      .range(query.offset, query.offset + query.limit - 1)
      .returns<PlanRow[]>();
    if (error && !legacy && isMissingColumnError(error)) {
      return load(true);
    }
    if (error) {
      throw new Error(communityStorageErrorMessage(error, "Listing community plans failed."));
    }
    return { rows: data ?? [], total: count ?? data?.length ?? 0 };
  };
  return load(false);
}

/** The game versions posts carry, newest first, for the filter; none when the read fails. */
export async function distinctGameVersions(_tx?: Tx): Promise<string[]> {
  const { data } = await getCommunityDb()
    .from("community_plans")
    .select("game_version")
    .limit(1000)
    .returns<Array<{ game_version: string }>>();
  return [...new Set((data ?? []).map((row) => row.game_version).filter(Boolean))].sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
}

/**
 * A post's summary row, published or not (the caller decides who sees it),
 * or undefined when there is none. A failed read answers undefined too: every
 * caller answers it as a missing post. Old databases answer without the
 * activity columns.
 */
export async function readSummary(planId: string, _tx?: Tx): Promise<PlanRow | undefined> {
  const db = getCommunityDb();
  let { data, error } = await db
    .from("community_plans")
    .select(PLAN_SUMMARY_COLUMNS)
    .eq("id", planId)
    .single<PlanRow>();
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await db
      .from("community_plans")
      .select(PLAN_SUMMARY_COLUMNS_LEGACY)
      .eq("id", planId)
      .single<PlanRow>());
  }
  return error || !data ? undefined : data;
}

/** Who owns a post and whether it is published, for the access rule. Throws when the database does not answer. */
export async function readAccess(
  planId: string,
  _tx?: Tx,
): Promise<{ id: string; user_id: string | null; is_public: boolean } | undefined> {
  const { data, error } = await getCommunityDb()
    .from("community_plans")
    .select("id,user_id,is_public")
    .eq("id", planId)
    .maybeSingle<{ id: string; user_id: string | null; is_public: boolean }>();
  if (error) {
    throw new Error(error.message || "Reading the post failed.", { cause: error });
  }
  return data ?? undefined;
}

/** A post's owner, or undefined when there is none; a failed read answers undefined too, as a missing post. */
export async function readOwner(
  planId: string,
  _tx?: Tx,
): Promise<{ id: string; user_id: string | null } | undefined> {
  const { data } = await getCommunityDb()
    .from("community_plans")
    .select("id,user_id")
    .eq("id", planId)
    .single<{ id: string; user_id: string | null }>();
  return data ?? undefined;
}

/** The stat columns a post stores, computed by the server from its plan. */
export interface PlanStatsColumns {
  needs: PlanResourceStat[];
  outputs: PlanResourceStat[];
  total_eu_t: number;
  machine_count: number;
  node_count: number;
  storage_count: number;
  edge_count: number;
  highest_tier: string | null;
  highest_tier_index: number;
}

export interface NewPlanRow extends PlanStatsColumns {
  user_id: string;
  author_name: string;
  name: string;
  description: string;
  game_version: string;
  dataset_version: string;
  plan: unknown;
  tags: string[];
  tags_text: string;
  icon: EntryIcon | null;
  stats_version: string;
  uploader_key: string;
}

/**
 * Stores a new post and answers its id. A database still without the
 * activity column takes the post without it. Throws when the insert fails.
 */
export async function insert(row: NewPlanRow, _tx?: Tx): Promise<string> {
  const db = getCommunityDb();
  let { data, error } = await db
    .from("community_plans")
    .insert({ ...row, last_activity_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await db.from("community_plans").insert(row).select("id").single());
  }
  if (error || !data) {
    throw new Error(communityStorageErrorMessage(error, "Insert failed"));
  }
  return (data as { id: string }).id;
}

/**
 * Writes the fields of `patch` to the owner's post. A database still without
 * the activity column takes the edit without it. Throws when the update
 * fails; answers whether a row was there to change.
 */
export async function update(
  planId: string,
  ownerId: string,
  patch: Record<string, unknown>,
  _tx?: Tx,
): Promise<boolean> {
  const db = getCommunityDb();
  const write = (fields: Record<string, unknown>) =>
    db.from("community_plans").update(fields).eq("id", planId).eq("user_id", ownerId).select("id");
  let { data, error } = await write(patch);
  if (error && isMissingColumnError(error) && "last_activity_at" in patch) {
    const { last_activity_at: dropped, ...rest } = patch;
    void dropped;
    ({ data, error } = await write(rest));
  }
  if (error) {
    throw new Error(communityStorageErrorMessage(error, "Updating the plan failed."));
  }
  return (data ?? []).length > 0;
}

/** Deletes a post (its comments and votes go with it). Throws when the delete fails. */
export async function remove(planId: string, _tx?: Tx): Promise<void> {
  const { error } = await getCommunityDb().from("community_plans").delete().eq("id", planId);
  if (error) {
    throw new Error(error.message);
  }
}

/** The release a post's stat card was computed by; undefined when the read fails. */
export async function readStatsVersion(planId: string, _tx?: Tx): Promise<string | null | undefined> {
  const { data, error } = await getCommunityDb()
    .from("community_plans")
    .select("stats_version")
    .eq("id", planId)
    .single<{ stats_version: string | null }>();
  return error || !data ? undefined : data.stats_version;
}

/** A post's stored plan JSON; undefined when the read fails. */
export async function readPlanJson(planId: string, _tx?: Tx): Promise<unknown> {
  const { data } = await getCommunityDb()
    .from("community_plans")
    .select("plan")
    .eq("id", planId)
    .single<{ plan: unknown }>();
  return data?.plan;
}

/** Stores a recomputed stat card. Not an author edit: `updated_at` stays. Best effort: a failure is not reported. */
export async function writeStats(
  planId: string,
  stats: PlanStatsColumns,
  version: string,
  _tx?: Tx,
): Promise<void> {
  await getCommunityDb()
    .from("community_plans")
    .update({ ...stats, stats_version: version })
    .eq("id", planId);
}

/** A post's view count and access fields. Throws when the database does not answer. */
export async function readViews(
  planId: string,
  _tx?: Tx,
): Promise<{ views: number; is_public: boolean | null; user_id: string | null } | undefined> {
  const { data, error } = await getCommunityDb()
    .from("community_plans")
    .select("views,is_public,user_id")
    .eq("id", planId)
    .maybeSingle<{ views: number; is_public: boolean | null; user_id: string | null }>();
  if (error) {
    throw new Error(error.message || "Reading the view count failed.", { cause: error });
  }
  return data ?? undefined;
}

/** Sets a post's view count. Throws when the update fails. */
export async function writeViews(planId: string, views: number, _tx?: Tx): Promise<void> {
  const { error } = await getCommunityDb().from("community_plans").update({ views }).eq("id", planId);
  if (error) {
    throw new Error(error.message || "Counting the view failed.", { cause: error });
  }
}

/** What a download hands out, its count and the access fields; undefined when missing or the read fails. */
export async function readDownload(
  planId: string,
  _tx?: Tx,
): Promise<
  | { plan: unknown; downloads: number; name: string; is_public: boolean | null; user_id: string | null }
  | undefined
> {
  const { data, error } = await getCommunityDb()
    .from("community_plans")
    .select("plan,downloads,name,is_public,user_id")
    .eq("id", planId)
    .single<{
      plan: unknown;
      downloads: number;
      name: string;
      is_public: boolean | null;
      user_id: string | null;
    }>();
  return error || !data ? undefined : data;
}

/** Sets a post's download count. Best effort: a failure is not reported. */
export async function writeDownloads(planId: string, downloads: number, _tx?: Tx): Promise<void> {
  await getCommunityDb().from("community_plans").update({ downloads }).eq("id", planId);
}

/** The column sets a by-score read of the public posts can ask for. */
export type PublicByScoreColumns = typeof PLAN_SUMMARY_COLUMNS | "id,created_at,updated_at";

/** The public posts, best first, up to `limit`. Throws when the database does not answer. */
export async function publicByScore<Row>(
  limit: number,
  columns: PublicByScoreColumns,
  _tx?: Tx,
): Promise<Row[]> {
  // The null branch is dead (the column is not null) and goes with the direct client.
  const { data, error } = await getCommunityDb()
    .from("community_plans")
    .select(columns)
    .or("is_public.eq.true,is_public.is.null")
    .order("score", { ascending: false })
    .limit(limit)
    .returns<Row[]>();
  if (error) {
    throw new Error(error.message || "Reading the public posts failed.", { cause: error });
  }
  return data ?? [];
}
