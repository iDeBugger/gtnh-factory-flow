/**
 * The LP layer of the plan solver (spec-solver 3.3): a small model builder (columns with bounds and a cost, rows with
 * bounds), the base model every stage starts from, and the one place a model runs. A point is believed only after the
 * independent conservation check; an infeasible or non-conserving answer is retried under other HiGHS settings before
 * it is believed (spec 7.3).
 */
import { solveLpAuto } from "../lp-engine";
import type { LinearProgram } from "../simplex";
import { note, type SolveContext, type StageOutcome } from "./context";
import { TICKS_PER_SECOND } from "./model";
import type { Note } from "./types";

export interface LpRow {
  cols: number[];
  vals: number[];
  lo: number;
  hi: number;
}

/** Columns: extents (M), flows (E), externals (P), then any extras (drawer slacks, the push's level, probes' supply). */
export class ModelLp {
  readonly lo: number[] = [];
  readonly hi: number[] = [];
  readonly cost: number[] = [];
  readonly rows: LpRow[] = [];
  readonly nMachines: number;
  readonly nEdges: number;
  readonly nPorts: number;
  /** Per drawer, the relaxation's slack columns (-1 when none). */
  drawerUnder: number[] = [];
  drawerOver: number[] = [];
  /** Per connected port, its conservation row. */
  readonly conservation: LpRow[] = [];
  /** Extra columns that cross the boundary at a port (`feedPort`): the independent check counts them as its external. */
  readonly fed: Array<{ col: number; port: number }> = [];

  constructor(ctx: SolveContext) {
    this.nMachines = ctx.model.machines.length;
    this.nEdges = ctx.model.edges.length;
    this.nPorts = ctx.model.connectedPorts.length;
    for (let m = 0; m < this.nMachines; m++) {
      const pinned = ctx.pinnedExtent[m]!;
      if (Number.isNaN(pinned)) this.addColumn(0, Infinity, 0);
      else this.addColumn(pinned, pinned, 0);
    }
    for (let e = 0; e < this.nEdges; e++) this.addColumn(0, Infinity, 0);
    for (let p = 0; p < this.nPorts; p++) this.addColumn(0, Infinity, 0);
  }

  extentCol(m: number): number {
    return m;
  }
  flowCol(e: number): number {
    return this.nMachines + e;
  }
  extCol(p: number): number {
    return this.nMachines + this.nEdges + p;
  }

  addColumn(lo: number, hi: number, cost: number): number {
    this.lo.push(lo);
    this.hi.push(hi);
    this.cost.push(cost);
    return this.lo.length - 1;
  }

  addRow(cols: number[], vals: number[], lo: number, hi: number): LpRow {
    const row = { cols, vals, lo, hi };
    this.rows.push(row);
    return row;
  }

  /** Closes external `p`: it can carry nothing. */
  closeExt(p: number): void {
    this.hi[this.extCol(p)] = 0;
  }

  setExtCost(p: number, cost: number): void {
    this.cost[this.extCol(p)] = cost;
  }

  setFlowCost(e: number, cost: number): void {
    this.cost[this.flowCol(e)] = cost;
  }

  /**
   * A free crossing at connected port `p`, outside every trade, guard and drawer row: supply at an input, a sink at an
   * output (the Up to read-out's probes). Enters the port's conservation row as its external does.
   */
  feedPort(p: number): number {
    const row = this.conservation[p]!;
    const ext = this.extCol(p);
    const col = this.addColumn(0, Infinity, 0);
    row.cols.push(col);
    row.vals.push(row.vals[row.cols.indexOf(ext)]!);
    this.fed.push({ col, port: p });
    return col;
  }
}

/** A pool's level (machine time over capacity) as row terms over the extents. */
export function levelTerms(
  ctx: SolveContext,
  lp: ModelLp,
  pool: number,
): { cols: number[]; vals: number[] } {
  const data = ctx.model.pools[pool]!;
  return {
    cols: data.machines.map((m) => lp.extentCol(m)),
    vals: data.machines.map(
      (m) => ctx.model.machines[m]!.durTicks / TICKS_PER_SECOND / data.capacity,
    ),
  };
}

/** Adds `weight` times a pool's level to the objective (minimised: a negative weight pushes it up). */
export function priceLevel(ctx: SolveContext, lp: ModelLp, pool: number, weight: number): void {
  const { cols, vals } = levelTerms(ctx, lp, pool);
  cols.forEach((c, i) => {
    lp.cost[c] = lp.cost[c]! + weight * vals[i]!;
  });
}

