import { NextResponse } from "next/server";
import { applyPlanSearch, parsePlanSearch } from "@/lib/community/search-query";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { boardSelectionPayloadSchema } from "@/lib/model/schemas";
import {
  BLUEPRINT_BODY_MAX_BYTES,
  BLUEPRINT_MAX_PER_USER,
  BLUEPRINT_NAME_MAX_LENGTH,
  BLUEPRINT_PAYLOAD_MAX_BYTES,
  normalizeBlueprintTags,
  PUBLIC_BLUEPRINT_PAGE_SIZE,
  type BlueprintListResponse,
  type PublicBlueprintSort,
} from "@/lib/blueprints/types";
import { checkRateLimit } from "@/lib/server/limits/rate-limit";
import { getCommunityDb, isCommunityConfigured } from "@/lib/server/db";
import { getSessionUser } from "@/lib/server/auth/sessions";
import { makeVoterKey } from "@/lib/server/auth/keys";
import { parseEntryIcon } from "@/lib/server/community-rows";
import { blueprintStorageErrorMessage } from "@/lib/server/db";
import {
  attachMyBlueprintVotes,
  BLUEPRINT_SUMMARY_COLUMNS,
  countBlueprintMachines,
  parseHighestTier,
  parseResourceStats,
  rowToBlueprintSummary,
  type BlueprintRow,
} from "@/lib/server/blueprints";
import { readJsonCapped } from "@/lib/server/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const shelf = url.searchParams.get("scope") === "public";
  // The public shelf is the community library, absent with the setting off
  // whatever the server's storage; an account's own blueprints below stay
  // whatever the setting.
  if (shelf && !isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  if (shelf) {
    return listPublicBlueprints(request, url);
  }

  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign in to use blueprints." }, { status: 401 });
  }

  const db = getCommunityDb();
  const { data, error } = await db
    .from("blueprints")
    .select(BLUEPRINT_SUMMARY_COLUMNS)
    .eq("user_id", sessionUser.id)
    .order("created_at", { ascending: false })
    .limit(BLUEPRINT_MAX_PER_USER);
  if (error) {
    return NextResponse.json(
      { error: blueprintStorageErrorMessage(error, "Blueprints could not be loaded.") },
      { status: 500 },
    );
  }

  const response: BlueprintListResponse = {
    blueprints: (data as BlueprintRow[]).map((row) =>
      rowToBlueprintSummary(row, sessionUser.id),
    ),
  };
  return NextResponse.json(response);
}

/**
 * The public shelf: anyone may browse, signed in or not. Sorting happens in
 * the database (the shelf can outgrow one page), search matches names and
 * descriptions, and each row carries the browser's own vote so the arrows
 * render already-lit.
 */
async function listPublicBlueprints(request: Request, url: URL) {
  const sortParam = url.searchParams.get("sort");
  const sort: PublicBlueprintSort =
    sortParam === "newest" || sortParam === "downloads" ? sortParam : "top";
  // The community search language (search-query.ts), which also scrubs the
  // characters that would let the text out of its or() filter.
  const search = parsePlanSearch(url.searchParams.get("search") ?? "");
  const page = Math.max(0, Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0);
  const deviceId = (url.searchParams.get("deviceId") ?? "").slice(0, 64);

  const db = getCommunityDb();
  let query = db
    .from("blueprints")
    .select(BLUEPRINT_SUMMARY_COLUMNS)
    .eq("is_public", true);
  // A plain term matches names, descriptions and tags; #tag narrows to tags,
  // @name to that creator.
  query = applyPlanSearch(query, search);
  if (sort === "top") {
    query = query.order("score", { ascending: false }).order("published_at", { ascending: false });
  } else if (sort === "downloads") {
    query = query
      .order("downloads", { ascending: false })
      .order("published_at", { ascending: false });
  } else {
    query = query.order("published_at", { ascending: false });
  }

  // One row past the page answers "is there more" without a second count query.
  const from = page * PUBLIC_BLUEPRINT_PAGE_SIZE;
  const { data, error } = await query.range(from, from + PUBLIC_BLUEPRINT_PAGE_SIZE);
  if (error) {
    return NextResponse.json(
      { error: blueprintStorageErrorMessage(error, "Public blueprints could not be loaded.") },
      { status: 500 },
    );
  }

  const rows = data as BlueprintRow[];
  const hasMore = rows.length > PUBLIC_BLUEPRINT_PAGE_SIZE;
  const sessionUser = await getSessionUser(request);
  const blueprints = rows
    .slice(0, PUBLIC_BLUEPRINT_PAGE_SIZE)
    .map((row) => rowToBlueprintSummary(row, sessionUser?.id));
  if (deviceId) {
    await attachMyBlueprintVotes(blueprints, await makeVoterKey(request, deviceId));
  }

  const response: BlueprintListResponse = { blueprints, hasMore };
  return NextResponse.json(response);
}

