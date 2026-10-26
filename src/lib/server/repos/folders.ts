import { getDb, type Tx } from "../db";

/**
 * Library folders: one row per owner and id, tombstoned on delete.
 * Repositories take an optional transaction last; a failure throws (a down
 * database as `DatabaseDownError`).
 */

const FOLDER_COLUMNS = ["id", "name", "created_at", "updated_at", "deleted_at"] as const;

export interface FolderRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** The owner's folders, tombstones included. */
export async function listOwn(userId: string, limit: number, tx?: Tx): Promise<FolderRow[]> {
  return (tx ?? getDb())
    .selectFrom("library_folders")
    .select(FOLDER_COLUMNS)
    .where("user_id", "=", userId)
    .limit(limit)
    .execute();
}

/**
 * One folder, or undefined. `forUpdate` (inside a transaction) locks the row
 * until it ends, so two saves of one folder cannot both pass the "behind" check.
 */
export async function read(
  userId: string,
  folderId: string,
  opts: { forUpdate?: boolean } = {},
  tx?: Tx,
): Promise<FolderRow | undefined> {
  const query = (tx ?? getDb())
    .selectFrom("library_folders")
    .select(FOLDER_COLUMNS)
    .where("user_id", "=", userId)
    .where("id", "=", folderId);
  return (opts.forUpdate ? query.forUpdate() : query).executeTakeFirst();
}

/** The owner's live folders. */
export async function countLive(userId: string, tx?: Tx): Promise<number> {
  const row = await (tx ?? getDb())
    .selectFrom("library_folders")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Writes the folder, bringing it back from a tombstone. */
export async function upsert(
  row: { user_id: string; id: string; name: string; created_at: string; updated_at: string },
  tx?: Tx,
): Promise<FolderRow> {
  return (tx ?? getDb())
    .insertInto("library_folders")
    .values({ ...row, deleted_at: null })
    .onConflict((oc) =>
      oc.columns(["user_id", "id"]).doUpdateSet({
        name: row.name,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: null,
      }),
    )
    .returning(FOLDER_COLUMNS)
    .executeTakeFirstOrThrow();
}

/** A tombstone, never a hole. */
export async function tombstone(
  userId: string,
  folderId: string,
  now: string,
  tx?: Tx,
): Promise<void> {
  await (tx ?? getDb())
    .updateTable("library_folders")
    .set({ deleted_at: now, updated_at: now })
    .where("user_id", "=", userId)
    .where("id", "=", folderId)
    .execute();
}
