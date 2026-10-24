import { solveBasis, type BasisRow } from "./exact-basis";
import { solveLp, type LinearProgram, type LpSolution } from "./simplex";

/**
 * The LP engine switchboard: HiGHS (MIT, WASM) behind the homegrown solver's
 * exact interface. The homegrown dense simplex re-walks the whole tableau for
 * every staged solve, so boards with many fairness stages pay seconds for
 * what HiGHS answers in milliseconds.
 *
 * Nothing switches until `initLpEngine` is awaited: the solve worker calls
 * it at startup, while the main thread, SSR and the test suite keep the
 * synchronous homegrown path. The stage chain locks each objective VALUE,
 * not its vertex, so the two engines agree on the books wherever the answer
 * is determined (an equivalence test pins this). Any load or solve failure
 * falls back to the homegrown engine, never to a missing answer.
 */

interface HighsInstance {
  solve: (
    lpText: string,
    options?: Record<string, number | string | boolean>,
  ) => {
    Status: string;
    Columns: Record<string, { Primal: number; Status?: string }>;
    Rows?: Array<{ Status?: string; Dual?: number | null }>;
  };
}

let highs: HighsInstance | undefined;
let loading: Promise<boolean> | undefined;

export function initLpEngine(
  options: { wasmUrl?: string; glueUrl?: string; fallback?: { wasmUrl: string; glueUrl: string } } = {},
): Promise<boolean> {
  loading ??= (async () => {
    try {
      if (options.glueUrl) {
        try {
          highs = await loadBrowserHighs(options.glueUrl, options.wasmUrl);
        } catch (error) {
          // The first place may not have the files in every start mode; the fallback says where else they live.
          if (!options.fallback) throw error;
          highs = await loadBrowserHighs(options.fallback.glueUrl, options.fallback.wasmUrl);
        }
      } else {
        highs = await loadNodeHighs(options.wasmUrl);
      }
      return true;
    } catch (error) {
      console.error("HiGHS failed to load; the homegrown simplex stays on.", error);
      return false;
    }
  })();
  return loading;
}

/** Tests and any node-side solve: the package loads its own wasm from disk. */
async function loadNodeHighs(wasmUrl?: string): Promise<HighsInstance> {
  const factory = (await import("highs")).default;
  // A bundled server build rewrites the package's own directory to "/ROOT/...", where the wasm is not, and the
  // homegrown simplex then solves plan-mode plans on the request thread (it held the live site for minutes on
  // 2026-10-17). The package's files sit under the app's node_modules wherever it runs.
  const located = wasmUrl ?? `${process.cwd()}/node_modules/highs/build/highs.wasm`;
  return (await factory({ locateFile: () => located })) as unknown as HighsInstance;
}

/**
 * The browser path fetches the emscripten glue from public/ and evaluates it
 * outside the bundler, so the glue stays byte-identical to the package's
 * build and the worker chunk stays small. The glue is UMD: with no module
 * system in scope it leaves its factory in a top-level `Module` var, which
 * the wrapper returns.
 */
async function loadBrowserHighs(glueUrl: string, wasmUrl?: string): Promise<HighsInstance> {
  const response = await fetch(glueUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch ${glueUrl} (${response.status}).`);
  }
  const source = await response.text();
  const factory = new Function(`${source}; return Module;`)() as (options?: {
    locateFile?: (file: string) => string;
  }) => Promise<HighsInstance>;
  return factory(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
}

export function activeLpEngine(): "highs" | "simplex" {
  return highs ? "highs" : "simplex";
}

/**
 * Limits for a solve. A branch-and-bound budget is a count of nodes, never a
 * clock, so the same program gives the same answer on a fast and a slow
 * machine; the clock exists for the server alone (`setLpSolveDefaults`),
 * whose stats path needs an answer or an honest failure, never a board.
 */
export interface LpSolveOptions {
  maxMipNodes?: number;
  /**
   * HiGHS' `time_limit`, in seconds. A solve it stops throws `LpTimeLimitError`
   * rather than reporting the program unbounded, and never falls back to the
   * homegrown simplex (which has no clock). Server only; see the doc above.
   */
  timeLimitSeconds?: number;
  /** Raw HiGHS options (presolve, tolerances, simplex strategy), for a second opinion on a doubtful answer. */
  highsOptions?: Record<string, number | string | boolean>;
  /**
   * Recompute the vertex to full double precision from HiGHS' basis. The wrapper prints column values to six
   * significant digits; callers that compare at 1e-6 or check conservation need more. Keeps HiGHS' numbers when the
   * basis does not describe a vertex.
   */
  exactPrimal?: boolean;
  /** Also return the dual of every row (see `LpSolution.rowDuals`). */
  rowDuals?: boolean;
}

export function hasIntegerColumns(lp: LinearProgram): boolean {
  return (lp.integers?.length ?? 0) > 0 || (lp.binaries?.length ?? 0) > 0;
}

/** HiGHS stopped on the clock a caller set: no answer, and no fallback. */
export class LpTimeLimitError extends Error {
  constructor(seconds: number) {
    super(`HiGHS stopped at its ${seconds} s time limit.`);
    this.name = "LpTimeLimitError";
  }
}

type LpSolveDefaults = Pick<LpSolveOptions, "timeLimitSeconds" | "maxMipNodes">;

let solveDefaults: LpSolveDefaults | null = null;

/**
 * Process-wide limits under every caller's own options (the caller's win).
 * Only the server sets them, once, before it solves uploaded plans on the
 * request thread; the browser, the worker and the test suite leave them
 * unset, so no board ever sees a clock. `null` clears them.
 */
export function setLpSolveDefaults(defaults: LpSolveDefaults | null): void {
  solveDefaults = defaults;
}

export function solveLpAuto(lp: LinearProgram, options: LpSolveOptions = {}): LpSolution {
  if (solveDefaults) {
    options = { ...solveDefaults, ...options };
  }
  if (highs) {
    try {
      return solveWithHighs(highs, lp, options);
    } catch (error) {
      if (error instanceof LpTimeLimitError) {
        throw error;
      }
      if (hasIntegerColumns(lp)) {
        // No honest fallback: the homegrown simplex cannot branch.
        throw new Error(
          `HiGHS failed on a program with integer variables: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      console.error("HiGHS solve failed; falling back to the homegrown simplex.", error);
    }
  }
  // Throws IntegerVariablesUnsupportedError when the program has integer
  // columns and HiGHS is not loaded.
  return solveLp(lp);
}

