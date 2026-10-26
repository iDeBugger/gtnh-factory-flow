import {
  BLUEPRINT_DESCRIPTION_MAX_LENGTH,
  BLUEPRINT_MAX_PER_USER,
  BLUEPRINT_NAME_MAX_LENGTH,
  BLUEPRINT_PAYLOAD_MAX_BYTES,
  normalizeBlueprintTags,
  PUBLIC_BLUEPRINT_PAGE_SIZE,
  type BlueprintListResponse,
  type BlueprintSummary,
  type PublicBlueprintSort,
} from "@/lib/blueprints/types";
import { parsePlanSearch } from "@/lib/community/search-query";
import { boardSelectionPayloadSchema } from "@/lib/model/schemas";
import { makeVoterKey } from "../auth/keys";
import {
  countBlueprintMachines,
  parseHighestTier,
  parseResourceStats,
  rowToBlueprintSummary,
} from "../blueprints";
import { parseEntryIcon } from "../community-rows";
import { isDatabaseDown, isDatabaseError, storageErrorMessage, withTransaction } from "../db";
import type { SignedIn, Viewer } from "../http/viewer";
import { checkRateLimit } from "../limits/rate-limit";
import * as accounts from "../repos/accounts";
import * as blueprints from "../repos/blueprints";
import { canReadBlueprint, isUuid } from "./access";
import { fail, ok, type ServiceResult } from "./result";
import { attachMyVotes } from "./votes";

/**
 * Blueprints: an account's saved board selections, and the public shelf
 * once their owners publish them. A blueprint is its owner's, or anyone's
 * to read once it is public and the community switch is on
 * (`canReadBlueprint`). Only the owner edits, publishes or deletes one;
 * ownership is always the session's account, never a client-supplied
 * owner. An id that is no uuid is a missing blueprint, answered before any
 * query.
 *
 * The routes gate (the community switch, configured, signed in) and read
 * the body; these take the viewer.
 */

const BLUEPRINT_NOT_FOUND = "Blueprint not found.";
const TOO_LARGE = "Blueprint is too large to save.";
const NAME_LENGTH = `Blueprint names run 1–${BLUEPRINT_NAME_MAX_LENGTH} characters.`;

/**
 * What a database failure the route answered with its own sentence says: the
 * database-down line, or the sentence (the database's message goes to the
 * log). Anything else is a bug and is thrown on.
 */
function storageFailure(error: unknown, fallback: string): ServiceResult<never> {
  const down = isDatabaseDown(error);
  if (!down && !isDatabaseError(error)) {
    throw error;
  }
  if (!down) {
    console.error(fallback, error);
  }
  return fail("unavailable", storageErrorMessage(error, fallback), { status: 500 });
}

/** The account's blueprint writes are paced per account. */
async function paced(
  viewer: SignedIn,
  action: string,
  limit: number,
  message: string,
): Promise<ServiceResult<void>> {
  if (!(await checkRateLimit(`user:${viewer.userId}`, action, limit, 60 * 60))) {
    return fail("rate-limited", message);
  }
  return ok(undefined);
}

/** Whether the account may save another blueprint now: 60 an hour. */
export function blueprintSaveAllowed(viewer: SignedIn): Promise<ServiceResult<void>> {
  return paced(viewer, "blueprint-save", 60, "Blueprint save limit reached. Try again later.");
}

/** Whether the account may edit a blueprint now: 60 an hour. */
export function blueprintEditAllowed(viewer: SignedIn): Promise<ServiceResult<void>> {
  return paced(viewer, "blueprint-update", 60, "Editing too fast. Try again later.");
}

/** Whether the account may publish or pull back a blueprint now: 30 an hour. */
export function blueprintPublishAllowed(viewer: SignedIn): Promise<ServiceResult<void>> {
  return paced(viewer, "blueprint-publish", 30, "Publishing too fast. Try again later.");
}

