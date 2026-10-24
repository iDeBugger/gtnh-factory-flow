import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { entryIconSchema } from "@/lib/model/schemas";
import type { CommunityPlanSummary, EntryIcon, PlanResourceStat } from "@/lib/community/types";
import {
  assertLocalDbAllowed,
  isLocalDb,
  LOCAL_DB_SERVICE_KEY,
  localDbFetch,
  localDbUrl,
} from "./local-db/client";
import { clientAddress } from "./client-address";
import {
  makeSessionToken,
  readSessionCookie,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionSecret,
  verifySessionToken,
} from "./session";
import { sameSecret } from "./secret";

export { makeSessionToken, SESSION_COOKIE };

/**
 * Server-only Supabase access for the community hub. Uses the service-role
 * key, so this module must never be imported from client components — the
 * API routes under /api/community are the only intended consumers.
 */

let cachedClient: SupabaseClient | undefined;

/**
 * How long one database request may take before it is abandoned. Without a
 * limit, a stalled Supabase instance holds requests open for minutes, so
 * pages hang instead of failing and the server piles up open sockets. A
 * healthy request finishes in well under a second, so this only cuts off a
 * stall.
 */
export const COMMUNITY_DB_TIMEOUT_MS = 20_000;

/** What a player reads when the database cannot be reached. */
export const COMMUNITY_DB_DOWN_MESSAGE = "The community database is not responding. Try again in a few minutes.";

const DB_DOWN_HEADER = "x-community-db-down";

/** A PostgREST-shaped error answer, which every client reads as `{ message }`. */
function dbDownResponse(status: number): Response {
  return Response.json(
    { message: COMMUNITY_DB_DOWN_MESSAGE, code: "", details: `HTTP ${status}`, hint: "" },
    { status, headers: { [DB_DOWN_HEADER]: "1" } },
  );
}

/**
 * After this many database requests in a row fail as down, the next ones fail
 * at once, without being sent, for `DB_BREAKER_OPEN_MS`; then one goes through
 * to try. A stalled instance only recovers once demand drops (its disk budget
 * refills below baseline), and every tab keeps asking.
 */
export const DB_BREAKER_FAILURES = 5;
export const DB_BREAKER_OPEN_MS = 15_000;
let dbFailuresInARow = 0;
let dbBreakerOpenUntil = 0;

/** For tests: a closed breaker. */
export function resetDbBreaker(): void {
  dbFailuresInARow = 0;
  dbBreakerOpenUntil = 0;
}

/** The database client's fetch: `fetchWithDbTimeout` behind the breaker. */
async function fetchFromDb(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  send: typeof fetch = fetch,
): Promise<Response> {
  if (Date.now() < dbBreakerOpenUntil) {
    // 504: postgrest-js retries a 503, which would only meet the breaker again.
    return dbDownResponse(504);
  }
  const response = await fetchWithDbTimeout(input, init, COMMUNITY_DB_TIMEOUT_MS, send);
  if (response.headers.get(DB_DOWN_HEADER)) {
    dbFailuresInARow += 1;
    if (dbFailuresInARow >= DB_BREAKER_FAILURES) {
      dbBreakerOpenUntil = Date.now() + DB_BREAKER_OPEN_MS;
    }
  } else {
    dbFailuresInARow = 0;
  }
  return response;
}

/**
 * The client's fetch (database, storage), abandoned after `timeoutMs`,
 * body included. A timeout before the answer arrives becomes a 504, not a
 * rejection: postgrest-js RETRIES a GET that rejects (other than with an
 * AbortError) three more times with backoff, and words a rejection as its
 * error's name and message. Supabase sits behind Cloudflare, so a stalled
 * instance answers with Cloudflare's HTML error page (522, 524, sent as
 * text/plain), which the clients would pass on whole as the error message:
 * any 5xx that is not JSON becomes the same plain answer, keeping its status
 * so postgrest-js still retries a 520. A 4xx is left alone (PostgREST reads
 * an empty 404 as no rows).
 */
