import type { LivePlan } from "@/lib/live/ops";
import { DbQueryError, getCommunityDb, isMissingColumnError, type Tx } from "../db";

/**
 * Library designs: one row per owner and id, tombstoned on delete, and the
 * live lease. While `live_lease_until` is in the future the live service is
 * the plan's only writer; every renewal, flush and release is conditional on
 * its token and skips tombstones, and a REST plan save lands only while the
 * lease is free and clears the token. Every write to `plan`, `seq`,
 * `live_lease_until` and `live_lease_token` in the codebase is in this file.
 */

/** Everything the list endpoint returns about a design: no plan. */
const DESIGN_META_COLUMNS =
  "id,name,icon,folder_id,closed,favorite,sort_order,community_plan_id,created_at,updated_at,plan_updated_at,deleted_at";

/** What the live service keeps on a design (supabase/migrations/2026-10-14-cloud-live.sql). */
const DESIGN_LIVE_COLUMNS = "seq,live_lease_until";

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

export interface DesignLiveRow extends DesignRow {
  seq?: number | string | null;
  live_lease_until?: string | null;
  plan?: unknown;
}

/** A row as the insert writes it. */
export interface NewDesignRow {
  user_id: string;
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
  deleted_at: null;
  plan: unknown;
}

/** What the owner's save writes: everything but the key; the plan only when it rides. */
export type OwnerDesignPatch = Omit<NewDesignRow, "user_id" | "id" | "plan"> & {
  user_id: string;
  id: string;
  plan?: unknown;
};

/** What a member's save writes: the plan's name and stamps, and the plan when it rides. */
export interface MemberDesignPatch {
  name: string;
  updated_at: string;
  plan_updated_at: string;
  plan?: unknown;
}

/** How a write conditional on the lease went. */
export type LeaseOutcome =
  /** Written: the lease is still this room's. */
  | "held"
  /** The design is missing or deleted. */
  | "gone"
  /** The design is there, but its lease is no longer this room's. */
  | "lost";

const db = () => getCommunityDb();

/** The owner's designs, tombstones included, newest edit first. Throws `DbQueryError`. */
export async function listOwn(userId: string, limit: number, _tx?: Tx): Promise<DesignRow[]> {
  const { data, error } = await db()
    .from("library_designs")
    .select(DESIGN_META_COLUMNS)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? []) as unknown as DesignRow[];
}

/**
 * The live designs shared with `memberId`: the rows behind `pairs`, the
 * member's own memberships, and no other owner's design that shares an id
 * with one of them. Throws `DbQueryError`.
 */
export async function sharedWith(
  _memberId: string,
  pairs: ReadonlyArray<{ ownerId: string; designId: string }>,
  _tx?: Tx,
): Promise<Array<DesignRow & { user_id: string }>> {
  if (pairs.length === 0) {
    return [];
  }
  const owners = [...new Set(pairs.map((pair) => pair.ownerId))];
  const ids = [...new Set(pairs.map((pair) => pair.designId))];
  const wanted = new Set(pairs.map((pair) => `${pair.ownerId}:${pair.designId}`));
  const { data, error } = await db()
    .from("library_designs")
    .select(`user_id,${DESIGN_META_COLUMNS}`)
    .in("user_id", owners)
    .in("id", ids)
    .is("deleted_at", null);
  if (error) {
    throw new DbQueryError(error);
  }
  return ((data ?? []) as unknown as Array<DesignRow & { user_id: string }>).filter((row) =>
    wanted.has(`${row.user_id}:${row.id}`),
  );
}

/**
 * One design's row, with its live columns and optionally its plan. A
 * database the cloud migration has not reached yet answers without the live
 * columns (`cloudColumns` false), so the library keeps working meanwhile.
 * Throws `DbQueryError`.
 */