/** A shelf request as the route read it from the URL. */
export type BlueprintListInput =
  | { shelf: "mine" }
  | { shelf: "public"; sort: string | null; search: string; page: string | null; deviceId: string };

/**
 * The account's own blueprints, newest first; or the public shelf, which
 * anyone may browse, signed in or not, each row carrying the browser's own
 * vote so the arrows render already lit.
 */
export async function listBlueprints(
  viewer: Viewer,
  input: BlueprintListInput,
  request: Request,
): Promise<ServiceResult<BlueprintListResponse>> {
  if (input.shelf === "public") {
    return listPublic(viewer, input, request);
  }
  if (!viewer.userId) {
    return fail("unauthorized", "Sign in to use blueprints.");
  }
  let rows;
  try {
    rows = await blueprints.listOwn(viewer.userId, BLUEPRINT_MAX_PER_USER);
  } catch (error) {
    return storageFailure(error, "Blueprints could not be loaded.");
  }
  return ok({ blueprints: rows.map((row) => rowToBlueprintSummary(row, viewer.userId)) });
}

async function listPublic(
  viewer: Viewer,
  input: Extract<BlueprintListInput, { shelf: "public" }>,
  request: Request,
): Promise<ServiceResult<BlueprintListResponse>> {
  const sort: PublicBlueprintSort =
    input.sort === "newest" || input.sort === "downloads" ? input.sort : "top";
  // The community search language (search-query.ts), read as the community
  // list reads it: the same terms, matched by the same conditions.
  const search = parsePlanSearch(input.search);
  const page = Math.max(0, Number.parseInt(input.page ?? "0", 10) || 0);
  const deviceId = input.deviceId.slice(0, 64);

  // One row past the page answers "is there more" without a second count query.
  let rows;
  try {
    rows = await blueprints.listPublic({
      search,
      sort,
      offset: page * PUBLIC_BLUEPRINT_PAGE_SIZE,
      limit: PUBLIC_BLUEPRINT_PAGE_SIZE + 1,
    });
  } catch (error) {
    return storageFailure(error, "Public blueprints could not be loaded.");
  }

  const hasMore = rows.length > PUBLIC_BLUEPRINT_PAGE_SIZE;
  const summaries = rows
    .slice(0, PUBLIC_BLUEPRINT_PAGE_SIZE)
    .map((row) => rowToBlueprintSummary(row, viewer.userId));
  if (deviceId) {
    await attachMyVotes("blueprint", summaries, await makeVoterKey(request, deviceId));
  }
  return ok({ blueprints: summaries, hasMore });
}

export type BlueprintWithPayload = BlueprintSummary & { payload: unknown };

/**
 * The full payload, fetched only when a blueprint is actually placed: by its
 * owner, or by anyone once it is public and the community switch is on.
 * Counts nothing (the counted path is `downloadBlueprint`).
 */
export async function readBlueprint(
  viewer: Viewer,
  blueprintId: string,
  communityOn: boolean,
): Promise<ServiceResult<{ blueprint: BlueprintWithPayload }>> {
  // With the switch off an anonymous viewer may read no blueprint at all.
  if (!isUuid(blueprintId) || (!viewer.userId && !communityOn)) {
    return fail("not-found", BLUEPRINT_NOT_FOUND);
  }
  let row;
  try {
    row = await blueprints.readReadable(blueprintId, viewer, communityOn);
  } catch (error) {
    return storageFailure(error, "Blueprint could not be loaded.");
  }
  if (!row || !canReadBlueprint(viewer, row, communityOn)) {
    return fail("not-found", BLUEPRINT_NOT_FOUND);
  }
  return ok({
    blueprint: { ...rowToBlueprintSummary(row, viewer.userId), payload: row.payload },
  });
}

/** A save or edit body as sent. */
export interface BlueprintBody {
  name?: unknown;
  payload?: unknown;
  needs?: unknown;
  outputs?: unknown;
  tags?: unknown;
  icon?: unknown;
  highestTier?: unknown;
  highestTierIndex?: unknown;
}