function solveWithHighs(
  instance: HighsInstance,
  lp: LinearProgram,
  solveOptions: LpSolveOptions = {},
): LpSolution {
  const n = lp.maximize.length;
  const integerColumns = new Set(lp.integers ?? []);
  const binaryColumns = new Set(lp.binaries ?? []);
  for (const c of [...integerColumns, ...binaryColumns]) {
    if (!Number.isInteger(c) || c < 0 || c >= n) {
      throw new Error(`Integer column ${c} is not a column of the program.`);
    }
  }
  const isWhole = (c: number) => integerColumns.has(c) || binaryColumns.has(c);
  // Port rows divide by throughput, so late-game flows can have coefficients
  // below HiGHS' small-matrix cutoff. Change variable units before handing
  // those rows to it: x = columnScale * y. This preserves the same equations
  // and objective instead of letting the engine discard a real flow term.
  const columnScale = new Array<number>(n).fill(1);
  for (const row of [...lp.equalities, ...lp.upperBounds]) {
    for (const [c, value] of row.coefficients) {
      // A whole-number column keeps its units: rescaling it would change what
      // "integer" means.
      if (value !== 0 && Math.abs(value) < 1e-8 && !isWhole(c)) {
        columnScale[c] = Math.max(columnScale[c]!, 1 / Math.abs(value));
      }
    }
  }
  const scaledObjective = lp.maximize.map((value, c) => value * columnScale[c]!);
  const objectiveScale = Math.max(1, ...scaledObjective.map(Math.abs));
  const scaledRow = (row: LinearProgram["equalities"][number]) => {
    const coefficients = new Map([...row.coefficients].map(([c, value]) => [c, value * columnScale[c]!]));
    const largest = Math.max(0, ...[...coefficients.values()].map(Math.abs));
    // A row that touches a whole-number column cannot move its tiny entries
    // into column units, so it is scaled UP instead: the solver's feasibility
    // tolerance is absolute, and an unscaled 1e-9 x <= 3e-9 would let x run to
    // dozens.
    const touchesWhole = [...row.coefficients.keys()].some(isWhole);
    const scale = touchesWhole && largest > 0 ? largest : Math.max(1, largest);
    return { coefficients: new Map([...coefficients].map(([c, value]) => [c, value / scale])), rhs: row.rhs / scale };
  };

  const term = (value: number, index: number) =>
    `${value < 0 ? "- " : "+ "}${format(Math.abs(value))} x${index}`;
  const lines: string[] = ["Maximize", ""];
  const objTerms: string[] = [];
  for (let c = 0; c < n; c += 1) {
    const v = scaledObjective[c]! / objectiveScale;
    if (v !== 0) {
      objTerms.push(term(v, c));
    }
  }
  lines[1] = ` obj: ${objTerms.length > 0 ? objTerms.join(" ") : "0 x0"}`;
  lines.push("Subject To");
  let rowIndex = 0;
  const writtenRows: BasisRow[] = [];
  const writtenIndex: number[] = [];
  let originalIndex = 0;
  for (const originalRow of lp.equalities) {
    const rowNumber = originalIndex++;
    const row = scaledRow(originalRow);
    const terms: string[] = [];
    for (const [c, v] of row.coefficients) {
      if (v !== 0) {
        terms.push(term(v, c));
      }
    }
    if (terms.length === 0) {
      continue;
    }
    lines.push(` e${rowIndex}: ${terms.join(" ")} = ${format(row.rhs)}`);
    writtenRows.push(originalRow);
    writtenIndex.push(rowNumber);
    rowIndex += 1;
  }
  for (const originalRow of lp.upperBounds) {
    const rowNumber = originalIndex++;
    const row = scaledRow(originalRow);
    const terms: string[] = [];
    for (const [c, v] of row.coefficients) {
      if (v !== 0) {
        terms.push(term(v, c));
      }
    }
    if (terms.length === 0) {
      continue;
    }
    lines.push(` u${rowIndex}: ${terms.join(" ")} <= ${format(row.rhs)}`);
    writtenRows.push(originalRow);
    writtenIndex.push(rowNumber);
    rowIndex += 1;
  }
  // A column that no row or objective term names is not in the program HiGHS
  // reads, so it cannot be declared whole either; it solves to 0.
  const named = new Set<number>();
  for (const row of [...lp.equalities, ...lp.upperBounds]) {
    for (const [c, v] of row.coefficients) {
      if (v !== 0) {
        named.add(c);
      }
    }
  }
  lp.maximize.forEach((v, c) => {
    if (v !== 0) {
      named.add(c);
    }
  });
  const declared = (columns: Set<number>) =>
    [...columns].filter((c) => named.has(c)).sort((a, b) => a - b);
  const generals = declared(integerColumns).filter((c) => !binaryColumns.has(c));
  const binaries = declared(binaryColumns);
  if (generals.length > 0) {
    lines.push("General", ` ${generals.map((c) => `x${c}`).join(" ")}`);
  }
  if (binaries.length > 0) {
    lines.push("Binary", ` ${binaries.map((c) => `x${c}`).join(" ")}`);
  }
  lines.push("End");

  const mip = generals.length > 0 || binaries.length > 0;
  const highsOptions: Record<string, number | string | boolean> = { ...solveOptions.highsOptions };
  if (mip && solveOptions.maxMipNodes !== undefined) {
    highsOptions.mip_max_nodes = solveOptions.maxMipNodes;
  }
  if (solveOptions.timeLimitSeconds !== undefined) {
    highsOptions.time_limit = solveOptions.timeLimitSeconds;
  }
  const solved = instance.solve(
    lines.join("\n"),
    Object.keys(highsOptions).length > 0 ? highsOptions : undefined,
  );
  if (solveOptions.timeLimitSeconds !== undefined && solved.Status === "Time limit reached") {
    throw new LpTimeLimitError(solveOptions.timeLimitSeconds);
  }
  if (solved.Status !== "Optimal") {
    if (mip && !["Infeasible", "Unbounded", "Unbounded or Infeasible"].includes(solved.Status)) {
      // Node budget spent, time limit, model error: there is no answer to
      // trust, and it is not "infeasible".
      throw new Error(`HiGHS stopped with status "${solved.Status}".`);
    }
    const status = solved.Status === "Infeasible" ? ("infeasible" as const) : ("unbounded" as const);
    return { status, x: [], objective: Number.NaN };
  }
  const x = new Array<number>(n).fill(0);
  for (let c = 0; c < n; c += 1) {
    const value = (solved.Columns[`x${c}`]?.Primal ?? 0) * columnScale[c]!;
    // The solver keeps integers within its feasibility tolerance; hand back
    // the whole number it meant.
    x[c] = isWhole(c) && Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) + 0 : value;
  }
  if (solveOptions.exactPrimal && !mip) {
    refineWithBasis(solved, writtenRows, x);
  }
  let objective = 0;
  for (let c = 0; c < n; c += 1) {
    objective += lp.maximize[c]! * x[c]!;
  }
  if (solveOptions.rowDuals && !mip) {
    const rowDuals = new Array<number>(originalIndex).fill(0);
    (solved.Rows ?? []).forEach((r, i) => {
      const dual = (r as { Dual?: number | null }).Dual;
      if (writtenIndex[i] !== undefined && typeof dual === "number" && Number.isFinite(dual)) rowDuals[writtenIndex[i]!] = dual;
    });
    return { status: "optimal", x, objective, rowDuals };
  }
  return { status: "optimal", x, objective };
}

/**
 * Overwrites the basic columns of `x` with the exact solution of the basis system (see exact-basis.ts). Rows are the
 * program's own (unscaled) rows; a row is tight when its status is not basic. Leaves `x` alone when the basis is not
 * a square, non-singular vertex.
 */
function refineWithBasis(
  solved: { Columns: Record<string, { Status?: string }>; Rows?: Array<{ Status?: string }> },
  rows: BasisRow[],
  x: number[],
): void {
  const solvedRows = solved.Rows;
  if (!solvedRows || solvedRows.length !== rows.length) return;
  const tight: BasisRow[] = [];
  solvedRows.forEach((r, i) => {
    if (r.Status !== "BS") tight.push(rows[i]!);
  });
  const basic: number[] = [];
  for (let c = 0; c < x.length; c += 1) {
    if (solved.Columns[`x${c}`]?.Status === "BS") basic.push(c);
  }
  const exact = solveBasis(tight, basic);
  if (exact === null) return;
  for (const [c, v] of exact) x[c] = v;
}

/** HiGHS accepts scientific notation; retain small nonzero coefficients. */
function format(value: number): string {
  return String(value);
}
