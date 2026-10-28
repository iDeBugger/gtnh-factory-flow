import { calculateThroughput } from "@/lib/solver";
import type { FactoryProject, ThroughputResult } from "@/lib/model/types";

/**
 * The store's one door to the solver. The plan solver runs integer programs on HiGHS, which only the Web Worker
 * loads, so the solve runs there whenever there is one: the caller gets its previous books back immediately,
 * flagged `stale`, and the real result replaces `lastResult` through the sink when the worker lands.
 *
 * Finished books are kept in a small content-keyed LRU, so switching tabs between unchanged plans is instant; the
 * design store re-reads a plan from IndexedDB on every switch, so the cache cannot key on object identity.
 *
 * Rapid edits coalesce: one solve runs at a time, only the newest waiting plan is kept, and a result for a plan no
 * longer on the canvas is cached but never shown. Environments without workers (SSR, vitest, old browsers) solve
 * synchronously.
 */

const BIG_BOOKS_CACHE_LIMIT = 8;
const bigBooksCache = new Map<string, ThroughputResult>();

interface SolveRequest {
  key: string;
  project: FactoryProject;
}

let sink: ((result: ThroughputResult) => void) | undefined;
let worker: Worker | undefined;
let workerBroken = false;
let inFlight: SolveRequest | undefined;
let queued: SolveRequest | undefined;
/** The content key of the plan the canvas currently shows, while the worker solves it. */
let currentKey: string | undefined;
/** The last books handed out: what a stale placeholder wears. */
let lastBooks: ThroughputResult | undefined;

/** Where finished worker solves land; the factory store registers itself. */
export function registerBooksSink(apply: (result: ThroughputResult) => void) {
  sink = apply;
}

export function solveBooks(project: FactoryProject): ThroughputResult {
  if (!workerAvailable()) {
    const result = calculateThroughput(project);
    currentKey = undefined;
    lastBooks = result;
    return result;
  }

  const key = booksContentKey(project);
  currentKey = key;
  const cached = bigBooksCache.get(key);
  if (cached) {
    // LRU bump.
    bigBooksCache.delete(key);
    bigBooksCache.set(key, cached);
    lastBooks = cached;
    return cached;
  }

  scheduleSolve({ key, project });
  // The previous books stand in while the worker runs. After a tab switch
  // they belong to another plan, whose node ids simply miss - the board reads
  // that as empty books until the real ones land, which is the honest state.
  const placeholder: ThroughputResult = lastBooks
    ? { ...lastBooks, stale: true }
    : emptyBooks();
  lastBooks = placeholder;
  return placeholder;
}

/**
 * The plan as the solver sees it. The `view` block is how the board is DRAWN
 * and never reaches the solver, so it must not invalidate finished books; the
 * design store also restamps it on every save, which would defeat the cache.
 */
function booksContentKey(project: FactoryProject): string {
  const { view: _view, ...solved } = project;
  return JSON.stringify(solved);
}

function workerAvailable(): boolean {
  return !workerBroken && typeof Worker !== "undefined";
}

function scheduleSolve(request: SolveRequest) {
  if (inFlight) {
    // Only the newest waiting plan matters; intermediates were superseded.
    queued = request;
    return;
  }
  inFlight = request;
  try {
    getWorker().postMessage({ key: request.key, project: request.project });
  } catch (error) {
    console.error("solve worker failed to start; solving on the main thread", error);
    workerBroken = true;
    inFlight = undefined;
    deliver(request.key, calculateThroughput(request.project));
  }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./solve-books.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (
      event: MessageEvent<{
        key: string;
        result?: ThroughputResult;
        error?: string;
      }>,
    ) => {
      const { key, result, error } = event.data;
      inFlight = undefined;
      if (result) {
        deliver(key, result);
      } else {
        console.error("solve worker error:", error);
      }
      if (queued) {
        const next = queued;
        queued = undefined;
        // A queued repeat of what just finished (or of anything already
        // solved) serves from the cache instead of solving twice.
        const cached = bigBooksCache.get(next.key);
        if (cached) {
          if (next.key === currentKey) {
            lastBooks = cached;
            sink?.(cached);
          }
        } else {
          scheduleSolve(next);
        }
      }
    };
    worker.onerror = (event) => {
      // A worker that cannot run its script would fail every solve silently;
      // fall back to the blocking path rather than showing stale books forever.
      console.error("solve worker broke; falling back to main-thread solves", event.message);
      workerBroken = true;
      const retry = queued ?? inFlight;
      inFlight = undefined;
      queued = undefined;
      if (retry) {
        deliver(retry.key, calculateThroughput(retry.project));
      }
    };
  }
  return worker;
}

function deliver(key: string, result: ThroughputResult) {
  bigBooksCache.set(key, result);
  while (bigBooksCache.size > BIG_BOOKS_CACHE_LIMIT) {
    const oldest = bigBooksCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    bigBooksCache.delete(oldest);
  }
  if (key === currentKey) {
    lastBooks = result;
    sink?.(result);
  }
}

function emptyBooks(): ThroughputResult {
  return {
    nodes: {},
    storages: {},
    resources: {},
    edges: {},
    totalEuT: 0,
    totalEuPerSecond: 0,
    bottlenecks: [],
    externalInputs: [],
    unconsumedOutputs: [],
    generatedAt: new Date().toISOString(),
    stale: true,
  };
}
