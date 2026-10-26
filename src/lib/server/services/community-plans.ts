import { normalizeBlueprintTags } from "@/lib/blueprints/types";
import { computeCommunityPlanStats } from "@/lib/community/plan-stats";
import { parsePlanSearch } from "@/lib/community/search-query";
import {
  COMMUNITY_DESCRIPTION_MAX_LENGTH,
  COMMUNITY_NAME_MAX_LENGTH,
  type CommunityPlanListResponse,
  type CommunityPlanSort,
  type CommunityPlanSummary,
} from "@/lib/community/types";
import { normalizeLoadedProject } from "@/lib/model/project-normalize";
import { factoryProjectSchema } from "@/lib/model/schemas";
import { APP_VERSION } from "@/lib/version";
import { makeActorKey, makeVoterKey } from "../auth/keys";
import {
  parseEntryIcon,
  PLAN_SUMMARY_COLUMNS,
  rowToPlanSummary,
  type PlanRow,
} from "../community-rows";
import { getFileStore } from "../file-store";
import type { Viewer } from "../http/viewer";
import { checkRateLimit } from "../limits/rate-limit";
import { ensurePlanEngine, solvePlanStats } from "../plan-engine";
import { invalidatePlanListCache, readPlanListCache, writePlanListCache } from "../plan-list-cache";
import { PLAN_PREVIEW_BUCKET, PLAN_PREVIEW_MAX_SIDE, readPngHeader } from "../plan-preview";
import * as plans from "../repos/plans";
import { canSeePlan, isUuid, ownsPlan } from "./access";
import { fail, ok, type ServiceResult } from "./result";
import { attachMyVotes, readMyVotes } from "./votes";

/**
 * Community posts: the list, a post's page, sharing, editing and taking a
 * post down, and its counters. Who may see an unpublished post is
 * `canSeePlan`, here and everywhere. A post id that is no uuid is a missing
 * post, answered before any query.
 */

const PLAN_NOT_FOUND = "Plan not found.";

const SORT_COLUMNS: Record<
  CommunityPlanSort,
  { column: plans.PlanSortColumn; ascending: boolean; nullsLast?: boolean }
> = {
  new: { column: "created_at", ascending: false },
  top: { column: "score", ascending: false },
  downloads: { column: "downloads", ascending: false },
  views: { column: "views", ascending: false },
  machines: { column: "machine_count", ascending: false },
  nodes: { column: "node_count", ascending: false },
  power: { column: "total_eu_t", ascending: false },
  lowPower: { column: "total_eu_t", ascending: true },
  tier: { column: "highest_tier_index", ascending: false },
  comments: { column: "comment_count", ascending: false },
  // Posts nobody has commented on or touched sort after every post someone
  // has, whichever way the column is read.
  commented: { column: "last_comment_at", ascending: false, nullsLast: true },
  active: { column: "last_activity_at", ascending: false, nullsLast: true },
};

/** A list request as the route read it from the URL. */
export interface PlanListInput {
  sort: string;
  /** The search box's text as typed; the service parses it (`parsePlanSearch`). */
  search: string;
  /** NaN when absent. */
  maxTierIndex: number;
  page: number;
  pageSize: number;
  deviceId?: string;
  mineOnly: boolean;
  gameVersion: string;
  /** NaN when absent. */
  maxEuT: number;
  /** Comma-separated "kind:resourceId" keys, as sent. */
  makes: string;
  takes: string;
}

/** The list request in `params`: clamped page and page size, a capped version. */
export function readPlanListInput(params: URLSearchParams): PlanListInput {
  return {
    sort: params.get("sort") ?? "new",
    search: params.get("search") ?? "",
    maxTierIndex: Number.parseInt(params.get("maxTierIndex") ?? "", 10),
    page: Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1),
    pageSize: Math.min(60, Math.max(1, Number.parseInt(params.get("pageSize") ?? "24", 10) || 24)),
    deviceId: params.get("deviceId") ?? undefined,
    mineOnly: params.get("mine") === "1",
    gameVersion: params.get("gameVersion")?.slice(0, 60) ?? "",
    maxEuT: Number(params.get("maxEuT") ?? NaN),
    makes: params.get("makes") ?? "",
    takes: params.get("takes") ?? "",
  };
}

