# Solver (src/lib/solver)

Doctrine: if it would fail in the game, it fails in the planner; otherwise everything
runs. A fed machine with somewhere to put its output never idles. Nothing comes from
nowhere or goes nowhere except through a source, a drawer or trash.

## The books

`throughput.ts` is the entry. Every card gets its nameplate report first (overclock, parallels, power stall,
runtime tables); then the plan solver (`plan/`, `planSolve`) sizes the plan from its pins, port rates and drawer
rules and writes every rate at the solved scale. The graph it reads is `solveGraph` (`hatch-supply.ts`): shared
machines as one hidden node per recipe section, then the private hatch supplies. Anything that walks the solved
graph asks `solveGraph(project)` first.

- Engines: `lp-engine.ts` uses HiGHS (WASM) when loaded, else the homegrown simplex
  (`simplex.ts`). The plan solver runs integer programs, which only HiGHS does, so the books solve in the worker
  whenever there is one (`src/store/solve-books.ts`).
- The answer a player sees is counted work, never a clock. The one clock is the server's: `setLpSolveDefaults`
  (`timeLimitSeconds` -> HiGHS `time_limit`, a stopped solve throws `LpTimeLimitError` and never falls back to the
  simplex, and `runModel` tries no other HiGHS setting after it: one model, one time limit) and `withLpDeadline` in
  `plan/lp.ts` (past it `runModel` rejects with the "time budget" note and runs no LP) are set only by
  `src/lib/server/plan-engine.ts` for the stats solve of an uploaded plan. The browser, the worker and the suite
  never set them. Exams: `lp-engine-limits.test.ts`, `plan/lp-deadline.test.ts`, `plan/lp-time-limit.test.ts`.
- Plan solver dust (`plan/validate.ts` `dustScales`) is judged per network, never over the whole point: a
  reactor's billions of EU a second must not zero a 0.03/s item wire (the answer then fails its own check).
- Node rates in results are FULL SPEED; actual = nameplate x `min(1, max(0, utilization))`. Balance dust snaps at
  1e-5 relative (`balances.ts`).
- A power-stalled card is flagged (`powerStalled`, its warning) with its nameplate shape kept; the card's power
  cell says why.
- Exams: the plan corpus and parity (`plan/__fixtures__/golden.test.ts`, `plan/parity/scenarios.test.ts`,
  `plan/adapter/parity.test.ts`), `simplex.test.ts`.

## Drawers and rules

- `model/storage-target.ts` is the one interpretation of `targetPerSecond` / `targetMode`
  (at-least, exact, ignore, at-most). At most is a ceiling, not a demand.
- A buffer wired only to cards is a BUFFER drawer (`DrawerIn.takers`), its rule a product's on what passes through
  (`docs/buffer-drawers.md`); `adapter/buffers.ts` joins only buffers wired to another drawer.
  The solver change mirrors the mod's line for line; adding any feature to both: `docs/cross-repo-features.md`.
- An unconverted card (`FactoryNode.unconverted`, a section's `extraRecipes[i].unconverted`) is out of the solve
  (`missing-recipe`, a warning), even if its recipe id resolves. Every wire of it is the plan's edge: `buildPlanModel`
  adds a hidden `unconverted:<edgeId>` SOURCE or PRODUCT with rule ANY on the machine port, or on a buffer's takers or
  makers. A source or product drawer wired only to it is left out. Exams: `plan/adapter/unconverted.test.ts`.
- Drain drawers cycle product / byproduct / trash. Trash is free disposal with its books
  voided (`applyTrashedOutputBalances`). Old trash-can nodes convert on load.
- A loose drawer (`poolSide`, unwired) keeps the side it was made on until a wire says.

## Coupling and verdicts

The verdict code lives in `src/components/flow/` (`node-verdict.ts`, `bare-slots.ts`). A card reads off,
without a recipe, UNWIRED (a slot with no wire, every bare slot marked), running or not needed; why a plan cannot
be met is the plan solver's to say (its notices and readouts), never the card's.

- Shared machines: `expandSharedMachines` stands each extra section up as a hidden node; the sections share one
  machine's time.
- No wire crosses forms: a cell meets its fluid in a visible fluid tank card, a machine step like any other
  (`model/cell-wires.ts` turns an older plan's loose cell wires into tanks before the solver sees them).

## Machine math

`overclock.ts` and `hatch-input.ts` live here; the rules are in
`src/lib/machines/CLAUDE.md`. Steam litres: `getNodeSteamReport` in `power-report.ts`.
