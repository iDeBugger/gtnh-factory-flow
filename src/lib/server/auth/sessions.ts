import { getCommunityDb } from "../db";
import {
  makeSessionToken,
  readSessionCookie,
  SESSION_COOKIE,
  SESSION_DAYS,
  verifySessionToken,
} from "../session";

export { makeSessionToken, SESSION_COOKIE };

/**
 * The Set-Cookie line that stores or clears the session. In production the
 * cookie is Secure, so a plaintext request to the host never carries a token
 * that is good for 180 days; development runs over http://localhost. The
 * clearing line carries the same attributes, or browsers keep the old cookie.
 */
export function sessionCookieHeader(token: string, clear = false): string {
  const maxAge = clear ? 0 : SESSION_DAYS * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export interface SessionUser {
  id: string;
  username: string;
  is_admin: boolean;
  /** Moves on "Sign out everywhere"; a token made under another value is refused. */
  session_epoch: number;
}

/**
 * Verifies the session cookie and loads the user, or returns undefined: no
 * cookie, a bad signature, an expired token, a gone account, or a token from
 * before the account's last sign-out-everywhere. Throws when the database
 * does not answer (see `loadSessionUser`).
 */
export async function getSessionUser(request: Request): Promise<SessionUser | undefined> {
  const token = readSessionCookie(request.headers.get("cookie"));
  const session = token ? verifySessionToken(token) : undefined;
  if (!session) {
    return undefined;
  }
  const user = await loadSessionUser(session.userId);
  return user && user.session_epoch === session.epoch ? user : undefined;
}

/**
 * The account behind a verified session, or undefined when it is gone. A
 * lookup that fails throws: read as "signed out", it shows a signed-in player
 * the sign-in button, and the live service would close their socket as a
 * refused sign-in, which the client never retries.
 */
export function loadSessionUser(userId: string): Promise<SessionUser | undefined> {
  const cached = sessionUsers.get(userId);
  if (cached && Date.now() - cached.at < SESSION_USER_CACHE_MS) {
    return cached.user;
  }
  if (sessionUsers.size >= SESSION_USER_CACHE_MAX) {
    sessionUsers.clear();
  }
  // The promise is cached before the read answers, so a "Sign out everywhere"
  // that lands while the read is in flight forgets this entry and nothing
  // writes the pre-bump row back afterwards. A failed read is dropped.
  const entry = { at: Date.now(), user: readSessionUser(userId) };
  sessionUsers.set(userId, entry);
  entry.user.catch(() => {
    if (sessionUsers.get(userId) === entry) {
      sessionUsers.delete(userId);
    }
  });
  return entry.user;
}

async function readSessionUser(userId: string): Promise<SessionUser | undefined> {
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
 * Signs the account out everywhere: every token made so far stops verifying,
 * here at once (the cache forgets the account) and in the live service once
 * it hears (`notifyLive` signed-out) or its own cache lapses. A millisecond
 * stamp needs no read-modify-write, and two concurrent bumps both invalidate.
 * Returns the new epoch; throws when the database does not answer.
 */
export async function bumpSessionEpoch(userId: string): Promise<number> {
  const epoch = Date.now();
  const { error } = await getCommunityDb()
    .from("community_users")
    .update({ session_epoch: epoch })
    .eq("id", userId);
  if (error) {
    throw new Error(error.message || "Sign out everywhere failed.");
  }
  forgetSessionUser(userId);
  return epoch;
}

/**
 * Accounts by id, kept a minute: nearly every request names its account, and
 * the database is small. A rename or an admin change shows within the minute.
 */
const SESSION_USER_CACHE_MS = 60_000;
const SESSION_USER_CACHE_MAX = 5000;
const sessionUsers = new Map<string, { at: number; user: Promise<SessionUser | undefined> }>();

/** For tests: forget the cached accounts. */
export function forgetSessionUsers(): void {
  sessionUsers.clear();
}

/** Forget one cached account, so the next request reads its row again. */
export function forgetSessionUser(userId: string): void {
  sessionUsers.delete(userId);
}
