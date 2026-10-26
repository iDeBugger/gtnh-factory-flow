import { applyPlanSearch, type PlanSearch } from "@/lib/community/search-query";
import type { BlueprintResourceStat, PublicBlueprintSort } from "@/lib/blueprints/types";
import type { EntryIcon } from "@/lib/community/types";
import { BLUEPRINT_SUMMARY_COLUMNS, type BlueprintRow } from "../blueprints";
import { DbQueryError, getCommunityDb, type Tx } from "../db";
import { blueprintReadableBy, publicBlueprints } from "./visibility";

/**
 * Blueprints (`blueprints`). Who may read or change one is the services'
 * rule (`services/access.ts`); these only read and write rows. A read or
 * write the database refuses throws `DbQueryError` with its code, so the
 * service words it as the route did (`blueprintStorageErrorMessage`).
 * Repositories take an optional transaction last; until the direct client
 * lands there is none and `tx` is unused.
 */

/** A blueprint row with the payload it places. */
export type BlueprintPayloadRow = BlueprintRow & { payload: unknown };

/** The public shelf's page: the search, the sort, and the rows to skip and take. */
export interface BlueprintListQuery {
  search: PlanSearch;
  sort: PublicBlueprintSort;
  offset: number;
  limit: number;
}

/** The columns a blueprint's stats and stat card fill, derived by the server from its payload. */
export interface BlueprintContentColumns {
  payload: unknown;
  node_count: number;
  storage_count: number;
  edge_count: number;
  pocket_count: number;
  machine_count: number;
  needs: BlueprintResourceStat[];
  outputs: BlueprintResourceStat[];
  highest_tier: string | null;
  highest_tier_index: number;
}

export interface NewBlueprintRow extends BlueprintContentColumns {
  user_id: string;
  name: string;
  tags: string[];
  tags_text: string;
  icon: EntryIcon | null;
}

/** The fields an owner's edit or publish may write. */
export type BlueprintPatch = Partial<
  BlueprintContentColumns & {
    name: string;
    tags: string[];
    tags_text: string;
    icon: EntryIcon | null;
    is_public: boolean;
    author_name: string;
    published_at: string;
    description: string;
  }
>;

/** The account's own blueprints, newest first, up to `limit`. */
export async function listOwn(userId: string, limit: number, _tx?: Tx): Promise<BlueprintRow[]> {
  const { data, error } = await getCommunityDb()
    .from("blueprints")
    .select(BLUEPRINT_SUMMARY_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? []) as unknown as BlueprintRow[];
}

/**
 * One page of the public shelf. Sorting happens in the database (the shelf
 * can outgrow one page); a plain term matches names, descriptions and
 * tags, #tag narrows to tags, @name to that creator.
 */
export async function listPublic(query: BlueprintListQuery, _tx?: Tx): Promise<BlueprintRow[]> {
  let builder = getCommunityDb().from("blueprints").select(BLUEPRINT_SUMMARY_COLUMNS);
  builder = publicBlueprints(builder);
  builder = applyPlanSearch(builder, query.search);
  if (query.sort === "top") {
    builder = builder.order("score", { ascending: false }).order("published_at", { ascending: false });
  } else if (query.sort === "downloads") {
    builder = builder
      .order("downloads", { ascending: false })
      .order("published_at", { ascending: false });
  } else {
    builder = builder.order("published_at", { ascending: false });
  }
  const { data, error } = await builder.range(query.offset, query.offset + query.limit - 1);
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? []) as unknown as BlueprintRow[];
}

/** How many blueprints the account holds. A failed count reads as none: the insert after it answers the failure. */
export async function countOwn(userId: string, _tx?: Tx): Promise<number> {
  const { count } = await getCommunityDb()
    .from("blueprints")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  return count ?? 0;
}

/** Stores a new blueprint and answers its summary row. */
export async function insert(row: NewBlueprintRow, _tx?: Tx): Promise<BlueprintRow> {
  const { data, error } = await getCommunityDb()
    .from("blueprints")
    .insert(row)
    .select(BLUEPRINT_SUMMARY_COLUMNS)
    .single();
  if (error || !data) {
    throw new DbQueryError(error);
  }
  return data as unknown as BlueprintRow;
}

/**
 * A blueprint with its payload, when the viewer may read it
 * (`canReadBlueprint`'s query form); undefined when there is none, or none
 * the viewer may read.
 */
export async function readReadable(
  id: string,
  viewer: { userId?: string },
  communityOn: boolean,
  _tx?: Tx,
): Promise<BlueprintPayloadRow | undefined> {
  const readable = blueprintReadableBy(viewer, communityOn);
  if (!readable) {
    return undefined;
  }
  const { data, error } = await getCommunityDb()
    .from("blueprints")
    .select(`${BLUEPRINT_SUMMARY_COLUMNS},payload`)
    .eq("id", id)
    .or(readable)
    .maybeSingle();
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? undefined) as BlueprintPayloadRow | undefined;
}

/** Who owns a blueprint and whether it is public, for the access rule. */
export async function readAccess(
  id: string,
  _tx?: Tx,
): Promise<{ id: string; user_id: string; is_public: boolean } | undefined> {
  const { data, error } = await getCommunityDb()
    .from("blueprints")
    .select("id,user_id,is_public")
    .eq("id", id)
    .maybeSingle<{ id: string; user_id: string; is_public: boolean }>();
  if (error) {
    throw new DbQueryError(error);
  }
  return data ?? undefined;
}

/** Writes `patch` to the owner's blueprint and answers its summary row; undefined when the owner has no such blueprint. */
export async function updateOwn(
  id: string,
  ownerId: string,
  patch: BlueprintPatch,
  _tx?: Tx,
): Promise<BlueprintRow | undefined> {
  const { data, error } = await getCommunityDb()
    .from("blueprints")
    .update(patch)
    .eq("id", id)
    .eq("user_id", ownerId)
    .select(BLUEPRINT_SUMMARY_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? undefined) as BlueprintRow | undefined;
}

/** Deletes the owner's blueprint (its votes go with it); answers whether there was one. */
export async function deleteOwn(id: string, ownerId: string, _tx?: Tx): Promise<boolean> {
  const { data, error } = await getCommunityDb()
    .from("blueprints")
    .delete()
    .eq("id", id)
    .eq("user_id", ownerId)
    .select("id");
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? []).length > 0;
}

/** A public blueprint with its payload, for a counted download; undefined when there is none. */
export async function readDownload(id: string, _tx?: Tx): Promise<BlueprintPayloadRow | undefined> {
  let query = getCommunityDb()
    .from("blueprints")
    .select(`${BLUEPRINT_SUMMARY_COLUMNS},payload`)
    .eq("id", id);
  query = publicBlueprints(query);
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? undefined) as BlueprintPayloadRow | undefined;
}

/** Sets a blueprint's download count. Best effort: a failure is not reported. */
export async function writeDownloads(id: string, downloads: number, _tx?: Tx): Promise<void> {
  await getCommunityDb().from("blueprints").update({ downloads }).eq("id", id);
}