/**
 * Resource keys as "kind:resourceId"; a post must carry every one of them on
 * the named side. Capped so a URL cannot become a query bomb.
 */
function resourceKeys(raw: string): plans.PlanResourceKey[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^(item|fluid):[^,]{1,200}$/.test(entry))
    .slice(0, 8)
    .map((entry) => {
      const [kind, ...rest] = entry.split(":");
      return { kind: kind!, resourceId: rest.join(":") };
    });
}

/** A post's link and dates, for the sitemap. */
export interface PlanLinkRow {
  id: string;
  created_at: string;
  updated_at: string | null;
}

/**
 * The column lists a by-score read may ask for, by name: a closed set, so a
 * caller cannot pass a list whose rows do not match the type it gets back.
 */
const BY_SCORE_COLUMNS = {
  summary: PLAN_SUMMARY_COLUMNS,
  links: "id,created_at,updated_at",
} as const;

/** The rows each by-score column list reads. */
interface ByScoreRows {
  summary: PlanRow;
  links: PlanLinkRow;
}

/**
 * The published posts, best score first, up to `limit`: the posts the
 * sitemap and llms.txt name, pages a stranger can open. `summary` reads a
 * post's listing columns, `links` only its id and dates. Throws when the
 * database does not answer; both callers then list no post.
 */
export function publicPlansByScore<K extends keyof ByScoreRows>(
  limit: number,
  columns: K,
): Promise<ByScoreRows[K][]> {
  return plans.publicByScore<ByScoreRows[K]>(limit, BY_SCORE_COLUMNS[columns]);
}

/**
 * A page of posts: the public shelf, or the viewer's own. The public page
 * is the same rows for every reader, so it is served from memory for a
 * minute (plan-list-cache.ts); only what is personal (isMine, myVote) is
 * stamped on after. A reader's own posts are never cached: that list is
 * theirs alone and changes as they work. `noStore` is false only for the
 * empty Mine shelf of a reader who is not signed in.
 */