export async function fetchWithDbTimeout(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  timeoutMs = COMMUNITY_DB_TIMEOUT_MS,
  send: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let response: Response;
  try {
    response = await send(input, { ...init, signal });
  } catch (error) {
    if (controller.signal.aborted && !init?.signal?.aborted) {
      return dbDownResponse(504);
    }
    throw error;
  }
  if (response.status < 500) {
    return response;
  }
  if (!response.headers.get("content-type")?.includes("json")) {
    await response.body?.cancel().catch(() => undefined);
    return dbDownResponse(response.status);
  }
  // PostgREST up but Postgres not (PGRST000-003: no connection, no schema
  // cache, no pool slot) says so in its own words: "Could not query the
  // database for the schema cache. Retrying."
  const body = (await response.clone().json().catch(() => undefined)) as { code?: unknown } | undefined;
  if (typeof body?.code === "string" && /^PGRST00[0-3]$/.test(body.code)) {
    await response.body?.cancel().catch(() => undefined);
    return dbDownResponse(response.status);
  }
  return response;
}

export function isCommunityConfigured(): boolean {
  return isLocalDb() || Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getCommunityDb(): SupabaseClient {
  if (!cachedClient && isLocalDb()) {
    // Local development (LOCAL_DB=1): the database on this machine, never
    // the hosted project, whatever SUPABASE_URL says. Never in production.
    assertLocalDbAllowed();
    cachedClient = createClient(localDbUrl(), LOCAL_DB_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      // The same limit and the same plain answers as the hosted project.
      global: {
        fetch: (input, init) =>
          fetchFromDb(input, init, (i, n) => localDbFetch(i, n, fetch)),
      },
    });
  }
  if (!cachedClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "Community hub is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
      );
    }

    cachedClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetchFromDb(input, init) },
    });
  }

  return cachedClient;
}

/** The address a request came from: the one rule lives in client-address.ts. */
export { clientAddress };

/**
 * A salted hash, so keys never hold raw addresses or ids. The salt is the
 * session secret (one variable, one rule: a production server without it
 * refuses here too).
 */
export function saltedKey(text: string): string {
  return createHash("sha256").update(`${sessionSecret()}:${text}`).digest("hex").slice(0, 32);
}

/**
 * Anonymous identity for a rate limit: a salted hash of the client address
 * and nothing the client chooses. A device id in the key would let one
 * address start a fresh count with every made-up id (votes use
 * `makeVoterKey`). The trailing colon keeps the key the same bytes as before,
 * so no stored count moves.
 */
export function makeActorKey(request: Request): string {
  return saltedKey(`${clientAddress(request)}:`);
}

/**
 * Who a VOTE belongs to: the signed-in user, else the browser's device id
 * (a random UUID kept in localStorage).
 *
 * Not the actor key above: it folds the client IP in, and IPv6 privacy
 * addresses and carrier NAT change a browser's IP every few minutes, which
 * would let one person vote again.
 */
export async function makeVoterKey(request: Request, deviceId: string): Promise<string> {
  const user = await getSessionUser(request);
  return saltedKey(user ? `user:${user.id}` : `device:${deviceId}`);
}

/**
 * Anonymous votes one address may cast or switch on one post (or blueprint)
 * in a day. The anonymous voter key is the browser's device id, which a
 * script can make up freely, so without this one address casts a vote per
 * made-up id. Accounts are keyed by account and exempt: a household behind
 * one address can each vote signed in.
 */
export const VOTES_PER_ADDRESS_PER_PLAN_PER_DAY = 3;

// ---------------------------------------------------------------------------
// Dead-simple accounts: username + password, scrypt-hashed, with an HMAC-signed
// session cookie (session.ts, shared with the live service). No email, no
// reset flow: this is a hobby community site. Every token carries the
// account's session_epoch; "Sign out everywhere" moves it (bumpSessionEpoch).
// A password change, when one exists, does the same `session_epoch =
// Date.now()` in its UPDATE and mints a fresh token for the changer.
// ---------------------------------------------------------------------------

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
  options: { maxmem: number },
) => Promise<Buffer>;