/**
 * The payload and the stat columns it fills, or the refusal. Stats are
 * always derived server-side from the validated payload; the stat card is
 * the client's, and anything in it that does not parse is dropped.
 */
function readContent(body: BlueprintBody): ServiceResult<blueprints.BlueprintContentColumns> {
  if (JSON.stringify(body.payload ?? null).length > BLUEPRINT_PAYLOAD_MAX_BYTES) {
    return fail("too-large", TOO_LARGE);
  }
  const parsedPayload = boardSelectionPayloadSchema.safeParse(body.payload);
  if (!parsedPayload.success) {
    return fail("bad-request", "Blueprint payload is not valid.");
  }
  const captured = parsedPayload.data;
  if (captured.nodes.length + captured.storages.length + captured.pockets.length === 0) {
    return fail("bad-request", "Blueprint has no cards in it.");
  }
  return ok({
    payload: captured,
    node_count: captured.nodes.length,
    storage_count: captured.storages.length,
    edge_count: captured.edges.length,
    pocket_count: captured.pockets.length,
    machine_count: countBlueprintMachines(captured),
    needs: parseResourceStats(body.needs),
    outputs: parseResourceStats(body.outputs),
    highest_tier: parseHighestTier(body.highestTier),
    highest_tier_index: Number.isInteger(body.highestTierIndex) ? (body.highestTierIndex as number) : -1,
  });
}

/**
 * Saves a new blueprint to the account, up to `BLUEPRINT_MAX_PER_USER`. The
 * count and the insert are one transaction after the account's row lock, so
 * saves at once meet the cap one at a time and never pass it together.
 */
export async function saveBlueprint(
  viewer: SignedIn,
  body: BlueprintBody,
): Promise<ServiceResult<{ blueprint: BlueprintSummary }>> {
  const tags = normalizeBlueprintTags(body.tags);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > BLUEPRINT_NAME_MAX_LENGTH) {
    return fail("bad-request", NAME_LENGTH);
  }
  const content = readContent(body);
  if (!content.ok) {
    return content;
  }

  let row;
  try {
    row = await withTransaction(async (tx) => {
      await accounts.lockAccount(viewer.userId, tx);
      if ((await blueprints.countOwn(viewer.userId, tx)) >= BLUEPRINT_MAX_PER_USER) {
        return undefined;
      }
      return blueprints.insert(
        {
          user_id: viewer.userId,
          name,
          ...content.value,
          tags,
          tags_text: tags.join(" "),
          icon: parseEntryIcon(body.icon),
        },
        tx,
      );
    });
  } catch (error) {
    return storageFailure(error, "Blueprint could not be saved.");
  }
  if (!row) {
    return fail("conflict", `Your blueprints are full (${BLUEPRINT_MAX_PER_USER}). Delete some first.`);
  }
  return ok({ blueprint: rowToBlueprintSummary(row, viewer.userId) });
}

/**
 * Edits a blueprint in place: the row keeps its id, votes, downloads and
 * publish state, so an author refreshes a published build without losing
 * the standing it earned. `name` renames; `payload` (with its stat card)
 * overwrites the content. Owner only: anyone else's blueprint matches
 * nothing and reads as missing.
 */
