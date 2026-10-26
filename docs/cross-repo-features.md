# Adding a feature to both planners

Written 2026-10-14 by adding buffer drawers (`buffer-drawers.md`) to both the mod and the website, start to finish. The
mod is GTNH Planner (Java 25 downgraded to 8, Minecraft 1.7.10, this repo). The website is Factory Flow's one-mode board
(Next.js and TypeScript, `C:\Users\jack\gtnh-ff-backport`, branch `mod-backport`). A copy of this file lives in the
website at `docs/cross-repo-features.md`; change both together.

## How the two relate

- **The solver is one program in two languages.** The website's `src/lib/solver/plan/` is a line-for-line port of the
  mod's `data/flowchart/balancer/`. Both solve the same `SolveInput` and must give the same answer to 1e-6, ties
  included. The proof is the shared corpus: the mod's `src/test/resources/solver-corpus/` (inputs and `goldens/`) is
  copied into the website's `src/lib/solver/plan/__fixtures__/corpus/` (`inputs/`, `goldens/`), and both suites
  compare every answer to the same golden files.
- **The plan JSON is the website's.** The mod reads and writes Factory Flow's project JSON (`importer/`,
  `library/PlanExport`); the website stores it natively (`src/lib/model/types.ts`, `schemas.ts`). A feature that must
  travel between them has to have a shape in that JSON first.
- **Everything else is two separate implementations of one design**: the board, cards, drawers, rail, tips, sounds.
  The website follows the mod (`docs/design/backport/master-plan.md`: "when in doubt, make it exactly like the mod").
- **The two data models differ in kind.** The mod's drawers hold links to ports (`Drawer.links`, direction implied by
  `Drawer.Kind`); the website's drawers are graph nodes joined to cards by wires (`FactoryStorage` plus
  `FactoryEdge`s), and a drawer's role is read off its wires (`getStorageRoles`). The adapter
  (`src/lib/solver/plan/adapter/`) turns the website's graph into the solver's `SolveInput`; the mod builds it straight
  from its `Graph` (`SolveInput.of`).

## Side by side