export async function read(
  ownerId: string,
  designId: string,
  opts: { withPlan: boolean; forUpdate?: boolean },
  _tx?: Tx,
): Promise<{ row: DesignLiveRow | undefined; cloudColumns: boolean }> {
  const plan = opts.withPlan ? ",plan" : "";
  const select = (columns: string) =>
    db()
      .from("library_designs")
      .select(columns)
      .eq("user_id", ownerId)
      .eq("id", designId)
      .maybeSingle();
  const first = await select(`${DESIGN_META_COLUMNS},${DESIGN_LIVE_COLUMNS}${plan}`);
  if (first.error && isMissingColumnError(first.error)) {
    const legacy = await select(`${DESIGN_META_COLUMNS}${plan}`);
    if (legacy.error) {
      throw new DbQueryError(legacy.error);
    }
    return { row: (legacy.data ?? undefined) as DesignLiveRow | undefined, cloudColumns: false };
  }
  if (first.error) {
    throw new DbQueryError(first.error);
  }
  return { row: (first.data ?? undefined) as DesignLiveRow | undefined, cloudColumns: true };
}

/** The owner's live (not tombstoned) designs; a failed count reads as none, as the cap always has. */
export async function countLive(userId: string, _tx?: Tx): Promise<number> {
  const { count } = await db()
    .from("library_designs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("deleted_at", null);
  return count ?? 0;
}

/** A new design; answers its metadata. Throws `DbQueryError`. */
export async function insert(row: NewDesignRow, _tx?: Tx): Promise<DesignRow> {
  const { data, error } = await db()
    .from("library_designs")
    .insert(row)
    .select(DESIGN_META_COLUMNS)
    .single();
  if (error || !data) {
    throw new DbQueryError(error);
  }
  return data as unknown as DesignRow;
}

/**
 * Writes a save over an existing design. With `requireLeaseFree` (a plan
 * rides and the live columns exist) the write lands only while no live lease
 * is held at `now`, and it clears the token, so a lapsed lease's room cannot
 * write over this plan. Undefined when nothing matched: the live service took
 * the lease since the caller read the row. Throws `DbQueryError`.
 */
async function save(
  ownerId: string,
  designId: string,
  patch: Record<string, unknown>,
  opts: { requireLeaseFree: boolean; now: string },
): Promise<DesignRow | undefined> {
  const row = { ...patch };
  if (patch.plan !== undefined && opts.requireLeaseFree) {
    row.live_lease_token = null;
  }
  const update = db().from("library_designs").update(row).eq("user_id", ownerId).eq("id", designId);
  const unleased = opts.requireLeaseFree
    ? update.or(`live_lease_until.is.null,live_lease_until.lt.${opts.now}`)
    : update;
  const { data, error } = await unleased.select(DESIGN_META_COLUMNS).maybeSingle();
  if (error) {
    throw new DbQueryError(error);
  }
  return (data ?? undefined) as DesignRow | undefined;
}

/** The owner's save of an existing design (see `save`). Writing a design brings it back from a tombstone. */
export function saveAsOwner(
  ownerId: string,
  designId: string,
  patch: OwnerDesignPatch,
  opts: { requireLeaseFree: boolean; now: string },
  _tx?: Tx,
): Promise<DesignRow | undefined> {
  return save(ownerId, designId, { ...patch }, opts);
}

/** A member's save: the plan and its name and stamps only (see `save`). */
export function saveAsMember(
  ownerId: string,
  designId: string,
  patch: MemberDesignPatch,
  opts: { requireLeaseFree: boolean; now: string },
  _tx?: Tx,
): Promise<DesignRow | undefined> {
  return save(ownerId, designId, { ...patch }, opts);
}

/** A tombstone, never a hole: other devices need to hear about it. The plan goes. Throws `DbQueryError`. */
export async function tombstone(
  ownerId: string,
  designId: string,
  now: string,
  _tx?: Tx,
): Promise<void> {
  const { error } = await db()
    .from("library_designs")
    .update({ deleted_at: now, updated_at: now, plan: {} })
    .eq("user_id", ownerId)
    .eq("id", designId);
  if (error) {
    throw new DbQueryError(error);
  }
}

function failed(what: string, error: { message?: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? "no answer"}`);
}

/** The plan's stored size in bytes; undefined when the design is missing or deleted. */
export async function planBytes(
  ownerId: string,
  designId: string,
  _tx?: Tx,
): Promise<number | undefined> {
  const { data, error } = await db()
    .from("library_designs")
    .select("plan_bytes")
    .eq("user_id", ownerId)
    .eq("id", designId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    failed("Reading the plan size failed", error);
  }
  const row = data as { plan_bytes: number | string | null } | null;
  return row ? Number(row.plan_bytes ?? 0) : undefined;
}

/**
 * Takes the lease with `token` whoever held it (one live service per
 * database) and reads the plan. Undefined when the design is missing or deleted.
 */
export async function takeLease(
  ownerId: string,
  designId: string,
  token: string,
  until: Date,
  _tx?: Tx,
): Promise<{ plan: LivePlan; seq: number } | undefined> {
  const { data, error } = await db()
    .from("library_designs")
    .update({ live_lease_until: until.toISOString(), live_lease_token: token })
    .eq("user_id", ownerId)
    .eq("id", designId)
    .is("deleted_at", null)
    .select("plan,seq")
    .maybeSingle();
  if (error) {
    failed("Taking the lease failed", error);
  }
  if (!data) {
    return undefined;
  }
  const row = data as { plan: LivePlan; seq: number | string | null };
  return { plan: row.plan ?? {}, seq: Number(row.seq ?? 0) };
}

/** A conditional write matched nothing: the design went, or the lease is someone else's. */
async function missed(ownerId: string, designId: string): Promise<LeaseOutcome> {
  const { data, error } = await db()
    .from("library_designs")
    .select("deleted_at")
    .eq("user_id", ownerId)
    .eq("id", designId)
    .maybeSingle();
  if (error) {
    failed("Reading the lease failed", error);
  }
  const row = data as { deleted_at: string | null } | null;
  return !row || row.deleted_at ? "gone" : "lost";
}

/** Extends the lease, while it is `token`'s. */
export async function renewLease(
  ownerId: string,
  designId: string,
  token: string,
  until: Date,
  _tx?: Tx,
): Promise<LeaseOutcome> {
  const { data, error } = await db()
    .from("library_designs")
    .update({ live_lease_until: until.toISOString() })
    .eq("user_id", ownerId)
    .eq("id", designId)
    .eq("live_lease_token", token)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    failed("Renewing the lease failed", error);
  }
  return data ? "held" : missed(ownerId, designId);
}

/**
 * Writes the plan and its seq while the lease is `token`'s, extending it
 * (or ending it: `until` null), stamped `now`.
 */
export async function flushPlan(
  ownerId: string,
  designId: string,
  token: string,
  plan: LivePlan,
  seq: number,
  until: Date | null,
  now: string,
  _tx?: Tx,
): Promise<LeaseOutcome> {
  const { data, error } = await db()
    .from("library_designs")
    .update({
      plan,
      seq,
      plan_updated_at: now,
      updated_at: now,
      live_lease_until: until ? until.toISOString() : null,
      live_lease_token: until ? token : null,
    })
    .eq("user_id", ownerId)
    .eq("id", designId)
    .eq("live_lease_token", token)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    failed("Saving the plan failed", error);
  }
  return data ? "held" : missed(ownerId, designId);
}

/** Ends the lease without writing the plan, when it is still `token`'s. */
export async function releaseLease(
  ownerId: string,
  designId: string,
  token: string,
  _tx?: Tx,
): Promise<void> {
  const { error } = await db()
    .from("library_designs")
    .update({ live_lease_until: null, live_lease_token: null })
    .eq("user_id", ownerId)
    .eq("id", designId)
    .eq("live_lease_token", token);
  if (error) {
    failed("Releasing the lease failed", error);
  }
}
