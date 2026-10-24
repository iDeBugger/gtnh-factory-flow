import { NextResponse } from "next/server";
import { bumpSessionEpoch, getSessionUser, sessionCookieHeader } from "@/lib/server/community";
import { notifyLive } from "@/lib/server/cloud-plans";
import { SIGN_OUT_EVERYWHERE_FAILED } from "@/lib/community/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign out. Plain: the browser forgets its cookie and nothing changes on the
 * server. With `{ everywhere: true }` and a valid session: the account's
 * session epoch moves, so every token made so far (other browsers, the game)
 * is refused from now on, and the live service is told to drop the account's
 * sockets. A plain sign-out and a successful one everywhere clear the cookie;
 * a failed one keeps it, so the browser stays signed in like the other
 * sessions it could not end, and the player can try again.
 */
export async function POST(request: Request) {
  const clearing = { "Set-Cookie": sessionCookieHeader("", true) };
  const body = (await request.json().catch(() => undefined)) as { everywhere?: unknown } | undefined;
  if (body?.everywhere !== true) {
    return NextResponse.json({ ok: true }, { headers: clearing });
  }
  try {
    const user = await getSessionUser(request);
    if (user) {
      await bumpSessionEpoch(user.id);
      void notifyLive({ kind: "signed-out", userId: user.id });
    }
    return NextResponse.json({ ok: true }, { headers: clearing });
  } catch {
    return NextResponse.json({ error: SIGN_OUT_EVERYWHERE_FAILED }, { status: 503 });
  }
}
