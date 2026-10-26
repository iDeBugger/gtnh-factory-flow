/** Pure helpers for the library: id and stamp checks and the rows as the API answers them. */
import type { EntryIcon } from "@/lib/model/types";
import type { RemoteDesignMeta, RemoteFolder } from "@/lib/library/sync-types";
import { parseEntryIcon } from "./community-rows";
import type { DesignRow } from "./repos/designs";
import type { FolderRow } from "./repos/folders";

export type { DesignRow, FolderRow };

export function rowToDesignMeta(row: DesignRow): RemoteDesignMeta {
  return {
    id: row.id,
    name: row.name,
    icon: parseEntryIcon(row.icon) as EntryIcon | null,
    folderId: row.folder_id,
    closed: row.closed,
    favorite: row.favorite === true,
    order: row.sort_order,
    communityPlanId: row.community_plan_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    planUpdatedAt: row.plan_updated_at,
    deletedAt: row.deleted_at,
  };
}

export function rowToFolder(row: FolderRow): RemoteFolder {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/** True for a well-formed ISO timestamp the client is allowed to stamp. */
export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** How far ahead of the server a device's clock may run before its stamps are refused. */
export const STAMP_SKEW_MS = 5 * 60_000;

/**
 * A stamp from a clock running ahead. Stamps are the client's and the newer
 * row wins, so one far-future stamp (a member's wrong clock, or on purpose)
 * would make every later save read as behind and the sync go silently quiet
 * on every device. Refused, never clamped: the device's local and pushed
 * stamps must agree or it reads as unsaved forever.
 */
export function isFutureStamp(value: string, now = Date.now()): boolean {
  return Date.parse(value) > now + STAMP_SKEW_MS;
}

/** What a device with a clock running ahead is told. */
export const CLOCK_AHEAD_MESSAGE = "This device's clock is ahead. Check its date and time.";

/** Ids are client-minted: a UUID, or the older `design-<base36>` form. */
export function isLibraryId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);
}
