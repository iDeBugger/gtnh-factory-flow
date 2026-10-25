import type { DbClient } from "./db";
import type { EntryIcon } from "@/lib/model/types";
import type { RemoteDesignMeta, RemoteFolder } from "@/lib/library/sync-types";
import { isMissingColumnError } from "./db";
import { parseEntryIcon } from "./community-rows";

/** Everything the list endpoint returns about a design: no plan. */
export const DESIGN_META_COLUMNS =
  "id,name,icon,folder_id,closed,favorite,sort_order,community_plan_id,created_at,updated_at,plan_updated_at,deleted_at";

export const FOLDER_COLUMNS = "id,name,created_at,updated_at,deleted_at";

/** What the live service keeps on a design (supabase/migrations/2026-10-14-cloud-live.sql). */
export const DESIGN_LIVE_COLUMNS = "seq,live_lease_until";

export interface DesignLiveRow extends DesignRow {
  seq?: number | string | null;
  live_lease_until?: string | null;
  plan?: unknown;
}

/**
 * One design's row, with its live columns and optionally its plan. A
 * database the cloud migration has not reached yet answers without the live
 * columns (`cloudColumns` false), so the library keeps working meanwhile.
 */
export async function readDesignRow(
  db: DbClient,
  ownerId: string,
  designId: string,
  withPlan: boolean,
): Promise<{ data: DesignLiveRow | null; error: { code?: string; message?: string } | null; cloudColumns: boolean }> {
  const plan = withPlan ? ",plan" : "";
  const read = (columns: string) =>
    db.from("library_designs").select(columns).eq("user_id", ownerId).eq("id", designId).maybeSingle();
  const first = await read(`${DESIGN_META_COLUMNS},${DESIGN_LIVE_COLUMNS}${plan}`);
  if (first.error && isMissingColumnError(first.error)) {
    const legacy = await read(`${DESIGN_META_COLUMNS}${plan}`);
    return { data: legacy.data as DesignLiveRow | null, error: legacy.error, cloudColumns: false };
  }
  return { data: first.data as DesignLiveRow | null, error: first.error, cloudColumns: true };
}

export interface DesignRow {
  id: string;
  name: string;
  icon: unknown;
  folder_id: string | null;
  closed: boolean;
  favorite: boolean;
  sort_order: number | null;
  community_plan_id: string | null;
  created_at: string;
  updated_at: string;
  plan_updated_at: string;
  deleted_at: string | null;
}

export interface FolderRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

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