export async function listPlans(
  viewer: Viewer,
  input: PlanListInput,
  request: Request,
): Promise<ServiceResult<{ body: CommunityPlanListResponse; noStore: boolean }>> {
  const sort = SORT_COLUMNS[input.sort as CommunityPlanSort] ? (input.sort as CommunityPlanSort) : "new";
  // #tags stack, one @name is exact (underscores and all), the rest is free
  // text: see search-query.ts, which the library's box shares.
  const search = parsePlanSearch(input.search);
  const { page, pageSize, maxTierIndex, maxEuT, gameVersion, deviceId } = input;
  const makes = resourceKeys(input.makes);
  const takes = resourceKeys(input.takes);
  if (input.mineOnly && !viewer.userId) {
    return ok({ body: { plans: [], total: 0, page: 1, pageSize, gameVersions: [] }, noStore: false });
  }

  const { column, ascending, nullsLast } = SORT_COLUMNS[sort];
  const cacheKey = input.mineOnly
    ? undefined
    : [
        "public",
        sort,
        input.search,
        maxTierIndex,
        gameVersion,
        Number.isFinite(maxEuT) ? maxEuT : "",
        input.makes,
        input.takes,
        page,
        pageSize,
      ].join("|");
  const query: plans.PlanListQuery = {
    search,
    maxTierIndex: Number.isFinite(maxTierIndex) && maxTierIndex >= 0 ? maxTierIndex : undefined,
    gameVersion: gameVersion || undefined,
    maxEuT: Number.isFinite(maxEuT) && maxEuT >= 0 ? maxEuT : undefined,
    makes,
    takes,
    shelf:
      input.mineOnly && viewer.userId ? { kind: "mine", userId: viewer.userId } : { kind: "public" },
    sort: { column, ascending, nullsLast: nullsLast ?? false },
    offset: (page - 1) * pageSize,
    limit: pageSize,
  };

  // Distinct versions across the hub feed the filter dropdown; the set moves
  // once a release, so it is cached the same way.
  const loadVersions = async (): Promise<string[]> => {
    const cached = readPlanListCache<string[]>("versions");
    if (cached) {
      return cached;
    }
    const versions = await plans.distinctGameVersions();
    writePlanListCache("versions", versions);
    return versions;
  };

  const cached = cacheKey ? readPlanListCache<{ rows: PlanRow[]; total: number }>(cacheKey) : undefined;
  // What is not cached is fetched at once, side by side, not in turn.
  const [pageData, gameVersions, voterKey] = await Promise.all([
    cached ? Promise.resolve(cached) : plans.list(query),
    loadVersions(),
    deviceId ? makeVoterKey(request, deviceId) : Promise.resolve(undefined),
  ]);
  if (!cached && cacheKey) {
    writePlanListCache(cacheKey, pageData);
  }

  const summaries = pageData.rows.map((row) => rowToPlanSummary(row, viewer.userId));
  if (voterKey) {
    // A reader's votes are few and change only when they vote, which
    // empties the cache, so they ride the same minute.
    const votesKey = `votes|${voterKey}`;
    let votes = readPlanListCache<Map<string, 1 | -1>>(votesKey);
    if (!votes) {
      votes = await readMyVotes("plan", voterKey);
      writePlanListCache(votesKey, votes);
    }
    for (const plan of summaries) {
      plan.myVote = votes.get(plan.id);
    }
  }

  return ok({
    body: { plans: summaries, total: pageData.total, page, pageSize, gameVersions },
    noStore: true,
  });
}

/**
 * A post's page. A read that writes nothing but a stale stat card: a view
 * is counted by `countPlanView`. Unpublished posts exist only for whoever
 * `canSeePlan` admits.
 */