/**
 * The key derivation runs on libuv's threadpool, never on the event loop:
 * one derivation takes about 40 ms of CPU, and the synchronous form held
 * every page, API and dataset answer of the whole site for that long on each
 * sign-in attempt, which an unauthenticated flood turns into an outage. Node's
 * defaults (N=16384, r=8, p=1) need 16 MB; the ceiling leaves room above them.
 */
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

/**
 * Derivations in flight at once, and how many may wait behind them. The
 * threadpool has four threads and the dataset's shard reads queue on the same
 * pool, so a sign-in flood may never hold every thread; two at a time keeps
 * the dataset API's latency its own. Past the queue a check is refused and
 * the route answers "slow down" rather than holding the request open.
 */
export const KDF_CONCURRENCY = 2;
export const KDF_QUEUE_MAX = 32;
let kdfRunning = 0;
const kdfWaiting: Array<() => void> = [];

/** Thrown when more password checks arrive than the queue holds. */
export class PasswordCheckBusyError extends Error {
  constructor() {
    super("Too many sign-in attempts at once.");
    this.name = "PasswordCheckBusyError";
  }
}

/** For tests: derivations running right now. */
export function passwordChecksInFlight(): number {
  return kdfRunning;
}

async function deriveKey(password: string, salt: string): Promise<Buffer> {
  if (kdfRunning >= KDF_CONCURRENCY) {
    if (kdfWaiting.length >= KDF_QUEUE_MAX) {
      throw new PasswordCheckBusyError();
    }
    await new Promise<void>((resolve) => kdfWaiting.push(resolve));
  }
  kdfRunning += 1;
  try {
    return await scrypt(password, salt, SCRYPT_KEY_BYTES, { maxmem: SCRYPT_MAX_MEMORY });
  } finally {
    kdfRunning -= 1;
    kdfWaiting.shift()?.();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await deriveKey(password, salt)).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * A stored hash of nothing anyone types: a sign-in attempt for a name nobody
 * has derives against it, so an unknown name costs the same as a wrong
 * password and the answer's timing says nothing about which names exist.
 */
const DUMMY_PASSWORD_HASH =
  "5c669673f6136c24b28f9eda8acbe809:8fcadba8148d088a43a6cc903f5e95bc0db74e714a1393c295e4221fc27995cf820156d205a3e42a79ee585f886a623a90213fb9ba618392db69ffe37783c3ad";

/**
 * Whether the password matches the stored `salt:hash`. With no stored hash
 * (no such account) the derivation still runs, against the dummy, and the
 * answer is false whatever it finds.
 */
export async function checkPassword(password: string, stored: string | undefined): Promise<boolean> {
  const [salt, hash] = (stored ?? DUMMY_PASSWORD_HASH).split(":");
  if (!salt || !hash) {
    return false;
  }
  const candidate = await deriveKey(password, salt);
  const expected = Buffer.from(hash, "hex");
  const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
  return stored !== undefined && matches;
}

/**
 * The Set-Cookie line that stores or clears the session. In production the
 * cookie is Secure, so a plaintext request to the host never carries a token
 * that is good for 180 days; development runs over http://localhost. The
 * clearing line carries the same attributes, or browsers keep the old cookie.
 */
export function sessionCookieHeader(token: string, clear = false): string {
  const maxAge = clear ? 0 : SESSION_DAYS * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export interface SessionUser {
  id: string;
  username: string;
  is_admin: boolean;
  /** Moves on "Sign out everywhere"; a token made under another value is refused. */
  session_epoch: number;
}

/**
 * Verifies the session cookie and loads the user, or returns undefined: no
 * cookie, a bad signature, an expired token, a gone account, or a token from
 * before the account's last sign-out-everywhere. Throws when the database
 * does not answer (see `loadSessionUser`).
 */
export async function getSessionUser(request: Request): Promise<SessionUser | undefined> {
  const token = readSessionCookie(request.headers.get("cookie"));
  const session = token ? verifySessionToken(token) : undefined;
  if (!session) {
    return undefined;
  }
  const user = await loadSessionUser(session.userId);
  return user && user.session_epoch === session.epoch ? user : undefined;
}

/**
 * The account behind a verified session, or undefined when it is gone. A
 * lookup that fails throws: read as "signed out", it shows a signed-in player
 * the sign-in button, and the live service would close their socket as a
 * refused sign-in, which the client never retries.
 */
export function loadSessionUser(userId: string): Promise<SessionUser | undefined> {
  const cached = sessionUsers.get(userId);
  if (cached && Date.now() - cached.at < SESSION_USER_CACHE_MS) {
    return cached.user;
  }
  if (sessionUsers.size >= SESSION_USER_CACHE_MAX) {
    sessionUsers.clear();
  }
  // The promise is cached before the read answers, so a "Sign out everywhere"
  // that lands while the read is in flight forgets this entry and nothing
  // writes the pre-bump row back afterwards. A failed read is dropped.
  const entry = { at: Date.now(), user: readSessionUser(userId) };
  sessionUsers.set(userId, entry);
  entry.user.catch(() => {
    if (sessionUsers.get(userId) === entry) {
      sessionUsers.delete(userId);
    }
  });
  return entry.user;
}

async function readSessionUser(userId: string): Promise<SessionUser | undefined> {
  const { data, error } = await getCommunityDb()
    .from("community_users")
    .select("id,username,is_admin,session_epoch")
    .eq("id", userId)
    .maybeSingle<SessionUser>();
  if (error) {
    throw new Error(error.message || "Account lookup failed.");
  }
  // bigint arrives as a JSON number; a row from before the column reads as 0.
  return data ? { ...data, session_epoch: Number(data.session_epoch ?? 0) } : undefined;
}

/**
 * Signs the account out everywhere: every token made so far stops verifying,
 * here at once (the cache forgets the account) and in the live service once
 * it hears (`notifyLive` signed-out) or its own cache lapses. A millisecond
 * stamp needs no read-modify-write, and two concurrent bumps both invalidate.
 * Returns the new epoch; throws when the database does not answer.
 */
export async function bumpSessionEpoch(userId: string): Promise<number> {
  const epoch = Date.now();
  const { error } = await getCommunityDb()
    .from("community_users")
    .update({ session_epoch: epoch })
    .eq("id", userId);
  if (error) {
    throw new Error(error.message || "Sign out everywhere failed.");
  }
  forgetSessionUser(userId);
  return epoch;
}

/**
 * Accounts by id, kept a minute: nearly every request names its account, and
 * the database is small. A rename or an admin change shows within the minute.
 */
const SESSION_USER_CACHE_MS = 60_000;
const SESSION_USER_CACHE_MAX = 5000;
const sessionUsers = new Map<string, { at: number; user: Promise<SessionUser | undefined> }>();

/** For tests: forget the cached accounts. */
export function forgetSessionUsers(): void {
  sessionUsers.clear();
}

/** Forget one cached account, so the next request reads its row again. */
export function forgetSessionUser(userId: string): void {
  sessionUsers.delete(userId);
}

/** The admin header, checked in constant time; with no token configured nobody is admin. */
export function isAdminRequest(request: Request): boolean {
  return sameSecret(request.headers.get("x-admin-token"), process.env.COMMUNITY_ADMIN_TOKEN);
}

/**
 * Work in flight per key, so a count-then-record limit sees every earlier
 * record: without this, N requests for one key arriving together all read a
 * count under the limit and all pass. The site is one process, so an
 * in-process queue is the whole story. An entry lives only while something
 * is in flight under its key.
 */
const inFlight = new Map<string, Promise<void>>();

/** Runs `work` after everything already queued under `key`, whatever became of it. */
export function serially<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(key, settled);
  void settled.then(() => {
    if (inFlight.get(key) === settled) {
      inFlight.delete(key);
    }
  });
  return run;
}

/** Returns true when the action is allowed; records it when it is. One at a time per key and action. */
export function checkRateLimit(
  actorKey: string,
  action: string,
  maxPerWindow: number,
  windowSeconds: number,
): Promise<boolean> {
  return serially(`${actorKey}:${action}`, async () => {
    if ((await countEvents(actorKey, action, windowSeconds)) >= maxPerWindow) {
      return false;
    }
    await recordEvents([{ actorKey, action }]);
    return true;
  });
}

/** How many times the actor did the action in the last `windowSeconds`. */
export async function countEvents(actorKey: string, action: string, windowSeconds: number): Promise<number> {
  const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { count, error } = await getCommunityDb()
    .from("community_events")
    .select("id", { count: "exact", head: true })
    .eq("actor_key", actorKey)
    .eq("action", action)
    .gte("created_at", windowStart);
  if (error) {
    throw new Error(`Rate limit check failed: ${error.message}`);
  }
  return count ?? 0;
}

/** Records actions for `countEvents`, in one request. */
export async function recordEvents(events: { actorKey: string; action: string }[]): Promise<void> {
  const { error } = await getCommunityDb()
    .from("community_events")
    .insert(events.map((e) => ({ actor_key: e.actorKey, action: e.action })));
  if (error) {
    throw new Error(`Rate limit record failed: ${error.message}`);
  }
  await pruneEvents();
}

/**
 * Nothing reads an event older than the longest window (30 days, the same
 * words check), so older rows only cost the small instance disk and its IO
 * budget. Pruned once an hour per process, after a record; a prune never
 * fails a save.
 */
export const EVENTS_KEPT_DAYS = 31;
const PRUNE_EVERY_MS = 60 * 60_000;
let lastPruneAt = 0;

async function pruneEvents(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_EVERY_MS) {
    return;
  }
  lastPruneAt = now;
  try {
    await getCommunityDb()
      .from("community_events")
      .delete()
      .lt("created_at", new Date(now - EVENTS_KEPT_DAYS * 86_400_000).toISOString());
  } catch {
    // The rows stay until the next hour's prune.
  }
}

