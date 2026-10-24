import { NextResponse } from "next/server";
import { PASSWORD_MIN_LENGTH, SIGN_IN_BUSY } from "@/lib/community/types";
import {
  checkRateLimit,
  getCommunityDb,
  hashPassword,
  isCommunityConfigured,
  makeActorKey,
  makeSessionToken,
  PasswordCheckBusyError,
  sessionCookieHeader,
} from "@/lib/server/community";
import {
  readJsonCapped,
  REQUEST_TOO_BIG_MESSAGE,
  SMALL_JSON_MAX_BYTES,
} from "@/lib/server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;

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

    if (!USERNAME_PATTERN.test(username)) {
      return NextResponse.json(
        { error: "Username must be 3-24 characters: letters, numbers, - or _." },
        { status: 400 },
      );
    }

    if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
      return NextResponse.json(
        { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` },
        { status: 400 },
      );
    }

    const actorKey = makeActorKey(request);
    if (!(await checkRateLimit(actorKey, "register", 5, 60 * 60))) {
      return NextResponse.json(
        { error: "Too many accounts created. Try again later." },
        { status: 429 },
      );
    }

    const db = getCommunityDb();
    const { data, error } = await db
      .from("community_users")
      .insert({ username, password_hash: await hashPassword(password) })
      .select("id,username")
      .single<{ id: string; username: string }>();

    if (error || !data) {
      const taken = error?.message.includes("duplicate") || error?.code === "23505";
      return NextResponse.json(
        { error: taken ? "That username is taken." : (error?.message ?? "Sign up failed.") },
        { status: taken ? 409 : 500 },
      );
    }

    return NextResponse.json(
      { username: data.username, isAdmin: false },
      { status: 201, headers: { "Set-Cookie": sessionCookieHeader(makeSessionToken(data.id)) } },
    );
  } catch (error) {
    if (error instanceof PasswordCheckBusyError) {
      return NextResponse.json({ error: SIGN_IN_BUSY }, { status: 429 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sign up failed." },
      { status: 500 },
    );
  }
}
