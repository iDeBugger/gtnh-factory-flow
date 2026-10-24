import { NextResponse } from "next/server";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/mod-and-community-gate";
import { BOARD_IMAGE_MAX_BYTES, UPLOAD_FORM_OVERHEAD_BYTES } from "@/lib/community/types";
import {
  PLAN_PREVIEW_BUCKET,
  PLAN_PREVIEW_MAX_SIDE,
  getPlanPreviewPng,
  readPngHeader,
} from "@/lib/server/plan-preview";
import { readFormDataCapped } from "@/lib/server/request-body";
import {
  checkRateLimit,
  getCommunityDb,
  getSessionUser,
  isAdminRequest,
  isCommunityConfigured,
} from "@/lib/server/community";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The board photograph a shared link unfurls into. Stored in its own PRIVATE
 * bucket AT the plan's id (no schema column, no URL to validate: the card
 * route derives the object name from the id it already has, and re-sharing
 * overwrites in place) and served only through the GET below, which checks
 * the post: a bucket URL would show an unpublished post's board to anyone
 * who had the id. Nothing reads the bucket's public URL.
 *
 * Owner-only, unlike board-image uploads: this picture becomes the plan's
 * public face in every chat the link is pasted into, so only the person who
 * owns the post gets to stamp it. The card trusts the PNG's header for its
 * size, so the header is checked here: a real IHDR with both sides within
 * `PLAN_PREVIEW_MAX_SIDE`. A re-share overwrites one object, so the cost of
 * a flood is storage churn; an account gets a few dozen an hour, counted
 * after the checks so junk spends no share.
 */

const PREVIEWS_PER_HOUR = 30;

let bucketReady = false;

async function ensureBucket(): Promise<void> {
  if (bucketReady) {
    return;
  }
  const db = getCommunityDb();
  const { data } = await db.storage.getBucket(PLAN_PREVIEW_BUCKET);
  if (!data) {
    const { error } = await db.storage.createBucket(PLAN_PREVIEW_BUCKET, {
      public: false,
      fileSizeLimit: BOARD_IMAGE_MAX_BYTES,
    });
    if (error && !/already exists/i.test(error.message)) {
      throw new Error(`Preview storage bucket could not be created: ${error.message}`);
    }
  }
  bucketReady = true;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ planId: string }> },
) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Community hub is not configured." }, { status: 503 });
  }

  try {
    const { planId } = await params;
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: "Sign in to update your post." }, { status: 401 });
    }

    const db = getCommunityDb();
    const { data: existing } = await db
      .from("community_plans")
      .select("id,user_id")
      .eq("id", planId)
      .single<{ id: string; user_id: string | null }>();

    if (!existing) {
      return NextResponse.json({ error: "Plan not found." }, { status: 404 });
    }
    if (existing.user_id !== sessionUser.id && !sessionUser.is_admin) {
      return NextResponse.json({ error: "You don't own this post." }, { status: 403 });
    }

    const form = await readFormDataCapped(
      request,
      BOARD_IMAGE_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES,
    );
    if (!form) {
      return NextResponse.json(
        { error: "That preview is too big: the limit is 4 MB." },
        { status: 413 },
      );
    }
    const file = form.get("image");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "No image in the upload." }, { status: 400 });
    }
    if (file.size > BOARD_IMAGE_MAX_BYTES) {
      return NextResponse.json(
        { error: "That preview is too big: the limit is 4 MB." },
        { status: 413 },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!readPngHeader(bytes)) {
      return NextResponse.json(
        {
          error: `The preview must be a PNG of at most ${PLAN_PREVIEW_MAX_SIDE} by ${PLAN_PREVIEW_MAX_SIDE} pixels.`,
        },
        { status: 415 },
      );
    }

    if (!(await checkRateLimit(`user:${sessionUser.id}`, "plan-preview", PREVIEWS_PER_HOUR, 60 * 60))) {
      return NextResponse.json(
        { error: "Too many preview uploads: try again in a little while." },
        { status: 429 },
      );
    }

    await ensureBucket();
    // Short cache: the same object name is overwritten on every re-share, so
    // a hot CDN copy must age out quickly enough for updates to show.
    const { error } = await db.storage
      .from(PLAN_PREVIEW_BUCKET)
      .upload(`${existing.id}.png`, bytes, {
        contentType: "image/png",
        cacheControl: "300",
        upsert: true,
      });
    if (error) {
      return NextResponse.json(
        { error: `Preview upload failed: ${error.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Preview upload failed." },
      { status: 500 },
    );
  }
}

/**
 * The photograph itself, for the library's preview page. A public post's is
 * the same picture every chat unfurl shows, so anyone may look; an
 * unpublished post's is its owner's (and the admin's) alone, and the answer
 * for one reads the same as for a post with no picture, so a stranger learns
 * nothing the detail route would not tell them.
 */
export async function GET(request: Request, context: { params: Promise<{ planId: string }> }) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  const none = NextResponse.json({ error: "No preview." }, { status: 404 });
  if (!isCommunityConfigured()) {
    return none;
  }
  const { planId } = await context.params;
  const { data: row, error } = await getCommunityDb()
    .from("community_plans")
    .select("is_public,user_id")
    .eq("id", planId)
    .maybeSingle<{ is_public: boolean | null; user_id: string | null }>();
  if (error || !row) {
    return none;
  }
  const unpublished = row.is_public === false;
  if (unpublished) {
    const sessionUser = await getSessionUser(request);
    if (row.user_id !== sessionUser?.id && !sessionUser?.is_admin && !isAdminRequest(request)) {
      return none;
    }
  }
  const png = await getPlanPreviewPng(planId);
  if (!png) {
    return none;
  }
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      // Re-sharing overwrites in place, so a short cache keeps a public
      // picture honest. A private one depends on the cookie and must never
      // sit in a shared cache.
      "Cache-Control": unpublished ? "private, no-store" : "public, max-age=300",
    },
  });
}
