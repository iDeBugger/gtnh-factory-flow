import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/http/error-response";
import { readViewer } from "@/lib/server/http/viewer";
import { isDatabaseConfigured } from "@/lib/server/services/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ user: null });
  }

  try {
    const viewer = await readViewer(request);
    return NextResponse.json(
      { user: viewer.userId ? { username: viewer.username, isAdmin: viewer.isAdmin } : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Not "signed out": the client asks again rather than showing Sign in.
    return serverErrorResponse(error, "Account lookup failed.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