export async function readPlan(
  viewer: Viewer,
  planId: string,
  deviceId: string | undefined,
  request: Request,
): Promise<ServiceResult<{ plan: CommunityPlanSummary }>> {
  if (!isUuid(planId)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  const row = await plans.readSummary(planId);
  if (!row || !canSeePlan(viewer, row)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  const plan = rowToPlanSummary(row, viewer.userId);
  await refreshStaleStats(planId, plan);
  if (deviceId) {
    await attachMyVotes("plan", [plan], await makeVoterKey(request, deviceId));
  }
  return ok({ plan });
}

/**
 * Saved stat cards go stale as the solver changes. On open, recompute from
 * the stored plan JSON with this release's solver (once per plan per
 * release) and persist the result. Best effort: a missing stats_version
 * column, an unparseable plan or a failed write leave the saved card as is,
 * though freshly computed numbers still go out in this answer.
 */
async function refreshStaleStats(planId: string, plan: CommunityPlanSummary): Promise<void> {
  try {
    const version = await plans.readStatsVersion(planId);
    if (version === undefined || version === APP_VERSION) {
      return;
    }
    const parsed = factoryProjectSchema.safeParse(await plans.readPlanJson(planId));
    if (!parsed.success) {
      return;
    }

    // The same funnel the board runs a loaded plan through, so the card and
    // the opened tab compute from the identical project.
    const project = normalizeLoadedProject(parsed.data);
    await ensurePlanEngine(project);
    const solve = solvePlanStats(project);
    // The clock is not the plan: a stored card that solved before is better than the failed plan's.
    if (solve.outOfTime) {
      return;
    }
    const stats = computeCommunityPlanStats(project, solve.result);
    plan.needs = stats.needs;
    plan.outputs = stats.outputs;
    plan.totalEuT = stats.totalEuT;
    plan.machineCount = stats.machineCount;
    plan.nodeCount = stats.nodeCount;
    plan.storageCount = stats.storageCount;
    plan.edgeCount = stats.edgeCount;
    plan.highestTier = stats.highestTier;
    plan.highestTierIndex = stats.highestTierIndex;

    await plans.writeStats(planId, statsColumns(stats), APP_VERSION);
    invalidatePlanListCache();
  } catch {
    // A plan today's solver chokes on keeps its saved card.
  }
}

function statsColumns(stats: ReturnType<typeof computeCommunityPlanStats>): plans.PlanStatsColumns {
  return {
    needs: stats.needs,
    outputs: stats.outputs,
    total_eu_t: stats.totalEuT,
    machine_count: stats.machineCount,
    node_count: stats.nodeCount,
    storage_count: stats.storageCount,
    edge_count: stats.edgeCount,
    highest_tier: stats.highestTier ?? null,
    highest_tier_index: stats.highestTierIndex,
  };
}

/** A post body as the client sends it, to share or to edit. */
export interface PlanPostBody {
  name?: unknown;
  description?: unknown;
  gameVersion?: unknown;
  datasetVersionId?: unknown;
  plan?: unknown;
  tags?: unknown;
  isPublic?: unknown;
  icon?: unknown;
}

const NAME_REQUIRED = "Plan name is required (max 80 chars).";
const PLAN_INVALID = "Plan JSON is not a valid project.";
const PLAN_EMPTY = "Refusing to share an empty plan.";

/**
 * Shares a plan to the community. Stats are always derived server-side from
 * the validated plan, as the plan board runs it: there is one mode, so an
 * older plan is converted first (the stored plan stays as uploaded).
 */
export async function publishPlan(
  viewer: Viewer,
  body: PlanPostBody,
  request: Request,
): Promise<ServiceResult<{ id: string }>> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > COMMUNITY_NAME_MAX_LENGTH) {
    return fail("bad-request", NAME_REQUIRED);
  }
  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, COMMUNITY_DESCRIPTION_MAX_LENGTH)
      : "";
  const gameVersion = typeof body.gameVersion === "string" ? body.gameVersion.slice(0, 60) : "";
  const datasetVersionId =
    typeof body.datasetVersionId === "string" ? body.datasetVersionId.slice(0, 120) : "";

  if (!viewer.userId || viewer.username === undefined) {
    return fail("unauthorized", "Sign in to share plans to the community.");
  }

  const tags = normalizeBlueprintTags(body.tags);
  const parsedPlan = factoryProjectSchema.safeParse(body.plan);
  if (!parsedPlan.success) {
    return fail("bad-request", PLAN_INVALID);
  }
  const project = parsedPlan.data;
  if (project.nodes.length === 0) {
    return fail("bad-request", PLAN_EMPTY);
  }

  // Keyed on the account, like every other signed-in write: each post costs
  // a server-side solve and a few MB of storage, and a key the client could
  // vary would make the limit nothing at all.
  if (!(await checkRateLimit(`user:${viewer.userId}`, "upload", 10, 60 * 60))) {
    return fail("rate-limited", "Upload rate limit reached. Try again later.");
  }

  const solved = normalizeLoadedProject(project);
  await ensurePlanEngine(solved);
  const stats = computeCommunityPlanStats(solved, solvePlanStats(solved).result);
  const id = await plans.insert({
    user_id: viewer.userId,
    author_name: viewer.username,
    name,
    description,
    game_version: gameVersion,
    dataset_version: datasetVersionId,
    plan: project,
    tags,
    tags_text: tags.join(" "),
    icon: parseEntryIcon(body.icon),
    ...statsColumns(stats),
    stats_version: APP_VERSION,
    uploader_key: makeActorKey(request),
  });
  invalidatePlanListCache();
  return ok({ id });
}

