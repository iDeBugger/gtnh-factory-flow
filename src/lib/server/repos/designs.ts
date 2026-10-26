import type { LivePlan } from "@/lib/live/ops";
import { getDb, json, type Tx } from "../db";
import { sqlRules } from "./visibility";

/**
 * Library designs: one row per owner and id, tombstoned on delete, and the
 * live lease. While `live_lease_until` is in the future the live service is
 * the plan's only writer; every renewal, flush and release is conditional on
 * its token and skips tombstones, and a REST plan save lands only while the
 * lease is free and clears the token. Every write to `plan`, `seq`,
 * `live_lease_until` and `live_lease_token` in the codebase is in this file.
 *
 * Repositories take an optional transaction last; a query runs on it when
 * one is passed, else on the pool. A failure throws: a down database as
 * `DatabaseDownError`, a refused statement as the driver's error.
 */

/** Everything the list endpoint returns about a design: no plan. */
const DESIGN_META_COLUMNS = [
  "id",
  "name",
  "icon",
  "folder_id",
  "closed",
  "favorite",
  "sort_order",
  "community_plan_id",
  "created_at",
  "updated_at",
  "plan_updated_at",
  "deleted_at",
] as const;

/** The same columns, named by table, for a query that joins another. */
const DESIGN_META_REFS = DESIGN_META_COLUMNS.map((column) => `library_designs.${column}` as const);

/** What the live service keeps on a design (supabase/migrations/2026-10-14-cloud-live.sql). */
const DESIGN_LIVE_COLUMNS = ["seq", "live_lease_until"] as const;

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

/** An icon as the column takes it: SQL null when there is none, as PostgREST wrote it. */
const iconParam = (icon: unknown) => (icon === null || icon === undefined ? null : json(icon));

/** The owner's designs, tombstones included, newest edit first. */
export async function listOwn(userId: string, limit: number, tx?: Tx): Promise<DesignRow[]> {
  return (tx ?? getDb())
    .selectFrom("library_designs")
    .select(DESIGN_META_COLUMNS)
    .where("user_id", "=", userId)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();
}

/**
 * The live designs shared with `memberId`: a join on the member's own
 * memberships, so another owner's design that shares an id with one of them
 * never comes back.
 */
export async function sharedWith(
  memberId: string,
  tx?: Tx,
): Promise<Array<DesignRow & { user_id: string }>> {
  return (tx ?? getDb())
    .selectFrom("library_designs")
    .innerJoin("library_design_members", (join) =>
      join
        .onRef("library_design_members.owner_id", "=", "library_designs.user_id")
        .onRef("library_design_members.design_id", "=", "library_designs.id"),
    )
    .select(["library_designs.user_id", ...DESIGN_META_REFS])
    .where("library_design_members.member_id", "=", memberId)
    .where("library_designs.user_id", "<>", memberId)
    .where(sqlRules.notTombstoned())
    .execute();
}

/**
 * One design's row, with its live columns and optionally its plan.
 * `forUpdate` (inside a transaction) locks the row until it ends, so a save
 * that read it cannot be passed by another save of the same design.
 */
export async function read(
  ownerId: string,
  designId: string,
  opts: { withPlan: boolean; forUpdate?: boolean },
  tx?: Tx,
): Promise<DesignLiveRow | undefined> {
  const query = (tx ?? getDb())
    .selectFrom("library_designs")
    .select([...DESIGN_META_COLUMNS, ...DESIGN_LIVE_COLUMNS])
    .$if(opts.withPlan, (q) => q.select("plan"))
    .where(sqlRules.designKey(ownerId, designId));
  return (opts.forUpdate ? query.forUpdate() : query).executeTakeFirst();
}

/**
 * Locks the account's row until the transaction ends, so one account's
 * creations (a design or a folder past the cap check) queue behind each other.
 */
export async function lockAccount(userId: string, tx: Tx): Promise<void> {
  await tx
    .selectFrom("community_users")
    .select("id")
    .where("id", "=", userId)
    .forUpdate()
    .execute();
}

