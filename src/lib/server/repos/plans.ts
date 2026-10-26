import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import type { PlanSearch } from "@/lib/community/search-query";
import type { EntryIcon, PlanResourceStat } from "@/lib/community/types";
import { getCommunityDb, getDb, json, type Database, type Tx } from "../db";
import { PLAN_SUMMARY_FIELDS, type PLAN_SUMMARY_COLUMNS, type PlanRow } from "../community-rows";
import { searchConditions } from "./search";
import { sqlRules, type VisibilityViewer } from "./visibility";

/**
 * Community posts (`community_plans`). Who may see or change a post is the
 * services' rule (`services/access.ts`); these read and write rows, and
 * where the rule must hold inside one statement (a list, a counter) they
 * apply its SQL form (`repos/visibility.ts`). Repositories take an optional
 * transaction last. A failed read throws (a down database as
 * `DatabaseDownError`): an error, never a missing post. `writeStats` alone is
 * best effort.
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
 * Every condition of a list query, for both of its statements. The search
 * terms are bound parameters: the free text never becomes a filter of its
 * own, whatever it holds.
 */
function listWhere(
  query: PlanListQuery,
): (eb: ExpressionBuilder<Database, "community_plans">) => Expression<SqlBool> {
  return (eb) => {
    const where = searchConditions(eb, query.search);
    if (query.maxTierIndex !== undefined) {
      where.push(eb("highest_tier_index", "<=", query.maxTierIndex));
    }
    if (query.gameVersion) {
      where.push(eb("game_version", "=", query.gameVersion));
    }
    if (query.maxEuT !== undefined) {
      where.push(eb("total_eu_t", "<=", query.maxEuT));
    }
    // JSON containment: the stat arrays hold {kind, resourceId, ...} and
    // @> matches on the keys given, so the rate is free to differ.
    for (const resource of query.makes) {
      where.push(eb("outputs", "@>", json([resource])));
    }
    for (const resource of query.takes) {
      where.push(eb("needs", "@>", json([resource])));
    }
    where.push(
      query.shelf.kind === "mine"
        ? eb("community_plans.user_id", "=", query.shelf.userId)
        : sqlRules.publicPlans()(eb),
    );
    return eb.and(where);
  };
}

/**
 * One page of posts and the count of every post the query matches, however
 * far past the end the page is: two statements over one condition, which the
 * caller runs on one snapshot (`withTransaction`'s `readSnapshot`). Ties
 * break newest first; `nullsLast` puts posts without the column's value
 * after the rest, whichever way it is read. Throws when the database does
 * not answer.
 */
export async function list(
  query: PlanListQuery,
  tx?: Tx,
): Promise<{ rows: PlanRow[]; total: number }> {
  const db = tx ?? getDb();
  const { column, ascending, nullsLast } = query.sort;
  const where = listWhere(query);
  const rows = await db
    .selectFrom("community_plans")
    .select(PLAN_SUMMARY_FIELDS)
    .where(where)
    .orderBy(column, (order) => {
      const direction = ascending ? order.asc() : order.desc();
      return nullsLast ? direction.nullsLast() : direction;
    })
    .orderBy("created_at", "desc")
    .limit(query.limit)
    .offset(query.offset)
    .$castTo<PlanRow>()
    .execute();
  const counted = await db
    .selectFrom("community_plans")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where(where)
    .executeTakeFirstOrThrow();
  return { rows, total: Number(counted.count) };
}

/**
 * The game versions published posts carry, newest first, for the filter.
 * An unpublished post's version is its owner's
 * business, so it never names a choice on the public shelf.
 */