/**
 * Updates the viewer's own post in place, field by field: the share dialog
 * re-sends everything, while the shelf's tag editor sends tags alone, with
 * no need to round-trip the plan JSON just to relabel a post.
 */
export async function editPlan(
  viewer: Viewer,
  planId: string,
  body: PlanPostBody,
): Promise<ServiceResult<{ id: string }>> {
  if (!viewer.userId) {
    return fail("unauthorized", "Sign in to update your post.");
  }
  const existing = isUuid(planId) ? await plans.readOwner(planId) : undefined;
  if (!existing) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  if (existing.user_id !== viewer.userId) {
    return fail("forbidden", "You don't own this post.");
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: now, last_activity_at: now };
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > COMMUNITY_NAME_MAX_LENGTH) {
      return fail("bad-request", NAME_REQUIRED);
    }
    update.name = name;
  }
  if (body.description !== undefined) {
    update.description =
      typeof body.description === "string"
        ? body.description.trim().slice(0, COMMUNITY_DESCRIPTION_MAX_LENGTH)
        : "";
  }
  if (body.gameVersion !== undefined) {
    update.game_version = typeof body.gameVersion === "string" ? body.gameVersion.slice(0, 60) : "";
  }
  if (body.datasetVersionId !== undefined) {
    update.dataset_version =
      typeof body.datasetVersionId === "string" ? body.datasetVersionId.slice(0, 120) : "";
  }
  if (body.tags !== undefined) {
    const tags = normalizeBlueprintTags(body.tags);
    update.tags = tags;
    update.tags_text = tags.join(" ");
  }
  if (typeof body.isPublic === "boolean") {
    update.is_public = body.isPublic;
  }
  if (body.icon !== undefined) {
    // A valid icon sets it; null (or junk) clears it.
    update.icon = parseEntryIcon(body.icon);
  }
  if (body.plan !== undefined) {
    const parsedPlan = factoryProjectSchema.safeParse(body.plan);
    if (!parsedPlan.success) {
      return fail("bad-request", PLAN_INVALID);
    }
    const project = parsedPlan.data;
    if (project.nodes.length === 0) {
      return fail("bad-request", PLAN_EMPTY);
    }
    const solved = normalizeLoadedProject(project);
    await ensurePlanEngine(solved);
    const stats = computeCommunityPlanStats(solved, solvePlanStats(solved).result);
    Object.assign(update, { plan: project, ...statsColumns(stats), stats_version: APP_VERSION });
  }

  await plans.update(planId, viewer.userId, update);
  invalidatePlanListCache();
  return ok({ id: planId });
}

