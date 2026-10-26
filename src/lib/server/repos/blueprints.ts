import type { PlanSearch } from "@/lib/community/search-query";
import type { BlueprintResourceStat, PublicBlueprintSort } from "@/lib/blueprints/types";
import type { EntryIcon } from "@/lib/community/types";
import { BLUEPRINT_SUMMARY_FIELDS, type BlueprintRow } from "../blueprints";
import { getDb, json, type Tx } from "../db";
import { searchConditions } from "./search";
import { sqlRules, type VisibilityViewer } from "./visibility";

/**
 * Blueprints (`blueprints`). Who may read or change one is the services'
 * rule (`services/access.ts`); these read and write rows, and where the rule
 * must hold inside one statement (a read by id, the download counter) they
 * apply its SQL form (`repos/visibility.ts`). Repositories take an optional
 * transaction last. A failed read or write throws (a down database as
 * `DatabaseDownError`).
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

/** The fields an owner's edit or publish may write, jsonb fields as plain values (the repository wraps them). */
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

/** The public shelf's order by sort, every column descending: a closed set, so no request text names a column. */
const SHELF_ORDER: Record<PublicBlueprintSort, ReadonlyArray<"score" | "downloads" | "published_at">> = {
  top: ["score", "published_at"],
  downloads: ["downloads", "published_at"],
  newest: ["published_at"],
};

/** An icon as the column takes it: SQL null when there is none, never a jsonb null. */
const iconParam = (icon: EntryIcon | null) => (icon === null ? null : json(icon));

/** The content columns as the table takes them, the payload and the stat arrays as jsonb. */
function contentValues<T extends Partial<BlueprintContentColumns>>(content: T) {
  const { payload, needs, outputs, ...plain } = content;
  return {
    ...plain,
    ...(payload !== undefined ? { payload: json(payload) } : {}),
    ...(needs !== undefined ? { needs: json(needs) } : {}),
    ...(outputs !== undefined ? { outputs: json(outputs) } : {}),
  };
}

/** The account's own blueprints, newest first, up to `limit`. */
export async function listOwn(userId: string, limit: number, tx?: Tx): Promise<BlueprintRow[]> {
  return (tx ?? getDb())
    .selectFrom("blueprints")
    .select(BLUEPRINT_SUMMARY_FIELDS)
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .$castTo<BlueprintRow>()
    .execute();
}

/**
 * One page of the public shelf. Sorting happens in the database (the shelf
 * can outgrow one page); the search reads as the community's does
 * (`searchConditions`): a plain term matches names, descriptions and tags,
 * #tag narrows to tags, @name to that creator.
 */
export async function listPublic(query: BlueprintListQuery, tx?: Tx): Promise<BlueprintRow[]> {
  let builder = (tx ?? getDb())
    .selectFrom("blueprints")
    .select(BLUEPRINT_SUMMARY_FIELDS)
    .where((eb) => eb.and([sqlRules.publicBlueprints()(eb), ...searchConditions(eb, query.search)]));
  for (const column of SHELF_ORDER[query.sort]) {
    builder = builder.orderBy(column, "desc");
  }
  return builder.limit(query.limit).offset(query.offset).$castTo<BlueprintRow>().execute();
}

/** How many blueprints the account holds. A failed count throws: read as none it would let a save past the cap. */
export async function countOwn(userId: string, tx?: Tx): Promise<number> {
  const row = await (tx ?? getDb())
    .selectFrom("blueprints")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Stores a new blueprint and answers its summary row. */
export async function insert(row: NewBlueprintRow, tx?: Tx): Promise<BlueprintRow> {
  return (tx ?? getDb())
    .insertInto("blueprints")
    .values({
      ...row,
      payload: json(row.payload),
      needs: json(row.needs),
      outputs: json(row.outputs),
      tags: json(row.tags),
      icon: iconParam(row.icon),
    })
    .returning(BLUEPRINT_SUMMARY_FIELDS)
    .$castTo<BlueprintRow>()
    .executeTakeFirstOrThrow();
}

/**
 * A blueprint with its payload, when the viewer may read it
 * (`canReadBlueprint`'s SQL form); undefined when there is none, or none
 * the viewer may read.
 */
export async function readReadable(
  id: string,
  viewer: VisibilityViewer,
  communityOn: boolean,
  tx?: Tx,
): Promise<BlueprintPayloadRow | undefined> {
  if (!communityOn && viewer.userId === undefined) {
    // The viewer may read none: no statement to send.
    return undefined;
  }
  return (tx ?? getDb())
    .selectFrom("blueprints")
    .select([...BLUEPRINT_SUMMARY_FIELDS, "payload"])
    .where((eb) => eb.and([eb("id", "=", id), sqlRules.blueprintReadableBy(viewer, communityOn)(eb)]))
    .$castTo<BlueprintPayloadRow>()
    .executeTakeFirst();
}

/** Who owns a blueprint and whether it is public, for the access rule. */
export async function readAccess(
  id: string,
  tx?: Tx,
): Promise<{ id: string; user_id: string; is_public: boolean } | undefined> {
  return (tx ?? getDb())
    .selectFrom("blueprints")
    .select(["id", "user_id", "is_public"])
    .where("id", "=", id)
    .executeTakeFirst();
}

/** Writes `patch` to the owner's blueprint and answers its summary row; undefined when the owner has no such blueprint. */
export async function updateOwn(
  id: string,
  ownerId: string,
  patch: BlueprintPatch,
  tx?: Tx,
): Promise<BlueprintRow | undefined> {
  const { tags, icon, ...rest } = patch;
  return (tx ?? getDb())
    .updateTable("blueprints")
    .set({
      ...contentValues(rest),
      ...(tags !== undefined ? { tags: json(tags) } : {}),
      ...(icon !== undefined ? { icon: iconParam(icon) } : {}),
    })
    .where("id", "=", id)
    .where("user_id", "=", ownerId)
    .returning(BLUEPRINT_SUMMARY_FIELDS)
    .$castTo<BlueprintRow>()
    .executeTakeFirst();
}

/** Deletes the owner's blueprint (its votes go with it); answers whether there was one. */
export async function deleteOwn(id: string, ownerId: string, tx?: Tx): Promise<boolean> {
  const result = await (tx ?? getDb())
    .deleteFrom("blueprints")
    .where("id", "=", id)
    .where("user_id", "=", ownerId)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/**
 * Counts one download of a public blueprint and answers it with its payload
 * and the new count; undefined when there is no such public blueprint. One
 * statement: concurrent downloads each add one, and the public rule holds in
 * the same statement. The owner's own download adds nothing, so an author
 * placing their published work never inflates its count.
 */
export async function takeDownload(
  id: string,
  viewer: { userId?: string },
  tx?: Tx,
): Promise<BlueprintPayloadRow | undefined> {
  const { userId } = viewer;
  return (tx ?? getDb())
    .updateTable("blueprints")
    .set((eb) => ({
      downloads:
        userId === undefined
          ? eb("downloads", "+", 1)
          : eb
              .case()
              .when("user_id", "=", userId)
              .then(eb.ref("downloads"))
              .else(eb("downloads", "+", 1))
              .end(),
    }))
    .where((eb) => eb.and([eb("id", "=", id), sqlRules.publicBlueprints()(eb)]))
    .returning([...BLUEPRINT_SUMMARY_FIELDS, "payload"])
    .$castTo<BlueprintPayloadRow>()
    .executeTakeFirst();
}