export async function POST(request: Request) {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }

  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign in to save blueprints." }, { status: 401 });
  }

  if (!(await checkRateLimit(`user:${sessionUser.id}`, "blueprint-save", 60, 60 * 60))) {
    return NextResponse.json(
      { error: "Blueprint save limit reached. Try again later." },
      { status: 429 },
    );
  }

  const read = await readJsonCapped(request, BLUEPRINT_BODY_MAX_BYTES);
  if (!read.ok) {
    return read.status === 413
      ? NextResponse.json({ error: "Blueprint is too large to save." }, { status: 413 })
      : NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const body = read.value;

  const { name, payload, needs, outputs, tags, icon, highestTier, highestTierIndex } =
    (body ?? {}) as {
      name?: unknown;
      payload?: unknown;
      needs?: unknown;
      outputs?: unknown;
      tags?: unknown;
      icon?: unknown;
      highestTier?: unknown;
      highestTierIndex?: unknown;
    };
  const normalizedTags = normalizeBlueprintTags(tags);
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName || trimmedName.length > BLUEPRINT_NAME_MAX_LENGTH) {
    return NextResponse.json(
      { error: `Blueprint names run 1–${BLUEPRINT_NAME_MAX_LENGTH} characters.` },
      { status: 400 },
    );
  }
  if (JSON.stringify(payload ?? null).length > BLUEPRINT_PAYLOAD_MAX_BYTES) {
    return NextResponse.json({ error: "Blueprint is too large to save." }, { status: 413 });
  }

  const parsedPayload = boardSelectionPayloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    return NextResponse.json({ error: "Blueprint payload is not valid." }, { status: 400 });
  }
  const captured = parsedPayload.data;
  if (captured.nodes.length + captured.storages.length + captured.pockets.length === 0) {
    return NextResponse.json({ error: "Blueprint has no cards in it." }, { status: 400 });
  }

  const db = getCommunityDb();
  const { count } = await db
    .from("blueprints")
    .select("id", { count: "exact", head: true })
    .eq("user_id", sessionUser.id);
  if ((count ?? 0) >= BLUEPRINT_MAX_PER_USER) {
    return NextResponse.json(
      { error: `Your blueprints are full (${BLUEPRINT_MAX_PER_USER}). Delete some first.` },
      { status: 409 },
    );
  }

  // Stats are always derived server-side from the validated payload.
  const { data, error } = await db
    .from("blueprints")
    .insert({
      user_id: sessionUser.id,
      name: trimmedName,
      payload: captured,
      node_count: captured.nodes.length,
      storage_count: captured.storages.length,
      edge_count: captured.edges.length,
      pocket_count: captured.pockets.length,
      machine_count: countBlueprintMachines(captured),
      needs: parseResourceStats(needs),
      outputs: parseResourceStats(outputs),
      tags: normalizedTags,
      tags_text: normalizedTags.join(" "),
      icon: parseEntryIcon(icon),
      highest_tier: parseHighestTier(highestTier),
      highest_tier_index: Number.isInteger(highestTierIndex) ? highestTierIndex : -1,
    })
    .select(BLUEPRINT_SUMMARY_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: blueprintStorageErrorMessage(error, "Blueprint could not be saved.") },
      { status: 500 },
    );
  }

  return NextResponse.json({
    blueprint: rowToBlueprintSummary(data as BlueprintRow, sessionUser.id),
  });
}
