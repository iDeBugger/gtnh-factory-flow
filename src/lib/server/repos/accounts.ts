import { getDb, type Tx } from "../db";
import { escapeLike } from "./like";

/**
 * The account rows: who signs in, under which name, and the epoch that ends
 * every older session. Repositories take an optional transaction last; a
 * query runs on it when one is passed, else on the pool.
 */

export interface SessionUser {
  id: string;
  username: string;
  is_admin: boolean;
  /** Moves on "Sign out everywhere"; a token made under another value is refused. */
  session_epoch: number;
}

export interface LoginAccount {
  id: string;
  username: string;
  password_hash: string;
  is_admin: boolean;
  session_epoch: number;
}

/** Postgres's unique-violation SQLSTATE: the name is taken. */
const UNIQUE_VIOLATION = "23505";

/** The account behind a session, or undefined when it is gone. Throws when the database does not answer. */
export async function readSessionAccount(
  userId: string,
  tx?: Tx,
): Promise<SessionUser | undefined> {
  return (tx ?? getDb())
    .selectFrom("community_users")
    .select(["id", "username", "is_admin", "session_epoch"])
    .where("id", "=", userId)
    .executeTakeFirst();
}

/**
 * The account a sign-in names, with its hash, or undefined. Exact name:
 * registration is case-sensitive. A failed read also answers undefined, so
 * it reads as a wrong password, never as a sign-in.
 */
export async function readLoginAccount(
  username: string,
  tx?: Tx,
): Promise<LoginAccount | undefined> {
  try {
    return await (tx ?? getDb())
      .selectFrom("community_users")
      .select(["id", "username", "password_hash", "is_admin", "session_epoch"])
      .where("username", "=", username)
      .executeTakeFirst();
  } catch {
    return undefined;
  }
}

/** A new account, or "taken" when the name exists. Any other failure throws. */
export async function createAccount(
  username: string,
  passwordHash: string,
  tx?: Tx,
): Promise<{ id: string; username: string } | "taken"> {
  try {
    return await (tx ?? getDb())
      .insertInto("community_users")
      .values({ username, password_hash: passwordHash })
      .returning(["id", "username"])
      .executeTakeFirstOrThrow();
  } catch (error) {
    if ((error as { code?: unknown }).code === UNIQUE_VIOLATION) {
      return "taken";
    }
    throw error;
  }
}

/** Sets the account's session epoch. Throws when the database does not answer. */
export async function setSessionEpoch(userId: string, epoch: number, tx?: Tx): Promise<void> {
  await (tx ?? getDb())
    .updateTable("community_users")
    .set({ session_epoch: epoch })
    .where("id", "=", userId)
    .execute();
}

/**
 * Up to 10 accounts whose name starts with `prefix` (any case), by name,
 * `excludeId` left out. Every character of `prefix` matches only itself.
 */
export async function searchByPrefix(
  prefix: string,
  excludeId: string,
  tx?: Tx,
): Promise<Array<{ id: string; username: string }>> {
  return (tx ?? getDb())
    .selectFrom("community_users")
    .select(["id", "username"])
    .where("username", "ilike", `${escapeLike(prefix)}%`)
    .where("id", "<>", excludeId)
    .orderBy("username", "asc")
    .limit(10)
    .execute();
}

/** Whether an account with this id exists. Throws when the database does not answer. */
export async function accountExists(id: string, tx?: Tx): Promise<boolean> {
  const row = await (tx ?? getDb())
    .selectFrom("community_users")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  return row !== undefined;
}

/** Usernames by account id; an id with no account is left out. Throws when the database does not answer. */
export async function usernamesFor(ids: Iterable<string>, tx?: Tx): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  if (unique.length === 0) {
    return names;
  }
  const rows = await (tx ?? getDb())
    .selectFrom("community_users")
    .select(["id", "username"])
    .where("id", "in", unique)
    .execute();
  for (const row of rows) {
    names.set(row.id, row.username);
  }
  return names;
}