export async function updateBlueprint(
  viewer: SignedIn,
  blueprintId: string,
  body: BlueprintBody,
): Promise<ServiceResult<{ blueprint: BlueprintSummary }>> {
  const patch: blueprints.BlueprintPatch = {};
  if (body.tags !== undefined) {
    const tags = normalizeBlueprintTags(body.tags);
    patch.tags = tags;
    patch.tags_text = tags.join(" ");
  }
  if (body.icon !== undefined) {
    // A valid icon sets it; null (or junk) clears it.
    patch.icon = parseEntryIcon(body.icon);
  }
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > BLUEPRINT_NAME_MAX_LENGTH) {
      return fail("bad-request", NAME_LENGTH);
    }
    patch.name = name;
  }
  if (body.payload !== undefined) {
    const content = readContent(body);
    if (!content.ok) {
      return content;
    }
    Object.assign(patch, content.value);
  }
  if (Object.keys(patch).length === 0) {
    return fail("bad-request", "Nothing to change.");
  }
  if (!isUuid(blueprintId)) {
    return fail("not-found", BLUEPRINT_NOT_FOUND);
  }

  let row;
  try {
    row = await blueprints.updateOwn(blueprintId, viewer.userId, patch);
  } catch (error) {
    return storageFailure(error, "Blueprint could not be updated.");
  }
  if (!row) {
    return fail("not-found", BLUEPRINT_NOT_FOUND);
  }
  return ok({ blueprint: rowToBlueprintSummary(row, viewer.userId) });
}

/** A publish body as sent. */
export interface BlueprintPublishBody {
  publish?: unknown;
  description?: unknown;
}

/**
 * Publishes a blueprint to the network, or pulls it back. Owner only. The
 * payload never changes: publishing stamps visibility, the author's name,
 * an optional description and the publish time. Votes survive an
 * unpublish and republish; a deleted blueprint takes them with it.
 */
export async function publishBlueprint(
  viewer: SignedIn,
  blueprintId: string,
  body: BlueprintPublishBody,
): Promise<ServiceResult<{ blueprint: BlueprintSummary }>> {
  if (typeof body.publish !== "boolean") {
    return fail("bad-request", "Invalid publish request.");
  }
  if (!isUuid(blueprintId)) {
    return fail("not-found", BLUEPRINT_NOT_FOUND);
  }
  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, BLUEPRINT_DESCRIPTION_MAX_LENGTH)
      : undefined;
  const patch: blueprints.BlueprintPatch = body.publish
    ? {
        is_public: true,
        author_name: viewer.username,
        published_at: new Date().toISOString(),
        ...(description !== undefined ? { description } : undefined),
      }
    : { is_public: false };

  let row;
  try {
    row = await blueprints.updateOwn(blueprintId, viewer.userId, patch);
  } catch (error) {
    return storageFailure(error, "Publishing failed.");
  }
  if (!row) {
    return fail("not-found", BLUEPRINT_NOT_FOUND);
  }
  return ok({ blueprint: rowToBlueprintSummary(row, viewer.userId) });
}

/**
 * Deletes the owner's blueprint. Deleting one that is not there, or not the
 * viewer's, changes nothing and answers the same, as does an id that could
 * name no blueprint.
 */
export async function deleteBlueprint(
  viewer: SignedIn,
  blueprintId: string,
): Promise<ServiceResult<{ ok: true }>> {
  if (!isUuid(blueprintId)) {
    return ok({ ok: true });
  }
  try {
    await blueprints.deleteOwn(blueprintId, viewer.userId);
  } catch (error) {
    return storageFailure(error, "Blueprint could not be deleted.");
  }
  return ok({ ok: true });
}

/**
 * A public blueprint's payload for placing, counting the download in the
 * same statement. Authors placing their own published work do not inflate
 * their own counter: the mine shelf places through `readBlueprint`, and an
 * owner here is not counted either.
 */
export async function downloadBlueprint(
  viewer: Viewer,
  blueprintId: string,
): Promise<ServiceResult<{ blueprint: BlueprintWithPayload }>> {
  if (!isUuid(blueprintId)) {
    return fail("not-found", BLUEPRINT_NOT_FOUND);
  }
  let row;
  try {
    row = await blueprints.takeDownload(blueprintId, viewer);
  } catch (error) {
    return storageFailure(error, "Blueprint could not be loaded.");
  }
  if (!row) {
    return fail("not-found", BLUEPRINT_NOT_FOUND);
  }
  return ok({
    blueprint: { ...rowToBlueprintSummary(row, viewer.userId), payload: row.payload },
  });
}
