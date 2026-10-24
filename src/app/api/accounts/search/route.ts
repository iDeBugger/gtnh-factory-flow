import { NextResponse } from "next/server";
import { getCommunityDb, getSessionUser, isCommunityConfigured } from "@/lib/server/community";
import { takeMemoryToken } from "@/lib/server/memory-rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Usernames are letters, digits, - and _ (the register route's rule). Two
 * characters at least: one names a thirtieth of every account, which is a
 * directory, not a search.
 */
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{2,24}$/;

/**
 * Accounts whose username starts with `q` (any case), for picking whom to
 * share a plan with: up to 10 `{ id, username }`, the caller left out.
 * Signed-in only; limited in memory, as a share box asks on every keystroke.
 */
export async function GET(request: Request) {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Accounts are not configured." }, { status: 503 });
  }
  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign in to find accounts." }, { status: 401 });
  }
  if (!takeMemoryToken(`account-search:${sessionUser.id}`, 60, 60_000)) {
    return NextResponse.json(
      { error: "Searching too fast. Try again in a moment." },
      { status: 429 },
    );
  }
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (!PREFIX_PATTERN.test(q)) {
    return NextResponse.json({ accounts: [] });
  }
  // `_` is a LIKE wildcard: escape it so it matches only itself.
  const pattern = `${q.replace(/_/g, "\\_")}%`;
  const { data, error } = await getCommunityDb()
    .from("community_users")
    .select("id,username")
    .ilike("username", pattern)
    .neq("id", sessionUser.id)
    .order("username", { ascending: true })
    .limit(10);
  if (error) {
    return NextResponse.json({ error: "Accounts could not be searched." }, { status: 500 });
  }
  return NextResponse.json({ accounts: (data ?? []) as Array<{ id: string; username: string }> });
}
