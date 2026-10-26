import { NextResponse } from "next/server";
import { clientAddress, NO_ADDRESS } from "../http/client-address";

/**
 * A work budget per address for the dataset routes, kept in this process's
 * memory. Each request spends a base cost before any dataset work (a cheap
 * request 1 unit, a heavy one 25: an un-narrowable search, the recipe id list,
 * the crop list, a plan's recipe resolution), then one more unit per 10 ms the
 * answer took once it is known. The budget is 3000 units a minute, so the
 * measured units alone keep one address under 30 s of the one server thread
 * a minute whatever a query shape costs, and the base cost refuses a burst of
 * heavy requests before their work is done (120 a minute).
 *
 * Sized against what the client sends, not what an attacker does: a plan open
 * or import fetches one recipe body per recipe (about 200 for a plan at the
 * 3 MB cap, 1 unit plus a few ms each) after the id list, the item pane asks
 * a page in chunks of 120 on every debounced keystroke, and a query with a
 * tier word ("lv motor") is heavy on every chunk; two fast typists and a plan
 * import behind one address fit in a minute. The client retries a 429 on the
 * import path (browser-loader.ts) after Retry-After, so a plan never fails on
 * one refusal. Floods from many addresses are Cloudflare's job.
 *
 * A request with no trusted address (NO_ADDRESS: nothing from Caddy or
 * Cloudflare, so a developer's own machine, or a proxy line gone missing) is
 * never refused: one shared key would turn a missing proxy header into a
 * site-wide 429, and it bounds no attacker (whoever reaches the port without
 * Caddy can forge an address per request). In production the first such
 * request is logged once.
 *
 * `GTNH_DATASET_BUDGET_PER_MINUTE` overrides the budget; 0 disables it, for
 * local profiling runs. Bounded: the oldest addresses are forgotten past
 * `MAX_KEYS`.
 */

export const BUDGET_PER_MINUTE = 3000;
export const HEAVY_REQUEST_COST = 25;
/** One unit of the budget per this much of the answer's measured time. */
export const MS_PER_WORK_UNIT = 10;
/**
 * Measured time is wall time, which holds the wait behind other requests: a
 * 4 ms body fetch queued behind a search must not be billed as a search, or a
 * plan open would wait on 429s exactly when the server is busiest. This much
 * of every answer is free: 120 heavy requests a minute make 6 s of free
 * thread, and the 270 ms corrector shape still pays 22 units.
 */
export const FREE_MS_PER_REQUEST = 50;
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

const windows = new Map<string, Array<{ stamp: number; cost: number }>>();
let warnedMissingAddress = false;

function budgetPerMinute(): number {
  const raw = process.env.GTNH_DATASET_BUDGET_PER_MINUTE;
  if (raw === undefined || raw === "") {
    return BUDGET_PER_MINUTE;
  }
  const parsed = Number.parseInt(raw, 10);
  // A budget under one heavy request would refuse every heavy request for
  // ever; only 0 (off) or a workable number is honoured.
  return Number.isInteger(parsed) && (parsed === 0 || parsed >= HEAVY_REQUEST_COST)
    ? parsed
    : BUDGET_PER_MINUTE;
}

function remember(address: string, spent: Array<{ stamp: number; cost: number }>): void {
  windows.delete(address);
  windows.set(address, spent);
  while (windows.size > MAX_KEYS) {
    const oldest = windows.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    windows.delete(oldest);
  }
}

function recentSpend(address: string, now: number): Array<{ stamp: number; cost: number }> {
  const since = now - WINDOW_MS;
  return (windows.get(address) ?? []).filter((entry) => entry.stamp > since);
}

/** True when `address` may spend `cost` now (and spends it); false once the minute's budget is gone. */
export function takeDatasetBudget(address: string, cost: number, now = Date.now()): boolean {
  const budget = budgetPerMinute();
  if (budget === 0 || address === NO_ADDRESS) {
    return true;
  }
  const spent = recentSpend(address, now);
  const total = spent.reduce((sum, entry) => sum + entry.cost, 0);
  if (total + cost > budget) {
    remember(address, spent);
    return false;
  }
  spent.push({ stamp: now, cost });
  remember(address, spent);
  return true;
}

/** Spends `cost` for `address` whatever is left: the measured part of an answer already given. */
export function spendDatasetBudget(address: string, cost: number, now = Date.now()): void {
  if (budgetPerMinute() === 0 || address === NO_ADDRESS || cost <= 0) {
    return;
  }
  const spent = recentSpend(address, now);
  spent.push({ stamp: now, cost });
  remember(address, spent);
}

/** What `address` has spent in the last minute (tests). */
export function datasetBudgetSpent(address: string, now = Date.now()): number {
  return recentSpend(address, now).reduce((sum, entry) => sum + entry.cost, 0);
}

/** How many addresses are remembered (tests). */
export function datasetBudgetAddressCount(): number {
  return windows.size;
}

export const DATASET_BUDGET_REFUSAL = "Too many requests. Wait a moment and try again.";

/**
 * Spends the base `cost` for the request's address, or the 429 to answer with.
 * Decided before any dataset work. The client shows the error text in its
 * search panes.
 */
export function datasetBudgetRefusal(request: Request, cost: number): Response | undefined {
  const address = clientAddress(request);
  if (address === NO_ADDRESS) {
    warnMissingAddressOnce();
    return undefined;
  }
  if (takeDatasetBudget(address, cost)) {
    return undefined;
  }
  return NextResponse.json(
    { error: DATASET_BUDGET_REFUSAL },
    { status: 429, headers: { "Retry-After": "10", "Cache-Control": "no-store" } },
  );
}

/**
 * Runs the dataset work of a route and charges its measured time to the
 * request's address afterwards, whether it answered or threw.
 */
export async function meteredDatasetWork<T>(request: Request, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    const elapsed = performance.now() - started;
    spendDatasetBudget(
      clientAddress(request),
      Math.ceil(Math.max(0, elapsed - FREE_MS_PER_REQUEST) / MS_PER_WORK_UNIT),
    );
  }
}

/**
 * What a text search costs. A word under three characters cannot use the
 * trigram index and walks the whole corpus; more than three words multiply the
 * passes. A blank query is the cached list.
 */
export function searchRequestCost(terms: ReadonlyArray<{ raw: string }>): number {
  const heavy = terms.length > 3 || terms.some((term) => term.raw.length < 3);
  return heavy ? HEAVY_REQUEST_COST : 1;
}

function warnMissingAddressOnce(): void {
  if (warnedMissingAddress || process.env.NODE_ENV !== "production") {
    return;
  }
  warnedMissingAddress = true;
  console.warn(
    "[datasets] a request carries neither X-Client-Ip nor CF-Connecting-IP: Caddy's header_up is missing, per-address limits do not apply to it",
  );
}

/** Forgets every window and the one-shot warning (tests). */
export function resetDatasetBudget(): void {
  windows.clear();
  warnedMissingAddress = false;
}
