import { sessionCookieHeader } from "@/lib/server/auth/sessions";
import { SIGN_OUT_EVERYWHERE_FAILED } from "@/lib/community/types";
import { databaseDownResponse } from "@/lib/server/http/error-response";
import { readJsonCapped, SMALL_JSON_MAX_BYTES } from "@/lib/server/http/request-body";
import { serviceResponse } from "@/lib/server/http/service-response";
import { readViewer } from "@/lib/server/http/viewer";
import { signOutEverywhere } from "@/lib/server/services/accounts";

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
  // A body that is too big or not JSON is a plain sign-out, like no body at all.
  const read = await readJsonCapped(request, SMALL_JSON_MAX_BYTES);
  const body = read.ok ? (read.value as { everywhere?: unknown } | null) : undefined;
  if (body?.everywhere !== true) {
    return Response.json({ ok: true }, { headers: clearing });
  }
  let viewer;
  try {
    viewer = await readViewer(request);
  } catch (error) {
    return (
      databaseDownResponse(error, { status: 503 }) ??
      Response.json({ error: SIGN_OUT_EVERYWHERE_FAILED }, { status: 503 })
    );
  }
  return serviceResponse(await signOutEverywhere(viewer), () => ({ ok: true }), {
    headers: clearing,
  });
}