/** Takes a post down: its owner, an admin account, or the admin header. Its board photograph goes with it. */
export async function deletePlan(viewer: Viewer, planId: string): Promise<ServiceResult<{ ok: true }>> {
  if (!viewer.adminToken && !viewer.userId) {
    return fail("unauthorized", "Sign in to take down your post.");
  }
  if (!isUuid(planId)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  if (!viewer.adminToken) {
    const existing = await plans.readOwner(planId);
    if (!existing) {
      return fail("not-found", PLAN_NOT_FOUND);
    }
    if (existing.user_id !== viewer.userId && !viewer.isAdmin) {
      return fail("forbidden", "You don't own this post.");
    }
  }

  await plans.remove(planId);
  // Best effort: a missing object (posts from before previews) is the normal case, not a failure.
  await getFileStore()
    .remove(PLAN_PREVIEW_BUCKET, [`${planId}.png`])
    .catch(() => undefined);
  invalidatePlanListCache();
  return ok({ ok: true });
}

/** Views one address may count in a minute: a loop runs a counter up no faster than this. */
const VIEWS_PER_MINUTE = 60;

/**
 * Counts one view of a post. A write of its own, so no read of the post
 * changes anything: a read must be safe to repeat. Throws when the database
 * fails.
 */
export async function countPlanView(
  viewer: Viewer,
  planId: string,
  request: Request,
): Promise<ServiceResult<{ views: number }>> {
  // Before the rate limit: a malformed id sends no query at all.
  if (!isUuid(planId)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  if (!(await checkRateLimit(makeActorKey(request), "view", VIEWS_PER_MINUTE, 60))) {
    return fail("rate-limited", "Too many requests. Slow down.");
  }
  const row = await plans.readViews(planId);
  if (!row || !canSeePlan(viewer, row)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  const views = row.views + 1;
  await plans.writeViews(planId, views);
  return ok({ views });
}

/** The full plan JSON of a post the viewer may see, counting the download. */
export async function downloadPlan(
  viewer: Viewer,
  planId: string,
): Promise<ServiceResult<{ name: string; plan: unknown }>> {
  if (!isUuid(planId)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  const row = await plans.readDownload(planId);
  if (!row || !canSeePlan(viewer, row)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  await plans.writeDownloads(planId, row.downloads + 1);
  return ok({ name: row.name, plan: row.plan });
}

const NO_PREVIEW = "No preview.";

/**
 * Whether the viewer may look at a post's board photograph: a public post's
 * is the picture every chat unfurl shows; an unpublished post's is for
 * whoever `canSeePlan` admits, and refused as a post with no picture.
 */
export async function previewAccess(
  viewer: Viewer,
  planId: string,
): Promise<ServiceResult<{ unpublished: boolean }>> {
  if (!isUuid(planId)) {
    return fail("not-found", NO_PREVIEW);
  }
  const row = await plans.readAccess(planId).catch(() => undefined);
  if (!row || !canSeePlan(viewer, row)) {
    return fail("not-found", NO_PREVIEW);
  }
  return ok({ unpublished: row.is_public === false });
}

/**
 * Whether the viewer may stamp a post's board photograph: its owner or an
 * admin account. Unlike board images this picture becomes the post's public
 * face in every chat the link is pasted into.
 */
export async function previewUploadAccess(
  viewer: Viewer,
  planId: string,
): Promise<ServiceResult<{ userId: string; planId: string }>> {
  if (!viewer.userId) {
    return fail("unauthorized", "Sign in to update your post.");
  }
  const existing = isUuid(planId) ? await plans.readOwner(planId) : undefined;
  if (!existing) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  if (!ownsPlan(viewer, existing) && !viewer.isAdmin) {
    return fail("forbidden", "You don't own this post.");
  }
  // The stored row's id names the object, whatever case the request spelled it in.
  return ok({ userId: viewer.userId, planId: existing.id });
}

const PREVIEWS_PER_HOUR = 30;

/**
 * Stores a post's board photograph at the post's id, overwriting the last
 * one. The card trusts the PNG's header for its size, so the header must be
 * a real IHDR with both sides within `PLAN_PREVIEW_MAX_SIDE`. An account
 * gets a few dozen an hour, counted after the checks so junk spends no share.
 */
export async function storePlanPreview(
  userId: string,
  planId: string,
  bytes: Uint8Array,
): Promise<ServiceResult<{ ok: true }>> {
  if (!readPngHeader(bytes)) {
    return fail(
      "bad-request",
      `The preview must be a PNG of at most ${PLAN_PREVIEW_MAX_SIDE} by ${PLAN_PREVIEW_MAX_SIDE} pixels.`,
      { status: 415 },
    );
  }
  if (!(await checkRateLimit(`user:${userId}`, "plan-preview", PREVIEWS_PER_HOUR, 60 * 60))) {
    return fail("rate-limited", "Too many preview uploads: try again in a little while.");
  }
  try {
    await getFileStore().put(PLAN_PREVIEW_BUCKET, `${planId}.png`, bytes, { overwrite: true });
  } catch (error) {
    console.error("Preview upload failed.", error);
    return fail("unavailable", "Preview upload failed.", { status: 500 });
  }
  return ok({ ok: true });
}
