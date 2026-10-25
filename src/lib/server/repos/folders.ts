import { DbQueryError, getCommunityDb, type Tx } from "../db";

/** Library folders: one row per owner and id, tombstoned on delete. */

const FOLDER_COLUMNS = "id,name,created_at,updated_at,deleted_at";

export interface FolderRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const db = () => getCommunityDb();

/** The owner's folders, tombstones included. Throws `DbQueryError`. */
export async function listOwn(userId: string, limit: number, _tx?: Tx): Promise<FolderRow[]> {
  const { data, error } = await db()
    .from("library_folders")
    .select(FOLDER_COLUMNS)
    .eq("user_id", userId)
    .limit(limit);
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? []) as FolderRow[];
}

/** One folder, or undefined. Throws `DbQueryError`. */
export async function read(
  userId: string,
  folderId: string,
  _tx?: Tx,
): Promise<FolderRow | undefined> {
  const { data, error } = await db()
    .from("library_folders")
    .select(FOLDER_COLUMNS)
    .eq("user_id", userId)
    .eq("id", folderId)
    .maybeSingle();
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? undefined) as FolderRow | undefined;
}

/** The owner's live folders; a failed count reads as none, as the cap always has. */
export async function countLive(userId: string, _tx?: Tx): Promise<number> {
  const { count } = await db()
    .from("library_folders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("deleted_at", null);
  return count ?? 0;
}

/** Writes the folder, bringing it back from a tombstone. Throws `DbQueryError`. */
export async function upsert(
  row: { user_id: string; id: string; name: string; created_at: string; updated_at: string },
  _tx?: Tx,
): Promise<FolderRow> {
  const { data, error } = await db()
    .from("library_folders")
    .upsert({ ...row, deleted_at: null }, { onConflict: "user_id,id" })
    .select(FOLDER_COLUMNS)
    .single();
  if (error || !data) {
    throw new DbQueryError(error);
  }
  return data as FolderRow;
}

/** A tombstone, never a hole. Throws `DbQueryError`. */
export async function tombstone(
  userId: string,
  folderId: string,
  now: string,
  _tx?: Tx,
): Promise<void> {
  const { error } = await db()
    .from("library_folders")
    .update({ deleted_at: now, updated_at: now })
    .eq("user_id", userId)
    .eq("id", folderId);
  if (error) {
    throw new DbQueryError(error);
  }
}
