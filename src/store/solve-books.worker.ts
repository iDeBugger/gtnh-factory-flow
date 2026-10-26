import { calculateThroughput } from "@/lib/solver";
import { initLpEngine } from "@/lib/solver/lp-engine";
import type { FactoryProject } from "@/lib/model/types";

// HiGHS loads once at worker startup, and every solve waits for the load to
// settle. A failed load resolves too - solves then run on the homegrown simplex.
// The route serves them from the package in any start mode; public/ (copied by predev and prebuild) is the fallback.
const engineReady = initLpEngine({
  glueUrl: "/api/highs/highs.js",
  wasmUrl: "/api/highs/highs.wasm",
  fallback: { glueUrl: "/highs.js", wasmUrl: "/highs.wasm" },
});

/**
 * The solver, off the main thread. One message in (a plan and the content key
 * that names it), one message out (the same key and the finished books). The
 * scheduling - coalescing rapid edits, dropping superseded solves, deciding
 * which result is still current - all lives on the store side in
 * `solve-books.ts`; this file stays a dumb calculator on purpose.
 */
self.onmessage = async (event: MessageEvent<{ key: string; project: FactoryProject }>) => {
  const { key, project } = event.data;
  try {
    await engineReady;
    self.postMessage({ key, result: calculateThroughput(project) });
  } catch (error) {
    self.postMessage({ key, error: error instanceof Error ? error.message : String(error) });
  }
};