export async function distinctGameVersions(tx?: Tx): Promise<string[]> {
  const rows = await (tx ?? getDb())
    .selectFrom("community_plans")
    .select("game_version")
    .distinct()
    .where(sqlRules.publicPlans())
    .where("game_version", "<>", "")
    .limit(1000)
    .execute();
  return rows
    .map((row) => row.game_version)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

/**
 * A post's summary row, published or not (the caller decides who sees it),
 * or undefined when there is none.
 */
export async function readSummary(planId: string, tx?: Tx): Promise<PlanRow | undefined> {
  return (tx ?? getDb())
    .selectFrom("community_plans")
    .select(PLAN_SUMMARY_FIELDS)
    .where("id", "=", planId)
    .$castTo<PlanRow>()
    .executeTakeFirst();
}

/** Who owns a post and whether it is published, for the access rule. Throws when the database does not answer. */
export async function readAccess(
  planId: string,
  tx?: Tx,
): Promise<{ id: string; user_id: string | null; is_public: boolean } | undefined> {
  return (tx ?? getDb())
    .selectFrom("community_plans")
    .select(["id", "user_id", "is_public"])
    .where("id", "=", planId)
    .executeTakeFirst();
}

/**
 * Locks a post's row until the transaction ends, so the writes that restamp
 * its figures (a comment and its recount) run one at a time per post and
 * each recount sees the comments committed before it, and answers whether
 * the post is there. `for no key update`: a comment's foreign-key check on
 * the post never waits for it.
 */
export async function lockPost(planId: string, tx: Tx): Promise<boolean> {
  const row = await tx
    .selectFrom("community_plans")
    .select("id")
    .where("id", "=", planId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  return row !== undefined;
}

/** A post's owner, or undefined when there is none. */
export async function readOwner(
  planId: string,
  tx?: Tx,
): Promise<{ id: string; user_id: string | null } | undefined> {
  return (tx ?? getDb())
    .selectFrom("community_plans")
    .select(["id", "user_id"])
    .where("id", "=", planId)
    .executeTakeFirst();
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

/** What an author's edit may change, jsonb fields as plain values (the repository wraps them). */
export type PlanPatch = Partial<
  Pick<
    NewPlanRow,
    | keyof PlanStatsColumns
    | "name"
    | "description"
    | "game_version"
    | "dataset_version"
    | "plan"
    | "tags"
    | "tags_text"
    | "icon"
    | "stats_version"
  > & { is_public: boolean; updated_at: string; last_activity_at: string }
>;

/** An icon as the column takes it: SQL null when there is none, as PostgREST wrote it. */
const iconParam = (icon: EntryIcon | null) => (icon === null ? null : json(icon));

/** The stat columns as the table takes them, the arrays as jsonb. */
function statsValues(stats: PlanStatsColumns) {
  return {
    needs: json(stats.needs),
    outputs: json(stats.outputs),
    total_eu_t: stats.total_eu_t,
    machine_count: stats.machine_count,
    node_count: stats.node_count,
    storage_count: stats.storage_count,
    edge_count: stats.edge_count,
    highest_tier: stats.highest_tier,
    highest_tier_index: stats.highest_tier_index,
  };
}

/** Stores a new post and answers its id. Throws when the insert fails. */
export async function insert(row: NewPlanRow, tx?: Tx): Promise<string> {
  const inserted = await (tx ?? getDb())
    .insertInto("community_plans")
    .values({
      ...row,
      ...statsValues(row),
      plan: json(row.plan),
      tags: json(row.tags),
      icon: iconParam(row.icon),
      last_activity_at: new Date().toISOString(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return inserted.id;
}

/**
 * Writes the fields of `patch` to the owner's post. Throws when the update
 * fails; answers whether a row was there to change.
 */
export async function update(
  planId: string,
  ownerId: string,
  patch: PlanPatch,
  tx?: Tx,
): Promise<boolean> {
  const { needs, outputs, plan, tags, icon, ...plain } = patch;
  const result = await (tx ?? getDb())
    .updateTable("community_plans")
    .set({
      ...plain,
      ...(needs !== undefined ? { needs: json(needs) } : {}),
      ...(outputs !== undefined ? { outputs: json(outputs) } : {}),
      ...(plan !== undefined ? { plan: json(plan) } : {}),
      ...(tags !== undefined ? { tags: json(tags) } : {}),
      ...(icon !== undefined ? { icon: iconParam(icon) } : {}),
    })
    .where("id", "=", planId)
    .where("user_id", "=", ownerId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Deletes a post (its comments and votes go with it). Throws when the delete fails. */
export async function remove(planId: string, tx?: Tx): Promise<void> {
  await (tx ?? getDb()).deleteFrom("community_plans").where("id", "=", planId).execute();
}

/** The release a post's stat card was computed by; undefined when the post is missing. */
export async function readStatsVersion(planId: string, tx?: Tx): Promise<string | undefined> {
  const row = await (tx ?? getDb())
    .selectFrom("community_plans")
    .select("stats_version")
    .where("id", "=", planId)
    .executeTakeFirst();
  return row?.stats_version;
}

/** A post's stored plan JSON; undefined when the post is missing. */
export async function readPlanJson(planId: string, tx?: Tx): Promise<unknown> {
  const row = await (tx ?? getDb())
    .selectFrom("community_plans")
    .select("plan")
    .where("id", "=", planId)
    .executeTakeFirst();
  return row?.plan;
}

/** Stores a recomputed stat card. Not an author edit: `updated_at` stays. Best effort: a failure is not reported. */
export async function writeStats(
  planId: string,
  stats: PlanStatsColumns,
  version: string,
  tx?: Tx,
): Promise<void> {
  try {
    await (tx ?? getDb())
      .updateTable("community_plans")
      .set({ ...statsValues(stats), stats_version: version })
      .where("id", "=", planId)
      .execute();
  } catch {
    // The saved card stays; the next open tries again.
  }
}

/**
 * Counts one view of a post the viewer may see and answers the new count, or
 * undefined when there is no such post for them. One statement: concurrent
 * views each add one, and the access rule holds in the same statement.
 * Throws when the database does not answer.
 */
export async function countView(
  planId: string,
  viewer: VisibilityViewer,
  tx?: Tx,
): Promise<number | undefined> {
  const row = await (tx ?? getDb())
    .updateTable("community_plans")
    .set((eb) => ({ views: eb("views", "+", 1) }))
    .where((eb) => eb.and([eb("id", "=", planId), sqlRules.planVisibleTo(viewer)(eb)]))
    .returning("views")
    .executeTakeFirst();
  return row?.views;
}

/**
 * Counts one download of a post the viewer may see and answers what it hands
 * out, in one statement like `countView`. Undefined when there is no such
 * post for them.
 */
export async function takeDownload(
  planId: string,
  viewer: VisibilityViewer,
  tx?: Tx,
): Promise<{ plan: unknown; name: string } | undefined> {
  return (tx ?? getDb())
    .updateTable("community_plans")
    .set((eb) => ({ downloads: eb("downloads", "+", 1) }))
    .where((eb) => eb.and([eb("id", "=", planId), sqlRules.planVisibleTo(viewer)(eb)]))
    .returning(["plan", "name"])
    .executeTakeFirst();
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