/**
 * The one item face an author picks for a shared entry. Client-supplied but
 * harmless: it only ever renders as an icon. Anything that doesn't parse
 * becomes "no icon", never a rejection. The schema lives with the model; this
 * is the server's lenient reading.
 */
export function parseEntryIcon(value: unknown): EntryIcon | null {
  const parsed = entryIconSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The columns before the activity trio: what a database not yet migrated can answer. */
export const PLAN_SUMMARY_COLUMNS_LEGACY =
  "id,name,description,game_version,dataset_version,tags,is_public,icon,needs,outputs," +
  "total_eu_t,machine_count,node_count,storage_count,edge_count,highest_tier," +
  "highest_tier_index,upvotes,downvotes,score,downloads,views,created_at,updated_at," +
  "user_id,author_name";
/** The activity columns, which a later migration added; a sort on one needs them. */
export const PLAN_ACTIVITY_COLUMNS = new Set(["comment_count", "last_comment_at", "last_activity_at"]);

/** Columns returned for plan listings (everything except the plan JSON). */
export const PLAN_SUMMARY_COLUMNS =
  "id,name,description,game_version,dataset_version,tags,is_public,icon,needs,outputs," +
  "total_eu_t,machine_count,node_count,storage_count,edge_count,highest_tier," +
  "highest_tier_index,upvotes,downvotes,score,downloads,views,created_at,updated_at," +
  "user_id,author_name,comment_count,last_comment_at,last_activity_at";

export interface PlanRow {
  id: string;
  name: string;
  description: string;
  game_version: string;
  dataset_version: string;
  tags: string[] | null;
  is_public: boolean | null;
  icon: EntryIcon | null;
  needs: PlanResourceStat[];
  outputs: PlanResourceStat[];
  total_eu_t: number;
  machine_count: number;
  node_count: number;
  storage_count: number;
  edge_count: number;
  highest_tier: string | null;
  highest_tier_index: number;
  upvotes: number;
  downvotes: number;
  score: number;
  downloads: number;
  views: number;
  created_at: string;
  updated_at: string | null;
  user_id: string | null;
  author_name: string;
  comment_count: number | null;
  last_comment_at: string | null;
  last_activity_at: string | null;
}

export function rowToPlanSummary(row: PlanRow, sessionUserId?: string): CommunityPlanSummary {
  return {
    authorName: row.author_name || undefined,
    isMine: Boolean(sessionUserId && row.user_id === sessionUserId),
    id: row.id,
    name: row.name,
    description: row.description,
    gameVersion: row.game_version,
    datasetVersionId: row.dataset_version,
    tags: row.tags ?? [],
    isPublic: row.is_public ?? true,
    icon: row.icon ?? undefined,
    needs: row.needs ?? [],
    outputs: row.outputs ?? [],
    totalEuT: row.total_eu_t,
    machineCount: row.machine_count,
    nodeCount: row.node_count,
    storageCount: row.storage_count,
    edgeCount: row.edge_count,
    highestTier: (row.highest_tier ?? undefined) as CommunityPlanSummary["highestTier"],
    highestTierIndex: row.highest_tier_index,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    score: row.score,
    downloads: row.downloads,
    views: row.views,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    commentCount: row.comment_count ?? 0,
    lastCommentAt: row.last_comment_at ?? undefined,
    lastActivityAt: row.last_activity_at ?? undefined,
  };
}

/**
 * Restamps a post's comment figures after a comment lands or goes: the live
 * count, the latest comment's time, and the post's last activity (the later
 * of its last edit and that comment). Best effort: a failure here leaves a
 * sort slightly stale, never a comment unposted.
 */
export async function recountPlanComments(planId: string): Promise<void> {
  const db = getCommunityDb();
  const { data: rows } = await db
    .from("community_comments")
    .select("created_at")
    .eq("plan_id", planId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .returns<Array<{ created_at: string }>>();
  const { count } = await db
    .from("community_comments")
    .select("id", { count: "exact", head: true })
    .eq("plan_id", planId)
    .is("deleted_at", null);
  const { data: plan } = await db
    .from("community_plans")
    .select("created_at,updated_at")
    .eq("id", planId)
    .single<{ created_at: string; updated_at: string | null }>();
  const lastCommentAt = rows?.[0]?.created_at ?? null;
  const edited = plan?.updated_at ?? plan?.created_at ?? null;
  const lastActivityAt =
    lastCommentAt && edited ? (lastCommentAt > edited ? lastCommentAt : edited) : (lastCommentAt ?? edited);
  await db
    .from("community_plans")
    .update({
      comment_count: count ?? 0,
      last_comment_at: lastCommentAt,
      last_activity_at: lastActivityAt,
    })
    .eq("id", planId);
}

/**
 * PGRST204 / 42703: the table predates a column this build reads or writes.
 * Re-running supabase/schema.sql (idempotent ALTERs) fixes it.
 */
export function isMissingColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST204" || error?.code === "42703";
}

export function communityStorageErrorMessage(
  error: { code?: string; message?: string } | null,
  fallback: string,
): string {
  if (error?.code === "PGRST204" || error?.code === "42703") {
    return "Community storage is out of date: re-run the latest supabase/schema.sql in the Supabase SQL editor.";
  }
  return error?.message ?? fallback;
}

export async function attachMyVotes(
  plans: CommunityPlanSummary[],
  actorKey: string,
): Promise<void> {
  if (plans.length === 0) {
    return;
  }

  const db = getCommunityDb();
  const { data, error } = await db
    .from("community_votes")
    .select("plan_id,value")
    .eq("voter_key", actorKey)
    .in(
      "plan_id",
      plans.map((plan) => plan.id),
    );

  if (error || !data) {
    return;
  }

  const votesByPlan = new Map(data.map((vote) => [vote.plan_id as string, vote.value as 1 | -1]));
  for (const plan of plans) {
    plan.myVote = votesByPlan.get(plan.id);
  }
}