| Concern | Mod (`src/main/java/com/gtnhplanner/`) | Website (`src/`) |
| --- | --- | --- |
| Solver input | `data/flowchart/balancer/SolveInput` (records) | `lib/solver/plan/types.ts` (`SolveInput`, `DrawerIn`...) |
| Model built once | `balancer/ModelData` (machines, edges, ports, drawers, gates, `portSteps`) | `lib/solver/plan/model.ts` (`buildModel`), `gates.ts` |
| Bounds and pins | `balancer/SolveContext` | `lib/solver/plan/context.ts` |
| LP rows | `balancer/ModelBuilder` | `lib/solver/plan/lp.ts` (`ModelLp`, `addDrawerRows`...) |
| Stages | `balancer/stages/` (`FastPathStage`, `TradeStage`, `FlowMinStage`), `Solver` | `fast-path.ts`, `trade.ts`, `flow-min.ts`, `canonical.ts` |
| Drawer relaxation | `balancer/DrawerRelaxation` | `relax.ts` (only when passed in: `planExtensions`) |
| Islands, merge | `balancer/Islands`, `Balancer.solveIslands` | `islands.ts`, `solve-plan.ts` |
| Answer | `SolutionView`, `DrawerReadout`, `Spares`, `alternatives/` | `solve-core.ts` (`buildSolutionView`, `drawerReadout`), `spares.ts`, `enumerate.ts` |
| Unset parts | `balancer/Unanchored` (from the `Graph`) | `adapter/unanchored.ts` (from the `SolveInput`) |
| Graph to input | `SolveInput.of(Graph)` | `adapter/model.ts` (`buildPlanModel`), `adapter/buffers.ts` |
| Answer to the board | `ui/BoardSession` (`tickBoard`, `extraFlows`, `buildTotals`), `ui/drawer/DrawerModel` | `adapter/answer.ts` (`readAnswer`), `adapter/finalize.ts` |
| Data model | `data/flowchart/Graph`, `Node`, `Drawer`, `Edge` | `lib/model/types.ts` (`FactoryProject`, `FactoryNode`, `FactoryStorage`, `FactoryEdge`) |
| Saves | `data/flowchart/Serializer` (Gson over the classes; `sanitize()` repairs) | `lib/model/schemas.ts` (zod), `project-normalize.ts`, `store/` |
| Plan JSON in | `importer/FfPlanParser` (JSON to `FfPlan`), `FfConverter`, `FfDrawers` | native |
| Plan JSON out | `library/PlanExport` (checked by `PlanExportTest` against the website's schema) | native |
| Card | `ui/card/RecipeCard`, `CardPaint`, `CardLayout`, `CardModel` | `components/flow/clean/CleanCard.tsx`, `clean-model.ts` |
| Drawer | `ui/drawer/DrawerCard` (controls, tips, menu), `DrawerPaint` (shape, colours), `DrawerModel` | `clean/drawer/CleanDrawer.tsx`, `drawer-model.ts` (view, tips), `drawer.css` |
| Colours | `ui/theme/Hyb`, `DrawerPaint.tint` (Java ints, `Hyb.mix` in float32) | `clean/tokens.ts` (`CC`, `drawerMixes`), `colors.ts` (`mixHex`, the same float32), hex in CSS |
| Wires | `ui/canvas/WireLayer` (routes card wires and drawer links) | React Flow edges; flows from `adapter/answer.ts` |
| Hover lighting | `ui/HoverScope` | `components/flow/flow-scope.ts` (`buildStorageFlowScope`...) |
| Count rule (Any, Up to, Exactly) | `data/flowchart/PinRule`, `Node.machineCountExact`, `MachineGroup.exact`; `docs/design/up-to.md` | `lib/model/pin-rule.ts`, `solvePinExact`; `docs/up-to.md` |
| Overview rail | `ui/OverviewRail`, `BoardSession.buildTotals` | `clean/rail/rail-model.ts`, `OverviewRail.tsx` |
| Minimap | `ui/world/Minimap`, `PlanSnapshot` (draws through `DrawerPaint`) | `clean/minimap/minimap-scene.ts`, `minimap-engine.ts` |
| Tooltips | `ui/popup/Tip` built in each widget (`DrawerCard.tip`) | `clean/interaction/tip-spec.ts`, built in the view (`drawer-model.ts` `tips`) |
| Sounds | `ui/sound/Sfx` (`Sfx.connect(key)` by resource) | `lib/board-sounds.ts` (`playBoardSound`) |
| Solver tests | `src/test/java/.../solver/` (`SolverGoldenTest`, `SolverPathTest`, `SolverIslandTest`), `SolverCorpus` digest by reflection | `lib/solver/plan/__fixtures__/` (`golden.test.ts`, `harness.test.ts`, `digest.ts` by hand), `solve-core.test.ts` |
| Corpus input dump | `dev/SolveInputJson` (`call 'solvedump?dir=...'` in game, or a test that writes it) | `__fixtures__/load.ts` (`parseSolveInput`) |
| Parity of the adapter | (none) | `adapter/parity.test.ts` (website plans against the mod's dumps of the same plans) |
| Running it | `tools/dev/mc.sh` (`start`, `call`, `shot`; gate on `idle`) | `next dev -p <port>`, `/dev/clean-card` (`window.__ccStore`), Playwright |
| Player notes | `.changelogs/unreleased.md` | `src/lib/changelog.ts` (at deploy) |

## The order to do it in

Times are what buffer drawers took (about 4 hours end to end, half of it discovery).

1. **Design once, in both repos (30 min).** One file, copied verbatim: what it is, its semantics in the solver (which
   rows, which variables, how gates, forced flows, islands, anchors and the relaxation treat it), its shape in the
   plan JSON, its look. Decide the solver shape first: it is the only part that must be identical.
2. **Mod solver (45 min).** `SolveInput` field, `ModelData`, `SolveContext`, `ModelBuilder`, the read-out, `Islands`,
   `dev/SolveInputJson` (write new fields only when non-empty so every older dump reads the same). Compile errors at
   every `switch` over an enum are a free checklist of places to visit: keep the switches exhaustive.
3. **A corpus case, written by a mod test (15 min).** Build the `SolveInput` in a test (`BufferDrawerTest.input()`),
   assert the hand-worked numbers, and have the same test write it to `solver-corpus/<case>.json` under
   `-PwriteGoldens` and otherwise check the file still matches. Add the name to `SolverCorpus.PLANS`. Then
   `./gradlew test --tests '*SolverGoldenTest*' -PwriteGoldens` and read `git diff` of the goldens: only what you meant
   may move. The bench case `platline-x10` is not rewritten by that run; patch it by hand if the digest gained a field.
4. **TypeScript solver, line for line (25 min).** Same names, same order of rows and terms, same stages. Copy the new
   input and every golden into `__fixtures__/corpus/`, add the case to `load.ts` (`PLAN_NAMES`) and bump the counts in
   `harness.test.ts`. If the answer gained a field, add it to `__fixtures__/digest.ts` (hand-written there) and to
   every literal of that type (`npm run typecheck` lists them). The golden passing in vitest is the parity proof.
5. **Data model and saves, both sides (20 min).** Mod: the class (Gson picks up a new field; give `sanitize()` a
   default and make an older build degrade, never crash), the `Graph` methods, and a save round trip test. Website:
   usually nothing new in the schema when the plan JSON can already say it; otherwise `schemas.ts`, `types.ts` and
   `project-normalize.ts` in one commit with a round trip test.
6. **Website adapter (30 min).** `adapter/model.ts` builds the new input; `adapter/answer.ts` reads the
   new answer back into wire flows, drawer results and plan extras. Run
   `adapter/parity.test.ts`: if the mod's dumps were made before the feature, normalise in the test and also solve the
   new shape against the goldens.
7. **Plan JSON both ways (30 min).** Mod `importer/` (parser record, converter, rules) and `library/PlanExport`; a
   round trip test (`LibraryRoundTripTest`: export with the test `World`, import with `FakeGame`).
8. **Website UI (35 min), then mod UI (45 min).** Colours as tokens computed with the float32 mix in both
   (`Hyb.mix` / `mixHex`), never typed by eye; the CSS test pins them. Tips word for word the same. Look for every
   place that branches on the old set of kinds: the mod's `getLinks()`/`linksInputs()` callers (about 40) and the
   website's `role ===` checks.
9. **Checks (30 min).** Mod: `./gradlew spotlessApply`, `./gradlew test` (the count is in `build/test-results`), the
   game through `mc.sh` when the owner is away. Website: `npm run typecheck`, the full `npx vitest run`, eslint on the
   touched files, and a Playwright run on a dev server against the same plan the mod's test solves: the numbers on the
   board must be the golden's.
10. **Notes.** Mod: `.changelogs/unreleased.md` in the same commit. Website: the changelog at deploy. Docs in both.

## Checks that prove parity

- **Solver:** one golden, two suites. The case must pass `SolverGoldenTest` and `golden.test.ts`; the website's
  `solve-core.test.ts` determinism test solves it again in reverse column order (it must be given the relaxation if the
  case needs it).
- **Adapter:** `parity.test.ts` compares the adapter's `SolveInput` for a website plan to the mod's dump of the same
  plan, and solves it against the mod's golden. A feature that changes the shape of the input must normalise one side
  in that test and say why.
- **Plan JSON:** the mod's round trip (export, import, same board) and `PlanExportTest` (the export passes the
  website's schema); on the website, the schema round trip in `plan-mode-schema.test.ts`.
- **On screen:** Playwright on the website with the corpus case as a plan reproduces the golden's counts and the
  drawer's figure (`window.__ccStore.getState().setProject(...)`, then the design tab, then Fit). In the mod, `mc.sh`
  with a plan made through `call` and a `shot`.

## Pitfalls

- The mod's local `main` was 73 commits behind `origin/main`: branch from `origin/main`.
- No Python on this machine, and Git Bash's heredocs break on some patch text: write patch files with the editor and
  apply them with a small node script (another agent had already written its own, `ff-wp7-rep.cjs`).
- The mod's golden digest reads records and `SolutionView` by reflection: a new field changes every golden in both
  repos. The website's digest is written by hand and must be told.
- The website's `solveCore()` runs without the drawer relaxation unless given `planExtensions`; the Java chain always
  relaxes. A corpus case whose drawer rule cannot be kept fails the website's determinism test until it passes `relax`.
- The mod's edge ids are UUIDs and the island merge matches edges by id; edges the solver makes for itself need ids
  that are the same in every snapshot (`ModelData.bufferEdgeId`). The website's ids are plain strings.
- Optional in TypeScript, always present in Java: `DrawerIn.takers` is `takers?:` on the website and an empty list in
  the mod, so the JSON omits it when empty and both readers default it.
- One rule written twice: buffers are joined into wires in the mod's importer (`FfConverter.expandBuffers`) and the
  website's adapter (`adapter/buffers.ts`). Change both, or the planners disagree on the same plan.
- The website shows a welcome page over the board: click the design tab before screenshots.
- Never launch the game while the owner is playing; `mc.sh idle` needs a running game to answer.

## Refactors that would make this smoother

Ranked by payoff for effort.

1. **One corpus, two readers (small, high).** Keep `solver-corpus/` in one place (a git submodule or a tiny shared
   repo both check out) instead of copying files; a script that copies and checks hashes is the cheap version. Today
   every new case is copied by hand and the counts in `harness.test.ts` are typed in.
2. **A parity runner for any `SolveInput` (small, high).** A CLI on each side that solves a JSON input and prints the
   digest (`gradlew solveJson -Pin=...`, `node solve-json.mjs`), plus a script that runs both and diffs them. Any plan
   on either board (`solvedump`, or the website's adapter output) then becomes a parity check in seconds, without
   writing goldens first.
3. **One schema for the solver contract (medium, high).** `SolveInput` and the answer described once (JSON Schema or a
   small IDL), with the TypeScript types and the Java records generated from it, and the digest written from the
   schema on both sides. Field drift (`takers?` versus a list, a forgotten digest field) becomes a build error.
4. **Explicit sides on drawer links in the mod (medium, high).** `Drawer.Link` carrying `input` (or the website's
   wire-shaped storages) would have removed most of the mod UI work: about 40 call sites read a link's side from the
   drawer's kind. `Drawer.held()` is a first step; migrating the callers to it finishes it.
5. **One rule module per plan-JSON concept (small, medium).** The buffer rule lived in three places; the mod's
   `FfDrawers` mirrors the website's `storage-role.ts` and `storage-target.ts` by hand. Golden tests that feed the same
   storages and wires to both (a JSON table of cases read by `FfDrawersTest` and a vitest) keep them in step.
6. **Shared design tokens (small, medium).** Colours and drawer geometry in one JSON file (`tokens.json`) read by
   `tokens.ts`, written into `drawer.css`, and generated into a Java constants class; the float32 mixes computed once
   by a script instead of by hand.
7. **Matching names (small, medium).** The same name for the same thing (`DrawerRow.flowEdges` is now the same in
   both; `SolutionView` fields already are). Keep file names parallel (`ModelData` / `model.ts` is fine;
   `DrawerReadout` / `drawerReadout` in `solve-core.ts` is not) so a grep for one finds the other.
8. **Solver core with the relaxation on by default on the website (small, low).** `solveCore(input)` should behave as
   Java's `Balancer` does; tests that want less can say so.
9. **A plan-JSON round trip fixture set (medium, medium).** A folder of small plans (each feature's) that the mod
   imports and exports and the website loads and saves, checked to come back equal, run in both CI suites.
10. **Mod UI checks that do not need the game (large, medium).** The website has Playwright; the mod's board is only
    seen in the game. Rendering `BoardCanvas` headless (as the layout benchmark draws plans) would let UI work be
    checked without the owner's machine being free.