/** The owner's live (not tombstoned) designs. */
export async function countLive(userId: string, tx?: Tx): Promise<number> {
  const row = await (tx ?? getDb())
    .selectFrom("library_designs")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .where(sqlRules.notTombstoned())
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** A new design; answers its metadata. */
export async function insert(row: NewDesignRow, tx?: Tx): Promise<DesignRow> {
  return (tx ?? getDb())
    .insertInto("library_designs")
    .values({ ...row, icon: iconParam(row.icon), plan: json(row.plan) })
    .returning(DESIGN_META_COLUMNS)
    .executeTakeFirstOrThrow();
}

/** What a save sets: the patch's columns, jsonb through `json()`, the plan only when it rides. */
function saveColumns(patch: MemberDesignPatch & Partial<Omit<OwnerDesignPatch, "user_id" | "id">>) {
  const { plan, icon, ...rest } = patch;
  return {
    ...rest,
    ...("icon" in patch ? { icon: iconParam(icon) } : {}),
    ...(plan !== undefined ? { plan: json(plan) } : {}),
  };
}

/**
 * Writes a save over an existing design. With `requireLeaseFree` (a plan
 * rides) the write lands only while no live lease is held at `now`, and it
 * clears the token, so a lapsed lease's room cannot write over this plan.
 * Undefined when nothing matched: the live service took the lease since the
 * caller read the row.
 */
async function save(
  ownerId: string,
  designId: string,
  columns: ReturnType<typeof saveColumns>,
  opts: { requireLeaseFree: boolean; now: string },
  tx?: Tx,
): Promise<DesignRow | undefined> {
  const clearsToken = columns.plan !== undefined && opts.requireLeaseFree;
  return (tx ?? getDb())
    .updateTable("library_designs")
    .set({ ...columns, ...(clearsToken ? { live_lease_token: null } : {}) })
    .where(sqlRules.designKey(ownerId, designId))
    .$if(opts.requireLeaseFree, (q) => q.where(sqlRules.leaseFreeAt(opts.now)))
    .returning(DESIGN_META_COLUMNS)
    .executeTakeFirst();
}

/** The owner's save of an existing design (see `save`). Writing a design brings it back from a tombstone. */
export function saveAsOwner(
  ownerId: string,
  designId: string,
  patch: OwnerDesignPatch,
  opts: { requireLeaseFree: boolean; now: string },
  tx?: Tx,
): Promise<DesignRow | undefined> {
  // The key names the row; it is never rewritten.
  const { user_id: _userId, id: _id, ...columns } = patch;
  return save(ownerId, designId, saveColumns(columns), opts, tx);
}

/** A member's save: the plan and its name and stamps only (see `save`). */
export function saveAsMember(
  ownerId: string,
  designId: string,
  patch: MemberDesignPatch,
  opts: { requireLeaseFree: boolean; now: string },
  tx?: Tx,
): Promise<DesignRow | undefined> {
  const { name, updated_at, plan_updated_at, plan } = patch;
  return save(ownerId, designId, saveColumns({ name, updated_at, plan_updated_at, plan }), opts, tx);
}

/** A tombstone, never a hole: other devices need to hear about it. The plan goes. */
export async function tombstone(
  ownerId: string,
  designId: string,
  now: string,
  tx?: Tx,
): Promise<void> {
  await (tx ?? getDb())
    .updateTable("library_designs")
    .set({ deleted_at: now, updated_at: now, plan: json({}) })
    .where(sqlRules.designKey(ownerId, designId))
    .execute();
}

/** The plan's stored size in bytes; undefined when the design is missing or deleted. */
export async function planBytes(
  ownerId: string,
  designId: string,
  tx?: Tx,
): Promise<number | undefined> {
  const row = await (tx ?? getDb())
    .selectFrom("library_designs")
    .select("plan_bytes")
    .where(sqlRules.designKey(ownerId, designId))
    .where(sqlRules.notTombstoned())
    .executeTakeFirst();
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
  tx?: Tx,
): Promise<{ plan: LivePlan; seq: number } | undefined> {
  const row = await (tx ?? getDb())
    .updateTable("library_designs")
    .set({ live_lease_until: until.toISOString(), live_lease_token: token })
    .where(sqlRules.designKey(ownerId, designId))
    .where(sqlRules.notTombstoned())
    .returning(["plan", "seq"])
    .executeTakeFirst();
  if (!row) {
    return undefined;
  }
  return { plan: (row.plan ?? {}) as LivePlan, seq: Number(row.seq ?? 0) };
}

/** What a write conditional on the lease sets. */
interface LeaseColumns {
  live_lease_until: string | null;
  live_lease_token?: string | null;
  plan?: ReturnType<typeof json>;
  seq?: number;
  plan_updated_at?: string;
  updated_at?: string;
}

/**
 * One statement: the write, conditional on the lease being `token`'s and the
 * design not tombstoned, and the row's state, so a write that matched
 * nothing says why ("gone": missing or deleted; "lost": another lease). The
 * state is a locking read, so it is the row's newest version whichever of
 * the two runs first: a delete that lands while the write waits reads as
 * "gone", never "lost".
 */
async function writeWhileHeld(
  ownerId: string,
  designId: string,
  token: string,
  columns: LeaseColumns,
  tx?: Tx,
): Promise<LeaseOutcome> {
  const row = await (tx ?? getDb())
    .with("target", (qc) =>
      qc
        .selectFrom("library_designs")
        .select("deleted_at")
        .where(sqlRules.designKey(ownerId, designId))
        .forUpdate(),
    )
    .with("done", (qc) =>
      qc
        .updateTable("library_designs")
        .set(columns)
        .where(sqlRules.designKey(ownerId, designId))
        .where(sqlRules.leaseHeldBy(token))
        .where(sqlRules.notTombstoned())
        .returning("id"),
    )
    .selectNoFrom((eb) => [
      eb.exists(eb.selectFrom("done").select("done.id")).as("written"),
      eb.exists(eb.selectFrom("target").select("target.deleted_at")).as("present"),
      eb.selectFrom("target").select("target.deleted_at").as("deleted_at"),
    ])
    .executeTakeFirstOrThrow();
  if (row.written) {
    return "held";
  }
  return !row.present || row.deleted_at ? "gone" : "lost";
}

/** Extends the lease, while it is `token`'s. */
export function renewLease(
  ownerId: string,
  designId: string,
  token: string,
  until: Date,
  tx?: Tx,
): Promise<LeaseOutcome> {
  return writeWhileHeld(ownerId, designId, token, { live_lease_until: until.toISOString() }, tx);
}

/**
 * Writes the plan and its seq while the lease is `token`'s, extending it
 * (or ending it: `until` null), stamped `now`.
 */
export function flushPlan(
  ownerId: string,
  designId: string,
  token: string,
  plan: LivePlan,
  seq: number,
  until: Date | null,
  now: string,
  tx?: Tx,
): Promise<LeaseOutcome> {
  return writeWhileHeld(
    ownerId,
    designId,
    token,
    {
      plan: json(plan),
      seq,
      plan_updated_at: now,
      updated_at: now,
      live_lease_until: until ? until.toISOString() : null,
      live_lease_token: until ? token : null,
    },
    tx,
  );
}

/** Ends the lease without writing the plan, when it is still `token`'s. */
export async function releaseLease(
  ownerId: string,
  designId: string,
  token: string,
  tx?: Tx,
): Promise<void> {
  await (tx ?? getDb())
    .updateTable("library_designs")
    .set({ live_lease_until: null, live_lease_token: null })
    .where(sqlRules.designKey(ownerId, designId))
    .where(sqlRules.leaseHeldBy(token))
    .execute();
}
