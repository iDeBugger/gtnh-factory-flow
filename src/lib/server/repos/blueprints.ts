import type { BlueprintResourceStat } from "@/lib/blueprints/types";
import type { EntryIcon } from "@/lib/community/types";
import { BLUEPRINT_SUMMARY_FIELDS, type BlueprintRow } from "../blueprints";
import { getDb, json, type Tx } from "../db";

/**
 * Blueprints (`blueprints`): each is its owner's alone, so every read and
 * write here names the owner in its `where`. Repositories take an optional
 * transaction last. A failed read or write throws (a down database as
 * `DatabaseDownError`).
 */

/** A blueprint row with the payload it places. */
export type BlueprintPayloadRow = BlueprintRow & { payload: unknown };

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

/** The fields an owner's edit may write, jsonb fields as plain values (the repository wraps them). */
export type BlueprintPatch = Partial<
  BlueprintContentColumns & {
    name: string;
    tags: string[];
    tags_text: string;
    icon: EntryIcon | null;
  }
>;

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

/** The owner's blueprint with its payload; undefined when the owner has no such blueprint. */
export async function readOwn(id: string, ownerId: string, tx?: Tx): Promise<BlueprintPayloadRow | undefined> {
  return (tx ?? getDb())
    .selectFrom("blueprints")
    .select([...BLUEPRINT_SUMMARY_FIELDS, "payload"])
    .where("id", "=", id)
    .where("user_id", "=", ownerId)
    .$castTo<BlueprintPayloadRow>()
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