/** Pool rows: the machines of a shared machine spend at most (or exactly) its capacity in machine time. */
function addPools(ctx: SolveContext, lp: ModelLp): void {
  ctx.model.pools.forEach((pool, p) => {
    if (ctx.droppedPools.has(p)) return;
    const cols = pool.machines.map((m) => lp.extentCol(m));
    const vals = pool.machines.map((m) => ctx.model.machines[m]!.durTicks / TICKS_PER_SECOND);
    lp.addRow(cols, vals, pool.exact ? pool.capacity : -Infinity, pool.capacity);
  });
}

/** Per connected port: drawn flows plus the boundary crossing equal what the machine makes or takes there. */
function addConservation(ctx: SolveContext, lp: ModelLp): void {
  ctx.model.connectedPorts.forEach((port, p) => {
    const scale = 1 / Math.max(1, port.qtyPerCraft);
    const cols: number[] = [];
    const vals: number[] = [];
    for (const e of port.edges) {
      cols.push(lp.flowCol(e));
      vals.push(scale);
    }
    cols.push(lp.extCol(p));
    vals.push(scale);
    cols.push(lp.extentCol(port.machine));
    vals.push(-port.qtyPerCraft * scale);
    lp.conservation.push(lp.addRow(cols, vals, 0, 0));
  });
}

/** Drawer rows; `relaxed` gives each bound a nonnegative slack, priced 1/max(1, bound) (the relaxation LP). */
export function addDrawerRows(ctx: SolveContext, lp: ModelLp, relaxed: boolean): void {
  const model = ctx.model;
  lp.drawerUnder = new Array<number>(model.drawers.length).fill(-1);
  lp.drawerOver = new Array<number>(model.drawers.length).fill(-1);
  model.drawers.forEach((drawer, d) => {
    const lower = ctx.drawerLower[d]!;
    const upper = ctx.drawerUpper[d]!;
    if (Number.isNaN(lower) && Number.isNaN(upper)) return;
    const bound = Math.max(Number.isNaN(lower) ? 0 : lower, Number.isNaN(upper) ? 0 : upper);
    const scale = 1 / Math.max(1, bound);
    const cols: number[] = [];
    const vals: number[] = [];
    drawer.extentMachines.forEach((m, i) => {
      cols.push(lp.extentCol(m));
      vals.push(drawer.extentQty[i]! * scale);
    });
    // A buffer's total is the flow on its edges.
    for (const e of drawer.flowEdges) {
      cols.push(lp.flowCol(e));
      vals.push(scale);
    }
    for (const p of drawer.externalPorts) {
      cols.push(lp.extCol(p));
      vals.push(scale);
    }
    if (relaxed) {
      const weight = 1 / Math.max(1, bound);
      if (!Number.isNaN(lower)) {
        lp.drawerUnder[d] = lp.addColumn(0, Infinity, weight);
        cols.push(lp.drawerUnder[d]!);
        vals.push(scale);
      }
      if (!Number.isNaN(upper)) {
        lp.drawerOver[d] = lp.addColumn(0, Infinity, weight);
        cols.push(lp.drawerOver[d]!);
        vals.push(-scale);
      }
    }
    lp.addRow(
      cols,
      vals,
      Number.isNaN(lower) ? -Infinity : lower * scale,
      Number.isNaN(upper) ? Infinity : upper * scale,
    );
  });
}

/**
 * The guard (docs/up-to.md): the guarded externals closed, or held together to the least they can be. Nothing when
 * the context has none or has it switched off.
 */
function addGuard(ctx: SolveContext, lp: ModelLp): void {
  const guard = ctx.guard;
  if (guard === null || ctx.guardOff) return;
  if (guard.cap <= 0) {
    for (const p of guard.ports) lp.closeExt(p);
    return;
  }
  lp.addRow(
    guard.ports.map((p) => lp.extCol(p)),
    guard.ports.map((p) => ctx.externalWeight(p)),
    -Infinity,
    guard.cap,
  );
}

export interface BaseOptions {
  /** The drawer rows (default true). */
  drawers?: boolean;
  /** The context's guard (default true; the guard's own LP leaves it out). */
  guard?: boolean;
}

/** extents + pools + flows + externals + conservation + drawers + the guard, every cost zero. */
export function baseModel(ctx: SolveContext, options: BaseOptions = {}): ModelLp {
  const lp = new ModelLp(ctx);
  addPools(ctx, lp);
  addConservation(ctx, lp);
  if (options.drawers !== false) addDrawerRows(ctx, lp, false);
  if (options.guard !== false) addGuard(ctx, lp);
  return lp;
}

