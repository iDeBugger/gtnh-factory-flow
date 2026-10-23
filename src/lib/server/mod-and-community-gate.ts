import { NextResponse } from "next/server";

/**
 * The answer a route of the in-game mod or the community library gives while
 * the deployment has them switched off (`isModAndCommunityOn`): the route
 * reads as absent, the same as a path that was never there.
 */
export function modAndCommunityOffResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
