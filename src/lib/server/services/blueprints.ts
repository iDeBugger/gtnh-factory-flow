import {
  BLUEPRINT_MAX_PER_USER,
  BLUEPRINT_NAME_MAX_LENGTH,
  BLUEPRINT_PAYLOAD_MAX_BYTES,
  normalizeBlueprintTags,
  type BlueprintListResponse,
  type BlueprintSummary,
} from "@/lib/blueprints/types";
import { boardSelectionPayloadSchema } from "@/lib/model/schemas";
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
import { isUuid } from "./access";
import { fail, ok, type ServiceResult } from "./result";

/**
 * Blueprints: an account's saved board selections, its own alone. Only the
 * owner reads, edits or deletes one; ownership is always the session's
 * account, never a client-supplied owner, and anyone else's blueprint reads
 * as missing. An id that is no uuid is a missing blueprint, answered before
 * any query.
 *
 * The routes gate (configured, signed in) and read the body; these take the
 * viewer.
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

/** The account's own blueprints, newest first. */
export async function listBlueprints(viewer: Viewer): Promise<ServiceResult<BlueprintListResponse>> {
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

export type BlueprintWithPayload = BlueprintSummary & { payload: unknown };

/**
 * The full payload, fetched only when a blueprint is actually placed, by its
 * owner. Anyone else, signed in or not, finds no such blueprint, with no
 * query sent for a viewer with no account.
 */
export async function readBlueprint(
  viewer: Viewer,
  blueprintId: string,
): Promise<ServiceResult<{ blueprint: BlueprintWithPayload }>> {
  if (!isUuid(blueprintId) || !viewer.userId) {
    return fail("not-found", BLUEPRINT_NOT_FOUND);
  }
  let row;
  try {
    row = await blueprints.readOwn(blueprintId, viewer.userId);
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
 * Edits a blueprint in place: the row keeps its id. `name` renames;
 * `payload` (with its stat card) overwrites the content. Owner only: anyone else's blueprint matches
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
