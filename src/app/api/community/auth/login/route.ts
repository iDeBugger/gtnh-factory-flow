import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/error-response";
import { SIGN_IN_BUSY } from "@/lib/community/types";
import { checkPassword, PasswordCheckBusyError } from "@/lib/server/auth/passwords";
import {
  checkRateLimit,
  countEvents,
  recordEvents,
  serially,
} from "@/lib/server/limits/rate-limit";
import { getCommunityDb, isCommunityConfigured } from "@/lib/server/db";
import { makeActorKey, saltedKey } from "@/lib/server/auth/keys";
import { makeSessionToken, sessionCookieHeader } from "@/lib/server/auth/sessions";
import {
  readJsonCapped,
  REQUEST_TOO_BIG_MESSAGE,
  SMALL_JSON_MAX_BYTES,
} from "@/lib/server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function POST(request: Request) {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Community hub is not configured." }, { status: 503 });
  }

  try {
    const read = await readJsonCapped(request, SMALL_JSON_MAX_BYTES);
    if (!read.ok) {
      return read.status === 413
        ? NextResponse.json({ error: REQUEST_TOO_BIG_MESSAGE }, { status: 413 })
        : NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    const body = (read.value ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      return NextResponse.json({ error: "Username and password required." }, { status: 400 });
    }

    const actorKey = makeActorKey(request);
    if (!(await checkRateLimit(actorKey, "login", 20, 60 * 10))) {
      return NextResponse.json({ error: "Too many attempts. Slow down." }, { status: 429 });
    }

    // The exact name: lookups are exact and registration is case-sensitive, so
    // two names differing in case are two accounts. One attempt at a time per
    // account, so the count sees every earlier failure.
    const accountKey = saltedKey(`login-user:${username}`);
    return await serially(accountKey, async () => {
      if ((await countEvents(accountKey, ACCOUNT_FAILURE_ACTION, ACCOUNT_WINDOW_SECONDS)) >= ACCOUNT_FAILURES) {
        return NextResponse.json(
          { error: "Too many attempts for this account. Try again in 15 minutes." },
          { status: 429 },
        );
      }

      const { data } = await getCommunityDb()
        .from("community_users")
        .select("id,username,password_hash,is_admin,session_epoch")
        .eq("username", username)
        .single<{
          id: string;
          username: string;
          password_hash: string;
          is_admin: boolean;
          session_epoch: number | null;
        }>();

      // The check runs whether or not the name exists, so its timing says nothing about which names do.
      const ok = await checkPassword(password, data?.password_hash);
      if (!data || !ok) {
        await recordEvents([{ actorKey: accountKey, action: ACCOUNT_FAILURE_ACTION }]);
        return NextResponse.json({ error: "Wrong username or password." }, { status: 401 });
      }

      return NextResponse.json(
        { username: data.username, isAdmin: data.is_admin },
        {
          headers: {
            "Set-Cookie": sessionCookieHeader(makeSessionToken(data.id, Number(data.session_epoch ?? 0))),
          },
        },
      );
    });
  } catch (error) {
    if (error instanceof PasswordCheckBusyError) {
      return NextResponse.json({ error: SIGN_IN_BUSY }, { status: 429 });
    }
    return serverErrorResponse(error, "Sign in failed.");
  }
}
