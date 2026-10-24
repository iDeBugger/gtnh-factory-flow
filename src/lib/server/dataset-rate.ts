import { NextResponse } from "next/server";
import { clientAddress } from "./client-address";

/**
 * A work budget per address for the dataset routes, kept in this process's
 * memory. The routes cost very different amounts (a narrowed search a few
 * milliseconds, an un-narrowed one up to about 250 ms, the recipe id list 15 MB),
 * so each request spends units rather than counting as one: a cheap request 1,
 * a heavy one 10. The budget is 1200 units a minute, so one address gets at most
 * 120 heavy requests a minute, under 30 s of the one server thread. A player
 * typing stays far below it (two heavy requests per word start, most skipped by
 * the client's debounce). Floods from many addresses are Cloudflare's job.
 *
 * `GTNH_DATASET_BUDGET_PER_MINUTE` overrides the budget; 0 disables it, for
 * local profiling runs. Bounded: the oldest addresses are forgotten past
 * `MAX_KEYS`.
 */

export const BUDGET_PER_MINUTE = 1200;
export const HEAVY_REQUEST_COST = 10;
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

const windows = new Map<string, Array<{ stamp: number; cost: number }>>();

function budgetPerMinute(): number {
  const raw = process.env.GTNH_DATASET_BUDGET_PER_MINUTE;
  if (raw === undefined || raw === "") {
    return BUDGET_PER_MINUTE;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : BUDGET_PER_MINUTE;
}

/** True when `address` may spend `cost` now (and spends it); false once the minute's budget is gone. */
export function takeDatasetBudget(address: string, cost: number, now = Date.now()): boolean {
  const budget = budgetPerMinute();
  if (budget === 0) {
    return true;
  }
  const since = now - WINDOW_MS;
  const spent = (windows.get(address) ?? []).filter((entry) => entry.stamp > since);
  const total = spent.reduce((sum, entry) => sum + entry.cost, 0);
  if (total + cost > budget) {
    windows.set(address, spent);
    return false;
  }
  spent.push({ stamp: now, cost });
  windows.delete(address);
  windows.set(address, spent);
  while (windows.size > MAX_KEYS) {
    const oldest = windows.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    windows.delete(oldest);
  }
  return true;
}

export const DATASET_BUDGET_REFUSAL = "Too many requests. Wait a moment and try again.";

/**
 * Spends `cost` for the request's address, or the 429 to answer with. Decided
 * before any dataset work. The client shows the error text in its search panes.
 */
export function datasetBudgetRefusal(request: Request, cost: number): Response | undefined {
  if (takeDatasetBudget(clientAddress(request), cost)) {
    return undefined;
  }
  return NextResponse.json(
    { error: DATASET_BUDGET_REFUSAL },
    { status: 429, headers: { "Retry-After": "10", "Cache-Control": "no-store" } },
  );
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

/** Forgets every window (tests). */
export function resetDatasetBudget(): void {
  windows.clear();
}