/** The relaxation LP: the base model without drawers, then drawers with slacks, then the guard. */
export function relaxedModel(ctx: SolveContext): ModelLp {
  const lp = new ModelLp(ctx);
  addPools(ctx, lp);
  addConservation(ctx, lp);
  addDrawerRows(ctx, lp, true);
  addGuard(ctx, lp);
  return lp;
}

/** Closes every external outside `open`'s gates, except what a buffer banks (it is no gate: docs/up-to.md). */
export function closeGatesOutside(ctx: SolveContext, lp: ModelLp, open: ReadonlySet<number>): void {
  for (let p = 0; p < lp.nPorts; p++) {
    if (!open.has(ctx.model.portGate[p]!) && !ctx.bankPorts.has(p)) lp.closeExt(p);
  }
}

// ---------------------------------------------------------------------------
// Running a model
// ---------------------------------------------------------------------------

export type SolveResult =
  | { ok: true; point: StageOutcome; x: number[] }
  | { ok: false; rejection: Note };

/**
 * HiGHS settings tried in turn; the first conserving answer wins. "No solution" is believed once two of them say so
 * (the Java believes it when its two simplex set-ups agree); the third is for answers that are wrong, not absent.
 */
const OPINIONS: Array<Record<string, number | string | boolean>> = [
  {},
  { presolve: "off" },
  {
    presolve: "off",
    solver: "simplex",
    simplex_strategy: 4,
    primal_feasibility_tolerance: 1e-9,
    dual_feasibility_tolerance: 1e-9,
  },
];

/** Settings that must say "no solution" before it is believed. */
const VERDICTS_NEEDED = 2;

let columnOrder: "forward" | "reverse" = "forward";
let lpCount = 0;
let lpHook: ((label: string) => void) | null = null;
/** The wall-clock moment past which no further LP runs, or null when none is set. */
let lpDeadline: number | null = null;

/**
 * Runs `run` with a deadline: once `ms` have passed, every later model is
 * rejected with the time budget note instead of being solved, so a plan that
 * would take minutes fails within the budget plus one LP. Synchronous, so two
 * callers never interleave; nested calls keep the outer deadline when it is
 * nearer. For the server's stats solve of an uploaded plan alone: the answer
 * a player sees on the board is counted work, never a clock.
 */
export function withLpDeadline<T>(ms: number, run: () => T): T {
  const previous = lpDeadline;
  const deadline = Date.now() + ms;
  lpDeadline = previous === null ? deadline : Math.min(previous, deadline);
  try {
    return run();
  } finally {
    lpDeadline = previous;
  }
}

function pastDeadline(): boolean {
  return lpDeadline !== null && Date.now() >= lpDeadline;
}

/** Tests only: models add their columns in reverse order, a different path to the same optima. */
export function setColumnOrder(order: "forward" | "reverse"): void {
  columnOrder = order;
}

/** Counted work (never a clock): how many LPs have run since the counter was last read and cleared. */
export function takeLpCount(): number {
  const n = lpCount;
  lpCount = 0;
  return n;
}

/** Tests: a callback before every LP (a stop signal that throws makes the next LP never run). */
export function setLpHook(hook: ((label: string) => void) | null): void {
  lpHook = hook;
}

const EMPTY_TOL = 1e-7;

interface Lowered {
  program: LinearProgram;
  /** For each model column, its program column or -1 when fixed. */
  colOf: number[];
  fixed: number[];
  infeasible: boolean;
}

