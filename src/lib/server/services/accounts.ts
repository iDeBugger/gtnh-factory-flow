import {
  PASSWORD_MIN_LENGTH,
  SIGN_IN_BUSY,
  SIGN_OUT_EVERYWHERE_FAILED,
} from "@/lib/community/types";
import { checkPassword, hashPassword, PasswordCheckBusyError } from "../auth/passwords";
import { makeActorKey, saltedKey } from "../auth/keys";
import { bumpSessionEpoch, makeSessionToken } from "../auth/sessions";
import { notifyLive } from "../live-notify";
import type { Viewer } from "../http/viewer";
import { checkRateLimit, countEvents, recordEvents, serially } from "../limits/rate-limit";
import { storageErrorMessage } from "../db";
import { takeMemoryToken } from "../limits/memory-rate";
import * as accounts from "../repos/accounts";
import { fail, ok, type ServiceResult } from "./result";

/**
 * Accounts: sign up, sign in, sign out everywhere, and finding an account to
 * share with. Dead simple: a username and a password, no email, no reset.
 */

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;

/** A new account and its first session token. */
export async function register(
  input: { username: string; password: string },
  request: Request,
): Promise<ServiceResult<{ id: string; username: string; token: string }>> {
  const username = input.username.trim();
  const { password } = input;
  if (!USERNAME_PATTERN.test(username)) {
    return fail("bad-request", "Username must be 3-24 characters: letters, numbers, - or _.");
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
    return fail("bad-request", `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  if (!(await checkRateLimit(makeActorKey(request), "register", 5, 60 * 60))) {
    return fail("rate-limited", "Too many accounts created. Try again later.");
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (error) {
    if (error instanceof PasswordCheckBusyError) {
      return fail("rate-limited", SIGN_IN_BUSY);
    }
    throw error;
  }

  let created: Awaited<ReturnType<typeof accounts.createAccount>>;
  try {
    created = await accounts.createAccount(username, passwordHash);
  } catch (error) {
    console.error("Sign up failed.", (error as Error).cause ?? error);
    return fail("unavailable", "Sign up failed.", { status: 500 });
  }
  if (created === "taken") {
    return fail("conflict", "That username is taken.");
  }
  return ok({ id: created.id, username: created.username, token: makeSessionToken(created.id) });
}

/**
 * Failed sign-ins per account before the account is refused from every
 * address until the window passes. Failures only, so a player's own sign-ins
 * never count; a name nobody has is counted the same way, so the limit says
 * nothing about which names exist. The per-address limit (20 attempts in 10
 * minutes, successes included) stays beside it: that one bounds a single
 * address, this one bounds guessing at a single account from many. Anyone
 * can hold one known name locked with a wrong attempt every 90 seconds;
 * existing sessions keep working, and the alternative (count per account and
 * address) does not stop the rotating attacker this is for.
 */
const ACCOUNT_FAILURES = 10;
const ACCOUNT_WINDOW_SECONDS = 15 * 60;
const ACCOUNT_FAILURE_ACTION = "login-fail";

/** A session token for the named account, when the password matches. */
export async function signIn(
  input: { username: string; password: string },
  request: Request,
): Promise<ServiceResult<{ username: string; isAdmin: boolean; token: string }>> {
  const username = input.username.trim();
  const { password } = input;
  if (!username || !password) {
    return fail("bad-request", "Username and password required.");
  }

  if (!(await checkRateLimit(makeActorKey(request), "login", 20, 60 * 10))) {
    return fail("rate-limited", "Too many attempts. Slow down.");
  }

  // The exact name: lookups are exact and registration is case-sensitive, so
  // two names differing in case are two accounts. One attempt at a time per
  // account, so the count sees every earlier failure.
  const accountKey = saltedKey(`login-user:${username}`);
  try {
    return await serially(accountKey, async () => {
      if (
        (await countEvents(accountKey, ACCOUNT_FAILURE_ACTION, ACCOUNT_WINDOW_SECONDS)) >=
        ACCOUNT_FAILURES
      ) {
        return fail("rate-limited", "Too many attempts for this account. Try again in 15 minutes.");
      }

      const account = await accounts.readLoginAccount(username);

      // The check runs whether or not the name exists, so its timing says nothing about which names do.
      const matches = await checkPassword(password, account?.password_hash);
      if (!account || !matches) {
        await recordEvents([{ actorKey: accountKey, action: ACCOUNT_FAILURE_ACTION }]);
        return fail("unauthorized", "Wrong username or password.");
      }

      return ok({
        username: account.username,
        isAdmin: account.is_admin,
        token: makeSessionToken(account.id, account.session_epoch),
      });
    });
  } catch (error) {
    if (error instanceof PasswordCheckBusyError) {
      return fail("rate-limited", SIGN_IN_BUSY);
    }
    throw error;
  }
}

/**
 * Ends every session of the viewer's account: the epoch moves, so every
 * token made so far is refused, and the live service is told to drop the
 * account's sockets. Nobody signed in has nothing to end. A failed write
 * answers unavailable, so the caller keeps its own session and can retry.
 */
export async function signOutEverywhere(viewer: Viewer): Promise<ServiceResult<void>> {
  if (!viewer.userId) {
    return ok(undefined);
  }
  try {
    await bumpSessionEpoch(viewer.userId);
  } catch (error) {
    return fail("unavailable", storageErrorMessage(error, SIGN_OUT_EVERYWHERE_FAILED));
  }
  void notifyLive({ kind: "signed-out", userId: viewer.userId });
  return ok(undefined);
}

/**
 * Usernames are letters, digits, - and _ (the register rule). Two
 * characters at least: one names a thirtieth of every account, which is a
 * directory, not a search.
 */
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{2,24}$/;

/**
 * Accounts whose username starts with `q` (any case), for picking whom to
 * share a plan with: up to 10, the viewer left out. Signed-in only; limited
 * in memory, as a share box asks on every keystroke.
 */
export async function searchAccounts(
  viewer: Viewer,
  q: string,
): Promise<ServiceResult<Array<{ id: string; username: string }>>> {
  if (!viewer.userId) {
    return fail("unauthorized", "Sign in to find accounts.");
  }
  if (!takeMemoryToken(`account-search:${viewer.userId}`, 60, 60_000)) {
    return fail("rate-limited", "Searching too fast. Try again in a moment.");
  }
  const prefix = q.trim();
  if (!PREFIX_PATTERN.test(prefix)) {
    return ok([]);
  }
  try {
    return ok(await accounts.searchByPrefix(prefix, viewer.userId));
  } catch (error) {
    return fail("unavailable", storageErrorMessage(error, "Accounts could not be searched."), {
      status: 500,
    });
  }
}
