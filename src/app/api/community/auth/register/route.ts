import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/http/error-response";
import { sessionCookieHeader } from "@/lib/server/auth/sessions";
import { register } from "@/lib/server/services/accounts";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { serviceResponse } from "@/lib/server/http/service-response";
import {
  readJsonCapped,
  REQUEST_TOO_BIG_MESSAGE,
  SMALL_JSON_MAX_BYTES,
} from "@/lib/server/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
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
    const result = await register(
      {
        username: typeof body.username === "string" ? body.username : "",
        password: typeof body.password === "string" ? body.password : "",
      },
      request,
    );
    return serviceResponse(
      result,
      (account) => ({ username: account.username, isAdmin: false }),
      (account) => ({ status: 201, headers: { "Set-Cookie": sessionCookieHeader(account.token) } }),
    );
  } catch (error) {
    return serverErrorResponse(error, "Sign up failed.");
  }
}
