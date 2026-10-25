import { getCommunityDb, type Tx } from "../db";

/**
 * The account rows: who signs in, under which name, and the epoch that ends
 * every older session. Repositories take an optional transaction last; until
 * the direct client lands there is none and `tx` is unused.
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

/** The account behind a session, or undefined when it is gone. Throws when the database does not answer. */
export async function readSessionAccount(
  userId: string,
  _tx?: Tx,
): Promise<SessionUser | undefined> {
  const { data, error } = await getCommunityDb()
    .from("community_users")
    .select("id,username,is_admin,session_epoch")
    .eq("id", userId)
    .maybeSingle<SessionUser>();
  if (error) {
    throw new Error(error.message || "Account lookup failed.");
  }
  // bigint arrives as a JSON number; a row from before the column reads as 0.
  return data ? { ...data, session_epoch: Number(data.session_epoch ?? 0) } : undefined;
}

/**
 * The account a sign-in names, with its hash, or undefined. Exact name:
 * registration is case-sensitive. A failed read also answers undefined, so
 * it reads as a wrong password, never as a sign-in.
 */
export async function readLoginAccount(
  username: string,
  _tx?: Tx,
): Promise<LoginAccount | undefined> {
  const { data } = await getCommunityDb()
    .from("community_users")
    .select("id,username,password_hash,is_admin,session_epoch")
    .eq("username", username)
    .single<Omit<LoginAccount, "session_epoch"> & { session_epoch: number | null }>();
  return data ? { ...data, session_epoch: Number(data.session_epoch ?? 0) } : undefined;
}

/** A new account, or "taken" when the name exists. Any other failure throws, the database's error as its cause. */
export async function createAccount(
  username: string,
  passwordHash: string,
  _tx?: Tx,
): Promise<{ id: string; username: string } | "taken"> {
  const { data, error } = await getCommunityDb()
    .from("community_users")
    .insert({ username, password_hash: passwordHash })
    .select("id,username")
    .single<{ id: string; username: string }>();
  if (error || !data) {
    if (error?.message.includes("duplicate") || error?.code === "23505") {
      return "taken";
    }
    throw new Error(error?.message || "No account row came back.", { cause: error });
  }
  return data;
}

/** Sets the account's session epoch. Throws when the database does not answer. */
export async function setSessionEpoch(userId: string, epoch: number, _tx?: Tx): Promise<void> {
  const { error } = await getCommunityDb()
    .from("community_users")
    .update({ session_epoch: epoch })
    .eq("id", userId);
  if (error) {
    throw new Error(error.message || "Sign out everywhere failed.");
  }
}

/**
 * Up to 10 accounts whose name starts with `prefix` (any case), by name,
 * `excludeId` left out. The caller holds `prefix` to letters, digits, `-`
 * and `_`; `_` is a LIKE wildcard, so it is escaped to match only itself.
 */
export async function searchByPrefix(
  prefix: string,
  excludeId: string,
  _tx?: Tx,
): Promise<Array<{ id: string; username: string }>> {
  const pattern = `${prefix.replace(/_/g, "\\_")}%`;
  const { data, error } = await getCommunityDb()
    .from("community_users")
    .select("id,username")
    .ilike("username", pattern)
    .neq("id", excludeId)
    .order("username", { ascending: true })
    .limit(10);
  if (error) {
    throw new Error(`Account search failed: ${error.message}`);
  }
  return (data ?? []) as Array<{ id: string; username: string }>;
}

/** Whether an account with this id exists. Throws when the database does not answer. */
export async function accountExists(id: string, _tx?: Tx): Promise<boolean> {
  const { data, error } = await getCommunityDb()
    .from("community_users")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error(`Account lookup failed: ${error.message}`);
  }
  return Boolean(data);
}

/** Usernames by account id; an id with no account is left out. Throws when the database does not answer. */
export async function usernamesFor(ids: Iterable<string>, _tx?: Tx): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  if (unique.length === 0) {
    return names;
  }
  const { data, error } = await getCommunityDb()
    .from("community_users")
    .select("id,username")
    .in("id", unique);
  if (error) {
    throw new Error(`Account lookup failed: ${error.message}`);
  }
  for (const row of (data ?? []) as Array<{ id: string; username: string }>) {
    names.set(row.id, row.username);
  }
  return names;
}