export function lower(lp: ModelLp): Lowered {
  const n = lp.lo.length;
  const colOf = new Array<number>(n).fill(-1);
  const fixed = new Array<number>(n).fill(0);
  const free: number[] = [];
  for (let c = 0; c < n; c++) {
    if (lp.lo[c] === lp.hi[c]) fixed[c] = lp.lo[c]!;
    else free.push(c);
  }
  if (columnOrder === "reverse") free.reverse();
  free.forEach((c, k) => {
    colOf[c] = k;
    if (lp.lo[c] !== 0) throw new Error("plan LP: a non-fixed column must start at 0");
  });
  const program: LinearProgram = {
    maximize: free.map((c) => -lp.cost[c]!),
    equalities: [],
    upperBounds: [],
  };
  let infeasible = false;
  // finite upper bounds on free columns become rows
  free.forEach((c, k) => {
    const hi = lp.hi[c]!;
    if (Number.isFinite(hi)) program.upperBounds.push({ coefficients: new Map([[k, 1]]), rhs: hi });
  });
  for (const row of lp.rows) {
    const coefficients = new Map<number, number>();
    let constant = 0;
    for (let i = 0; i < row.cols.length; i++) {
      const c = row.cols[i]!;
      const v = row.vals[i]!;
      if (v === 0) continue;
      const k = colOf[c]!;
      if (k < 0) constant += v * fixed[c]!;
      else coefficients.set(k, (coefficients.get(k) ?? 0) + v);
    }
    const lo = row.lo - constant;
    const hi = row.hi - constant;
    if (coefficients.size === 0) {
      const finite = [row.lo, row.hi, constant].filter(Number.isFinite).map(Math.abs);
      const tol = EMPTY_TOL * Math.max(1, ...finite);
      if (lo > tol || hi < -tol) infeasible = true;
      continue;
    }
    if (row.lo === row.hi) {
      program.equalities.push({ coefficients, rhs: lo });
      continue;
    }
    if (Number.isFinite(hi)) program.upperBounds.push({ coefficients, rhs: hi });
    if (Number.isFinite(lo)) {
      program.upperBounds.push({
        coefficients: new Map([...coefficients].map(([k, v]) => [k, -v] as [number, number])),
        rhs: -lo,
      });
    }
  }
  return { program, colOf, fixed, infeasible };
}

/**
 * Runs a model under each HiGHS setting until one returns a point that passes the independent check. `label` names
 * the stage in the rejection.
 */
export function runModel(ctx: SolveContext, lp: ModelLp, label: string): SolveResult {
  if (pastDeadline()) {
    ctx.rejection = note("SOLVER_UNSATISFIABLE", "time budget");
    return { ok: false, rejection: ctx.rejection };
  }
  lpHook?.(label);
  lpCount++;
  const lowered = lower(lp);
  if (lowered.infeasible) {
    ctx.rejection = note("SOLVER_UNSATISFIABLE", "infeasible");
    return { ok: false, rejection: ctx.rejection };
  }
  let last: Note = note("SOLVER_UNSATISFIABLE", "infeasible");
  let verdicts = 0;
  for (const opinion of OPINIONS) {
    let solution;
    try {
      solution = solveLpAuto(lowered.program, { highsOptions: opinion, exactPrimal: true });
    } catch (error) {
      last = note("SOLVER_UNSATISFIABLE", error instanceof Error ? error.message : String(error));
      continue;
    }
    if (solution.status !== "optimal") {
      last = note("SOLVER_UNSATISFIABLE", solution.status);
      if (++verdicts >= VERDICTS_NEEDED) break;
      continue;
    }
    // `+ 0` turns a negative zero into a zero
    const x = lp.lo.map((_, c) => {
      const k = lowered.colOf[c]!;
      return (k < 0 ? lowered.fixed[c]! : (solution.x[k] ?? 0)) + 0;
    });
    const extents = x.slice(0, lp.nMachines);
    const flows = x.slice(lp.nMachines, lp.nMachines + lp.nEdges);
    const externals = x.slice(lp.nMachines + lp.nEdges, lp.nMachines + lp.nEdges + lp.nPorts);
    for (const { col, port } of lp.fed) externals[port] = externals[port]! + x[col]!;
    const residual = ctx.validate(extents, flows, externals);
    if (residual !== null) {
      last = note("SOLVER_NOT_CONSERVING", residual);
      continue;
    }
    return { ok: true, point: ctx.outcome(extents, flows, externals), x };
  }
  ctx.rejection = last;
  return { ok: false, rejection: last };
}

/**
 * One run of a model the check does not apply to (a relaxation that is allowed to break rows), under the first HiGHS
 * setting only, with the dual of every row. Returns null when there is no HiGHS or no optimum: the caller then rules
 * nothing out. Counted like any LP.
 */
export function runRelaxation(
  lp: ModelLp,
  label: string,
): { lowered: Lowered; x: number[]; objective: number; rowDuals: number[] } | null {
  if (pastDeadline()) return null;
  lpHook?.(label);
  lpCount++;
  const lowered = lower(lp);
  if (lowered.infeasible) return null;
  let solution;
  try {
    solution = solveLpAuto(lowered.program, { rowDuals: true });
  } catch {
    return null;
  }
  if (solution.status !== "optimal" || !solution.rowDuals) return null;
  const x = lp.lo.map((_, c) => {
    const k = lowered.colOf[c]!;
    return (k < 0 ? lowered.fixed[c]! : (solution.x[k] ?? 0)) + 0;
  });
  return { lowered, x, objective: solution.objective, rowDuals: solution.rowDuals };
}
