# GTNH 2.8.1 Stage 6 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a 2.8.1 plan, every machine and power source the audit marks `different` computes the 2.8.1 way, every `absent` item stays out of the way, and every `not checkable` item is checked once the 2.8.1 data exists. 2.9 plans do not change.

**Architecture:**
- Machine fixes are entries in `MACHINE_OVERRIDES["2.8.1"]` (Task 6.2a), split into one file per task under `src/lib/machines/overrides-2.8.1/`. No two tasks edit the same file.
- Shared rules (overclock step count, tier skips, float coefficients) take the version as a parameter. They are never copied per version.
- Power fixes are whole-table replacements in `POWER_DATA_OVERRIDES["2.8.1"]`, plus version branches in the source builders. Each source module becomes a builder over `(tables, gameVersion)`.
- Pipeline fixes key on the export's `gtnhVersion` at normalize time, followed by a 2.8.1 rebuild.

**Tech Stack:** TypeScript strict, Vitest, Node `.mjs` pipeline scripts, `tsx` for one dump script.

**Spec:** `docs/superpowers/specs/2026-10-22-gtnh-2-8-1-support-design.md`.
**Parent plan:** `docs/superpowers/plans/2026-10-23-gtnh-2-8-1-support.md`. Its Execution model, Test commands, Decisions and Global Constraints apply here unchanged.
**Audit:** `docs/audits/2-8-1-machine-audit.md`. Row numbers below are its "Different rows" list.

## Row mapping

Every `different` row maps to exactly one task.

| Row | Item | Task |
|---|---|---|
| 1 | standard OC | 6.6 |
| 2 | laser OC | 6.6 |
| 3 | amperage OC | 6.7 |
| 4 | tier skips | 6.7 |
| 5 | float modifiers | 6.8b (shared ceilings in 6.8a) |
| 6 | Mega Chemical Reactor | 6.9 |
| 7 | Mega Oil Cracker | 6.9 |
| 8 | Large Thermal Refinery | 6.10 |
| 9 | Cryogenic Freezer | 6.10 |
| 10 | Industrial Centrifuge | 6.10 |
| 11 | Industrial Extrusion Machine | 6.10 |
| 12 | Mega Distillation Tower | 6.9 |
| 13 | Industrial Cutting Factory | 6.11 |
| 14 | Industrial Sledgehammer | 6.11 |
| 15 | Industrial Maceration Stack | 6.11 |
| 16 | Industrial Mixing Machine | 6.11 |
| 17 | Industrial Wire Factory | 6.11 |
| 18 | Amazon Warehousing Depot | 6.11 |
| 19 | Naquadah Fuel Refinery | 6.9 |
| 20 | Multiblock Electrolyzer | 6.10 |
| 21 | Industrial Coke Oven | 6.11 |
| 22 | Arc Furnace | 6.10 |
| 23 | Short Circuit Heater | 6.10 |
| 24 | Dangote Distillus | 6.10 |
| 25 | energy-hatches.ts | 6.12 |
| 26 | machine-table.ts | 6.24 |
| 27 | tree-growth-simulator.ts | 6.13 |
| 28 | power-planner-data.json | 6.24 |
| 29 | machine-wiki-stats.mjs: industrial cutting factory | 6.20 |
| 30 | machine-configs.mjs: industrial coke oven coil | 6.20 |
| 31 | machine-configs.mjs: industrial coke oven casing | 6.20 |
| 32 | acid-generator | 6.15 |
| 33 | large-bronze-boiler | 6.16 |
| 34 | large-steel-boiler | 6.16 |
| 35 | large-titanium-boiler | 6.16 |
| 36 | large-tungstensteel-boiler | 6.16 |
| 37 | large-sc-steam-turbine | 6.17 |
| 38 | xl-turbo-steam-turbine | 6.17 |
| 39 | xl-turbo-hp-steam-turbine | 6.17 |
| 40 | xl-turbo-sc-steam-turbine | 6.17 |
| 41 | htgr | 6.18 |
| 42 | solar-panel | 6.18 |
| 43 | power-planner-data.json: semifluidFuels | 6.15 |
| 44 | power-planner-data.json: chemFuels | 6.15 |
| 45 | power-planner-data.json: magicSolids | 6.15 |
| 46 | power-planner-data.json: htgrPebbles | 6.18 |
| 47 | power-planner-data.json: boilerFuels | 6.16 |
| 48 | power-planner-data.json: fusionRecipes | 6.19 |
| 49 | power-planner-data.json: singleblockEfficiency | 6.15 |

**`absent in 2.8.1` rows (17).** Most need no code: the 2.8.1 dataset has no recipes for these machines. Code is needed in four places, because these items are hand tables or synthesized cards that no dataset hides:

| Item(s) | What the code must do | Task |
|---|---|---|
| Exothermic Hearth, Industrial Arc Furnace, Endothermic Fridge, Steam Hearth, Spinmatron-2737, Industrial Chemical Bath, Industrial Bending Machine, Mass Solidifier, L.A.T.E.X. | A `null` 2.8.1 override, so a name that still reaches the table falls back to dataset values and never gets the 2.9 entry. 6.24 checks the 2.8.1 catalog for name collisions. | 6.14, 6.24 |
| large-neutralization-engine, lneBases, lneStructureTiers, lneRobotArms | LNE is left out of the 2.8.1 power source list. Its tables are then unread. | 6.14 |
| crop placeholder, crop maths | The spec settles it: absent machines do not appear, and the dataset decides. The Crop Farm planning card is offered only when the loaded dataset carries CropsNH crop recipes (`cropsnh-crop`, passive-production.ts:789). There is no version literal. The placeholder is a plan-own recipe and stays as it is (5.1's rule). 6.24 checks that no 2.8.1 recipe gets the CropsNH maths. | 6.14, 6.24 |
| machine-wiki-stats.mjs: industrial arc furnace | Nothing. The key matches exactly (`wikiStatsForMachine`, machine-wiki-stats.mjs:272), and 2.8.1's name is "High Current Industrial Arc Furnace". | none |
| machine-configs.mjs: industrial coke oven slices | The 2.8.1 build emits no slices control. | 6.20 |

**`not checkable` rows (8):**

| Item | Method | Task |
|---|---|---|
| bio-vat.json, radio-hatch.json, tgs-trees.json | Diff `src/lib/machines/data/2.8.1/*.json` (3.3) against the 2.9 files. Make sure each module reads the 2.8.1 file through `forVersion`. Pin one differing entry per file, or pin that the module reads the 2.8.1 file when they are identical. | 6.21 |
| machine-icons.json, resource-map.json | Regenerate both maps against the local 2.8.1 dataset with the existing tools. Read them by version. List what does not resolve. | 6.22 |
| reference-coefficients.json | No 2.8.1 version exists. Pin the fixture test to `"2.9"`. 2.8.1 overrides are pinned by their own tests. | 6.4 |
| ic2-fluid-reactor, vacuum-reactor | Compare the IC2 jars of both manifests class by class. Escalate to an in-game check only if the reactor classes differ. | 6.23 |

## Global Constraints

- Everything in the parent plan's Global Constraints.
- **2.9 is unchanged.** Every task leaves the corpus goldens (`src/lib/solver/plan/__fixtures__/corpus/goldens/`) byte-identical. Every 2.8.1 test has a 2.9 twin asserting today's value.
- **Shared rules are version-keyed, never forked by copy.** A rule that differs takes `gameVersion` and branches at the point of difference.
- **`power-planner-data.json` is never hand-edited.** 2.8.1 power values are TS override tables. Each row carries a `// GT5U@5.09.51.476 <path>:<line>` comment.
- **Every override cites its source.** Each `MACHINE_OVERRIDES["2.8.1"]` entry has a comment naming the 2.8.1 class and line (the audit's "2.8.1 source" column).
- **Java float literals are reproduced with `Math.fround`** at each float operation the Java performs (Task 6.4's helpers). A literal the Java passes as a double stays a double.
- **Test names start with the audit row's `Item` text verbatim** (for example `"Mega Chemical Reactor 2.8.1 ..."`). Task 6.24 enforces this.
- **2.8.1 sources** are read from `scratch/sources-2.8.1/` (`git clone --depth 1 --branch 5.09.51.476 https://github.com/GTNewHorizons/GT5-Unofficial.git scratch/sources-2.8.1/GT5-Unofficial`). Clone it if it is missing.
- **Copy:** plain and short, no em dashes. A test that pins copy changes in the same commit as the copy.

## Review Focus

1. **Alias names.** The dataset names a machine by an alias ("Industrial Electrolyzer", "Utupu-Tanuri", "Coke Oven"). The 2.8.1 override keyed on the canonical name must still apply. Owner: 6.4, test `machine-table.ts 2.8.1 overrides apply through aliases`.
2. **Saved settings for a knob 2.8.1 lacks.** A converted plan carries `sawblade`, `itemPipeCasing` or `cokeOvenSlices` settings. They must not change a 2.8.1 number or crash. Owner: 6.11, test `Industrial Cutting Factory 2.8.1 ignores a saved sawblade`.
3. **`machineTableSeedsFromBase` after an override.** An override that drops a bonus must still state `speed: 1` / `power: 1`. Otherwise the handler's baked stats come back and the bonus applies twice. Owner: 6.9, test `Mega Distillation Tower 2.8.1 still seeds from the map's base`.
4. **A power card whose option or setting 2.8.1 lacks.** For example, Fluoroantimonic Acid in an acid generator, or a kubatech HTGR's pebble setting, on a converted plan. Today the reader silently falls back to the default. On 2.8.1 the card must say so. Owner: 6.5b, tests `a stored option missing in 2.8.1 is named on the card` and `a stored setting missing in 2.8.1 is named on the card`.
5. **No cache bleed between versions.** Lookup maps and memoized power lists are built per version. A 2.8.1 call first and a 2.9 call next must return the 2.9 value. Owners: 6.4 (`machine-table.ts 2.8.1 lookups never leak into 2.9`) and 6.5a (`powerTablesFor 2.9 is the JSON itself`).
6. **Table wrappers that drop the version.** If `getMachineTableControls`, `machineTableSeedsFromBase` or `getMachineHiddenControlIds` look up the 2.9 entry, every 2.8.1 `controls` / `hidesControls` override is silently ignored. Owner: 6.4, test `machine-table.ts 2.8.1 control overrides reach the wrappers`.

## Shared files and order

| Task | Creates / owns | Needs first |
|---|---|---|
| 6.4 | `src/lib/machines/overrides-2.8.1/{index,float-coefficients,mega,gtpp-flat,gtpp-knobs,absent,test-helpers}.ts`, `src/lib/machines/java-float.ts`; edits `version-overrides.ts`, `machine-table.ts` (the three wrappers) and their callers `src/components/flow/machine-tooltip-data.ts` and `src/lib/model/recipe-rules.ts`, `machine-table.test.ts` | 6.2b |
| 6.5a | `src/lib/power/overrides-2.8.1/{index,fuels,boilers,reactors,fusion,absent,branched}.ts` and `branched-{steam,turbines,reactors}.ts` (empty; one later task owns each part), `src/lib/power/power-dump.ts`, `src/lib/power/__fixtures__/power-sources-2.9.json`, `src/lib/power/power-version.test.ts`; edits `planner-data.ts`, `registry.ts`, `sources/*.ts`, `sources/helpers.ts`, and the `getPowerSource` callers in `src/components/**` | 6.2b |
| 6.5b | `src/lib/power/types.ts` (`legacyIds`, `storedSelectValue`, the reader's `missing()` / `unknownSettings()`), `power-recipe.ts` (the warnings), `src/components/flow/PowerConfigPanel.tsx`, `src/components/flow/clean/special/power-settings.ts`, `src/components/nei/lookup-card.tsx` (reader signature), `src/lib/power/power-reader.test.ts` | 6.5a |
| 6.6 | `src/lib/solver/overclock.ts` | 6.2b |
| 6.7 | `src/lib/solver/power-input-rules.ts` | 6.2b |
| 6.8a | `src/lib/solver/machine-effects.ts` (2.8.1 parallel ceiling), `overclock.ts` (2.8.1 EU/t ceiling in the return) | 6.6 |
| 6.8b | `overrides-2.8.1/float-coefficients.ts` | 6.4, 6.8a |
| 6.9 | `overrides-2.8.1/mega.ts` | 6.4 |
| 6.10 | `overrides-2.8.1/gtpp-flat.ts` | 6.4 |
| 6.11 | `overrides-2.8.1/gtpp-knobs.ts` | 6.4 |
| 6.12 | `src/lib/machines/energy-hatches.ts` + callers `RecipeNode.tsx`, `clean/clean-model.ts`, `model/project-normalize.ts` | 6.5a (RecipeNode.tsx) |
| 6.13 | `src/lib/machines/tree-growth-simulator.ts` | 6.2b |
| 6.14 | `overrides-2.8.1/absent.ts` (machines), `power/overrides-2.8.1/absent.ts`, `ModPowerPicker.tsx`, `src/lib/model/planning-cards.ts` (create), `src/lib/datasets/crops-availability.ts` (create), `power-recipe.ts` (absent-source branch) | 6.4, 6.5b |
| 6.15 | `power/overrides-2.8.1/fuels.ts` | 6.5a |
| 6.16 | `power/overrides-2.8.1/boilers.ts`, `sources/steam-makers.ts` | 6.5b |
| 6.17 | `sources/turbines.ts` | 6.5a |
| 6.18 | `power/overrides-2.8.1/reactors.ts`, `sources/reactors.ts` | 6.5b |
| 6.19 | `power/overrides-2.8.1/fusion.ts` | 6.5a |
| 6.20 | `tools/dataset-pipeline/scripts/{machine-configs,machine-wiki-stats}.mjs`; rebuilds 2.8.1 | 3.3, 6.11 |
| 6.21 | the vat, TGS and radio-hatch data readers | 3.3, 6.13 |
| 6.22 | `planner-data.ts` (by-version maps), `tools/power-resource-map.mjs`, `tools/power-machine-icons.mjs`, `tools/power-tables-dump.ts`, `src/lib/power/data/2.8.1/` | 3.3, 6.12, 6.14-6.19 |
| 6.23 | `docs/audits/2-8-1-ic2-reactors.md` | none |
| 6.24 | `src/lib/machines/machine-audit-coverage.test.ts`, the audit doc's absent-row notes | every other 6.x |

**Parallel groups** (no shared files inside a group):
- **A**, right after 6.2b: 6.4, 6.5a, 6.6, 6.7, 6.13, 6.23.
- **B**, after 6.4, 6.5a or 6.6 as the table says: 6.5b, 6.8a, 6.9, 6.10, 6.11, 6.12, 6.15, 6.17, 6.19.
- **C**, after 6.5b (and 6.8a for 6.8b): 6.8b, 6.14, 6.16, 6.18.
- **D**, reads 3.3's data: 6.20, 6.21, 6.22, then 6.24 last.

The parent plan's stage order puts 3.3 before stage 6, so group D's data is already on disk when stage 6 starts. Only 6.20, 6.21, 6.22 and 6.24 read it. Every other task could run without it.

**Tests that span tasks.** No task's test reads the live merged power overrides and asserts that 2.8.1 equals 2.9. 6.5a's equality test builds both versions from builders with empty overrides passed in, so later tasks cannot break it.

---

### Task 6.4: Machine override layout, float helpers, test helpers

**Rows:** none of the `different` rows. It settles `not checkable` reference-coefficients.json.

**Files:**
- Create: `src/lib/machines/java-float.ts`
- Create: `src/lib/machines/overrides-2.8.1/index.ts`, plus `float-coefficients.ts`, `mega.ts`, `gtpp-flat.ts`, `gtpp-knobs.ts` and `absent.ts`. Each group file exports one empty `Record<string, Partial<MachineBehaviour> | null>`.
- Create: `src/lib/machines/overrides-2.8.1/test-helpers.ts`
- Modify: `src/lib/machines/version-overrides.ts`: `MACHINE_OVERRIDES = { "2.8.1": MACHINE_OVERRIDES_2_8_1 }`
- Modify: `src/lib/machines/machine-table.ts:1425-1450`. These three wrappers take `gameVersion` and pass it to `getMachineBehaviour`; add the parameter where 6.2a did not:
  - `machineTableSeedsFromBase(machineType, gameVersion, overrides = MACHINE_OVERRIDES)`;
  - `getMachineTableControls(machineType, recipe, gameVersion, overrides = MACHINE_OVERRIDES)`;
  - `getMachineHiddenControlIds(machineType, gameVersion, overrides = MACHINE_OVERRIDES)`.

  Fix the alias resolution here too if 6.2a keyed the lookup differently. Fix the callers the compiler lists: outside tests, `src/components/flow/machine-tooltip-data.ts` and `src/lib/model/recipe-rules.ts`.
- Modify: `src/lib/machines/machine-table.test.ts`: the reference-fixture check calls `getMachineBehaviour(name, "2.9")` only
- Test: `src/lib/machines/overrides-2.8.1/index.test.ts`

**Interfaces:**
- Consumes (6.2a): `getMachineBehaviour(machineType, gameVersion, overrides = MACHINE_OVERRIDES)`, `forVersion`, `VersionOverrides<T>`, `MachineContext.gameVersion`, and `machineTableNames()`.
- Produces:
  - `java-float.ts`:
    - `export const f32 = Math.fround;`
    - `export function speedFromBonus(bonus: number): number`, which returns `1 / bonus`. `bonus` is the float the Java passes to `setSpeedBonus` (for example `f32(1 / f32(2.2))`). `getMachineDurationMultiplier` then returns exactly `bonus`: `1 / (1 / m) === m` holds for every bonus used here, checked for 1/2.2, 1/2.25, 1/2.5, 1/2.8, 1/3, 1/3.5, 1/5, 1/6 and 1/1.5.
    - `export function floatBonus(divisor: number): number`, which is `f32(1 / f32(divisor))`, Java's `1F / xF`.
  - `index.ts`: `export function mergeOverrideGroups(groups: Record<string, Record<string, Partial<MachineBehaviour> | null>>): Record<string, Partial<MachineBehaviour> | null>`. It throws `"<name> is overridden in both <a> and <b>"`. It exports `MACHINE_OVERRIDES_2_8_1` merged from the five groups.
  - Override keys are `MACHINES` keys (canonical names). `getMachineBehaviour` resolves an alias to its canonical name before `forVersion`. If 6.2a keyed the lookup differently, this task fixes that in `machine-table.ts`.
  - The three wrappers above, with `gameVersion`. 6.9 and 6.11 call them with `"2.8.1"`.
  - `test-helpers.ts`:
    - `export function ctx(gameVersion: GameVersion, p?: Partial<MachineContext>): MachineContext`. Defaults: `tier: () => 0`, `value: () => 0`, `voltageTier: 5`.
    - `export function coefficients(name: string, gameVersion: GameVersion, p?: Partial<MachineContext>): { speed: number; power: number; parallels: number; durationMultiplier: number }`. It uses `resolveCoefficient` with fallback 1 and `durationMultiplier = 1 / speed`.

- [ ] **Step 1: Write the failing tests** in `index.test.ts`:

```ts
test("machine-table.ts 2.8.1 override keys are table names", () => {
  for (const name of Object.keys(MACHINE_OVERRIDES_2_8_1)) expect(machineTableNames()).toContain(name);
});
test("machine-table.ts 2.8.1 override groups never share a machine", () => {
  expect(() => mergeOverrideGroups({ a: { Volcanus: {} }, b: { Volcanus: {} } })).toThrow("Volcanus is overridden in both a and b");
});
test("machine-table.ts 2.8.1 overrides apply through aliases", () => {
  const o = { "2.8.1": { "Multiblock Electrolyzer": { parallels: 7 } } };
  expect(getMachineBehaviour("Industrial Electrolyzer", "2.8.1", o)?.parallels).toBe(7);
  expect(getMachineBehaviour("Industrial Electrolyzer", "2.9", o)?.parallels).toBe(getMachineBehaviour("Industrial Electrolyzer", "2.9")?.parallels);
});
test("machine-table.ts 2.8.1 lookups never leak into 2.9", () => {
  const o = { "2.8.1": { Volcanus: { parallels: 99 } } };
  getMachineBehaviour("Volcanus", "2.8.1", o);
  expect(getMachineBehaviour("Volcanus", "2.9", o)?.parallels).toBe(8);
});
test("machine-table.ts 2.8.1 control overrides reach the wrappers", () => {
  const o = { "2.8.1": { "Industrial Mixing Machine": { controls: [], hidesControls: ["pipeCasing", "itemPipeCasing"], speed: 1, power: 1 } } };
  expect(getMachineTableControls("Industrial Mixing Machine", undefined, "2.8.1", o)).toEqual([]);
  expect(getMachineHiddenControlIds("Industrial Mixing Machine", "2.8.1", o)).toContain("itemPipeCasing");
  expect(machineTableSeedsFromBase("Industrial Mixing Machine", "2.8.1", o)).toBe(true);
  expect(getMachineTableControls("Industrial Mixing Machine", undefined, "2.9", o).map((c) => c.id)).toEqual(["itemPipeCasing"]);
  expect(getMachineHiddenControlIds("Industrial Mixing Machine", "2.9", o)).toEqual(getMachineHiddenControlIds("Industrial Mixing Machine", "2.9"));
});
test("java float bonus round-trips through speed", () => {
  expect(1 / speedFromBonus(floatBonus(2.2))).toBe(Math.fround(1 / Math.fround(2.2)));
  expect(Math.floor(22 * floatBonus(2.2))).toBe(9);
});
```

- [ ] **Step 2: Run them.** Run `npx vitest run src/lib/machines/overrides-2.8.1/index.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Create the files and wire `MACHINE_OVERRIDES`.** Pin the reference-fixture loop in `machine-table.test.ts` to `"2.9"`.
- [ ] **Step 4: Run the tests and the suite.** Run the file, then `npm run typecheck && npm run test`. Expected: PASS. The goldens are byte-identical.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.5a: Power by version: tables, builders, registry

**Rows:** none (foundation for 6.5b, 6.14-6.19 and 6.22).

**Files:**
- Modify: `src/lib/power/planner-data.ts`:
  - `export type PowerTables = typeof powerPlannerData` (the declared shape);
  - `POWER_DATA_OVERRIDES: Partial<Record<GameVersion, Partial<PowerTables>>>`, a whole-table replacement that redefines 6.2a's placeholder if it was typed otherwise;
  - `export function powerTablesFor(gameVersion: GameVersion, overrides = POWER_DATA_OVERRIDES): PowerTables`.
- Modify: every `src/lib/power/sources/*.ts`. The exported arrays become builders: `buildSingleblockSources(tables, gameVersion)`, `buildEngineSources`, `buildSofcSources`, `buildSteamMakerSources`, `buildTurbineSources`, `buildReactorSources`, `buildPassiveSources`, `buildEndgameSources`, `buildRailcraftOtherSources` and `buildRailcraftSteamSources`. Each has the signature `(tables: PowerTables, gameVersion: GameVersion) => PowerSourceDefinition[]`. `helpers.ts`'s `tierPower` and `familyTierOptions` take `tables` as their last argument.
- Modify: `src/lib/power/registry.ts`:
  - `export function buildAllSources(tables: PowerTables, gameVersion: GameVersion, absent: string[] = []): PowerSourceDefinition[]`;
  - `export function powerSourcesFor(gameVersion: GameVersion): PowerSourceDefinition[]`, which is `buildAllSources(powerTablesFor(v), v, ABSENT_POWER_SOURCES[v])` memoized per version;
  - `export function getPowerSource(sourceId: string, gameVersion: GameVersion)`.
  - Remove `POWER_SOURCES`.
- Modify: the `getPowerSource` / `POWER_SOURCES` callers `power-recipe.ts`, `PowerSourceOverlay.tsx`, `ModPowerPicker.tsx`, `RecipeNode.tsx`, `PowerConfigPanel.tsx` and `clean/special/use-special.ts`. Each passes the plan's version the way 6.2b does.
- Create: `src/lib/power/overrides-2.8.1/index.ts`, which merges `fuels.ts`, `boilers.ts`, `reactors.ts` and `fusion.ts`. Each exports an empty `Partial<PowerTables>`. A table named in two files throws. Also create `absent.ts` with `export const ABSENT_POWER_SOURCES_2_8_1: string[] = []`. Also create `branched.ts` and its three empty parts (Step 2).
- Create: `src/lib/power/__fixtures__/power-sources-2.9.json` (Step 1)
- Test: `src/lib/power/power-version.test.ts`

**Interfaces:**
- Produces:
  - `powerTablesFor("2.9") === powerPlannerData` (the same object). Other versions get `{ ...powerPlannerData, ...overrides[v] }`, memoized per version for the default `overrides` only.
  - The builders are what 6.16-6.18 branch in. A version difference with no data goes in the builder as `if (gameVersion === "2.8.1")` at the point of difference.
  - `dumpSources(sources)`, a test helper in `src/lib/power/power-dump.ts` (also used by 6.5b and 6.16-6.18). It returns `{ id, name, group, unlock, blurb, settings, model }` per source, with `model` the compute output at defaults and at every option of every select setting, one at a time.

- [ ] **Step 1: Capture the 2.9 golden before touching anything.** Write the local harness `scratch/probes/power-golden.local.test.ts`. It applies `dumpSources`'s shape to today's `POWER_SOURCES` and writes the result to `src/lib/power/__fixtures__/power-sources-2.9.json`. Run it with `npx vitest run scratch/probes/power-golden.local.test.ts --config vitest.local.config.ts`.
- [ ] **Step 2: Write the failing tests.** No test here reads the live 2.8.1 overrides. Later tasks fill those overrides in parallel, and every task must stay green.

```ts
test("powerTablesFor 2.9 is the JSON itself", () => {
  powerTablesFor("2.8.1");
  expect(powerTablesFor("2.9")).toBe(powerPlannerData);
});
test("power sources for 2.9 match the golden", () => {
  expect(dumpSources(powerSourcesFor("2.9"))).toEqual(golden);
});
test("the 2.8.1 builders with no overrides build what 2.9 builds", () => {
  // Builder branches added by 6.16-6.18 must keep this true only where they read no data;
  // a task whose branch changes a source lists that id in BRANCHED_IN_2_8_1 below.
  const strip = (s: PowerSourceDefinition[]) => s.filter((d) => !BRANCHED_IN_2_8_1.includes(d.id));
  expect(dumpSources(strip(buildAllSources(powerPlannerData, "2.8.1")))).toEqual(dumpSources(strip(buildAllSources(powerPlannerData, "2.9"))));
});
```

  `BRANCHED_IN_2_8_1` is exported from `src/lib/power/overrides-2.8.1/branched.ts`. It concatenates three arrays, each empty here and each owned by one task: `branched-steam.ts` (6.16), `branched-turbines.ts` (6.17) and `branched-reactors.ts` (6.18). No two tasks edit one file.

- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Convert the modules to builders and the registry to `powerSourcesFor`.** Fix every caller the compiler lists. Run `npm run typecheck` until clean.
- [ ] **Step 5: Run the file, then `npm run test`.** Expected: PASS. The goldens are byte-identical.
- [ ] **Step 6: Stage the files for the stage commit.** Delete the probe.

### Task 6.5b: Power cards say what 2.8.1 lacks, and a setting can read an old id

**Rows:** none (the mechanism 6.14, 6.16 and 6.18 use).

**Files:**
- Modify: `src/lib/power/types.ts`:
  - `PowerSelectSetting.legacyIds?: string[]`. When the setting's own id is unset in the stored values, these ids are tried in order. The first stored value found goes through `selectValue` like the setting's own value.
  - `export function storedSelectValue(setting: PowerSelectSetting, values: Record<string, string> | undefined): string`. It applies `legacyIds` and then `selectValue`, and it is the ONE place that does. The reader uses it.
  - `buildPowerSettingsReader(definition, values, gameVersion)` also returns:
    - `missing(): Array<{ stored: string; used: string }>`. It lists select values, including values found through `legacyIds`, that are neither an option nor a legacy key.
    - `unknownSettings(): string[]`. It lists stored setting ids that the definition neither declares nor names in a `legacyIds`.
  - Both lists are empty for `"2.9"`, so 2.9 cards never gain a warning.
- Modify the UI that reads select values directly: `src/components/flow/PowerConfigPanel.tsx:57,181` and `src/components/flow/clean/special/power-settings.ts:58,73,131`. Each `selectValue(setting, values?.[setting.id])` becomes `storedSelectValue(setting, values)`, so a card shows the same option its model computes.
- Modify: `src/components/nei/lookup-card.tsx:124,426`, for the new `buildPowerSettingsReader` signature.
- Modify: `src/lib/power/power-recipe.ts`. `buildPowerRecipe` appends warnings:
  - per missing value: `` `Not in GTNH ${v}: ${stored}. Using ${usedLabel}.` ``;
  - once if any setting is unknown: `` `Not in GTNH ${v}: ${labels}.` ``. `labels` are the unknown ids' labels on the 2.9 definition of the same source, joined with `, `.
- Test: `src/lib/power/power-reader.test.ts`

**Interfaces:**
- Produces `legacyIds` (6.16 uses `["liquidFuel", "solidFuel"]`), `storedSelectValue`, `missing()` and `unknownSettings()`.
- `powerSettingsSelectModel(definition, values, settingId)` in the tests stands for the select model `power-settings.ts` already builds. Use its real name, or export a thin wrapper of that name from `power-settings.ts`. 6.16's test uses the same function.
- Tests mock the 2.8.1 tables with `vi.mock("@/lib/power/overrides-2.8.1/index", ...)` returning a test table set. The acid generator's default fuel is `"Sulfuric Acid"` (`singleblocks.ts`, `defaultFuel`), so the mock keeps it and drops Fluoroantimonic Acid.

- [ ] **Step 1: Write the failing tests:**

```ts
test("a stored option missing in 2.8.1 is named on the card", () => {
  // mocked 2.8.1 chemFuels: the 2.9 rows minus Fluoroantimonic Acid
  const recipe = buildPowerRecipe("acid-generator", { fuel: "Fluoroantimonic Acid" }, "r", "2.8.1");
  expect(recipe?.power?.warnings).toContain("Not in GTNH 2.8.1: Fluoroantimonic Acid. Using Sulfuric Acid.");
  expect(buildPowerRecipe("acid-generator", { fuel: "Bogus" }, "r", "2.9")?.power?.warnings ?? []).toEqual([]);
});
test("a stored setting missing in 2.8.1 is named on the card", () => {
  // a test definition whose 2.8.1 build drops the "pebble" setting
  expect(warningsFor(testSource, { pebble: "x" }, "2.8.1")).toContain("Not in GTNH 2.8.1: Pebble.");
  expect(warningsFor(testSource, { pebble: "x" }, "2.9")).toEqual([]);
});
test("a select reads its legacy ids in order when its own id is unset", () => {
  const def = selectDef({ id: "fuel", legacyIds: ["liquidFuel", "solidFuel"], options: ["A", "B"] });
  expect(buildPowerSettingsReader(def, { liquidFuel: "A", solidFuel: "B" }, "2.8.1").select("fuel")).toBe("A");
  expect(buildPowerSettingsReader(def, { solidFuel: "B" }, "2.8.1").select("fuel")).toBe("B");
  expect(buildPowerSettingsReader(def, { fuel: "B", liquidFuel: "A" }, "2.8.1").select("fuel")).toBe("B");
});
test("a card's select shows the value its model reads through legacy ids", () => {
  const def = selectDef({ id: "fuel", legacyIds: ["liquidFuel"], options: ["A", "B"] });
  const stored = { liquidFuel: "B" };
  expect(storedSelectValue(def.settings[0], stored)).toBe("B");
  expect(powerSettingsSelectModel(def, stored, "fuel").current).toBe("B"); // power-settings.ts's select model
  expect(buildPowerSettingsReader(def, stored, "2.8.1").select("fuel")).toBe("B");
});
```

- [ ] **Step 2: Run them.** Run `npx vitest run src/lib/power/power-reader.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the reader fields and the warnings.**
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS. 6.5a's 2.9 golden is unchanged.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.6: Overclock step count floors the discounted draw (rows 1, 2)

**Files:**
- Modify: `src/lib/solver/overclock.ts:249-253`. The `recipePower` line becomes version-keyed.
- Test: `src/lib/solver/overclock-2-8-1.test.ts` (create)

**Interfaces:**
- Consumes: `getOverclockedRecipeStats(recipe, node, gameVersion)` (6.2a).
- Rule: 2.8.1 counts steps as `floor(machinePower) / max(floor(parallelEuT), 32)`, Java long division (`OverclockCalculator.java:343`). 2.9 keeps `Math.ceil(parallelEuT)`. The same count feeds the sub-tick quantisation, which covers `calculateMultiplierUnderOneTick` (`:433`). That function clamps by `powerTiersAbove` only when amperage OC is on (`:463`), and by voltage tiers otherwise.

- [ ] **Step 1: Write the failing tests.**
  - The recipe is an Oil Cracker recipe at 143 EU/t with cupronickel coils (power 0.9, so the draw is 128.7).
  - The node `hvOneHatch` is one HV energy hatch (1 A, 512 EU/t) at `overclockTier: "HV"`.
  - The Oil Cracker is a multiblock with amperage OC on: `hasAmperageOverclock("Oil Cracker", v)` is true in both versions. Assert that in the test, so the sub-tick case counts by power tiers.

```ts
test("standard OC 2.8.1 truncates a fractional draw before counting steps", () => {
  const r = { ...oilCracker, eut: 143, durationTicks: 200 };
  expect(getOverclockedRecipeStats(r, hvOneHatch, "2.9")).toMatchObject({ overclockSteps: 0, durationTicks: 200 });
  expect(getOverclockedRecipeStats(r, hvOneHatch, "2.8.1")).toMatchObject({ overclockSteps: 1, durationTicks: 100 });
});
test("standard OC 2.8.1 floors the draw on the sub-tick path too", () => {
  const r = { ...oilCracker, eut: 143, durationTicks: 1 };
  expect(getOverclockedRecipeStats(r, hvOneHatch, "2.9").durationTicks).toBe(1);
  expect(getOverclockedRecipeStats(r, hvOneHatch, "2.8.1").durationTicks).toBe(0.5);
});
test("laser OC is not modelled in either version", () => {
  // no table machine is an Advanced Assembly Line, the only laser-OC machine in both versions
  for (const v of ["2.9", "2.8.1"] as const) expect(getMachineBehaviour("Advanced Assembly Line", v)).toBeUndefined();
});
```

- [ ] **Step 2: Run them.** Run `npx vitest run src/lib/solver/overclock-2-8-1.test.ts`. Expected: the first two FAIL.
- [ ] **Step 3: Branch `recipePower` on `gameVersion`** in `getOverclockedRecipeStats`. Comment it with the Java line.
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS. The goldens are byte-identical.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.7: Tier skips and amperage OC for the GT++ arc furnace (rows 3, 4)

**Files:**
- Modify: `src/lib/solver/power-input-rules.ts`: `maxInputTierSkips(machine, gameVersion)` and `hasAmperageOverclock(machine, gameVersion)` (the parameters 6.2a added)
- Test: `src/lib/solver/power-input-rules.test.ts` (create if absent)

**Interfaces:**
- Rule: in 2.8.1 neither regex has the `industrial arc furnace` alternative. The kubatech machine does not exist there. GT++'s "High Current Industrial Arc Furnace" keeps the default 1 skip and overclocks on amperage (`GregtechIndustrialArcFurnace.java:22`, `MTEMultiBlockBase.java:1024`). Build each regex from a shared alternative list, minus the per-version exclusions. Never copy the regex.

- [ ] **Step 1: Write the failing tests:**

```ts
test("tier skips 2.8.1 gives the High Current Industrial Arc Furnace the default skip", () => {
  expect(maxInputTierSkips("High Current Industrial Arc Furnace", "2.8.1")).toBe(1);
  expect(maxInputTierSkips("High Current Industrial Arc Furnace", "2.9")).toBe(0);
  expect(maxInputTierSkips("Industrial Arc Furnace", "2.9")).toBe(0);
});
test("amperage OC 2.8.1 lets the High Current Industrial Arc Furnace overclock on amperage", () => {
  expect(hasAmperageOverclock("High Current Industrial Arc Furnace", "2.8.1")).toBe(true);
  expect(hasAmperageOverclock("High Current Industrial Arc Furnace", "2.9")).toBe(false);
  expect(hasAmperageOverclock("Steam Grinder", "2.8.1")).toBe(false);
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the per-version exclusion.**
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.8a: The two 2.8.1 EU/t ceilings (row 5, shared part)

**Files:**
- Modify: `src/lib/solver/machine-effects.ts`. In 2.8.1, `getPoweredParallelLimit` divides by `Math.ceil(|EUt| x eutMultiplier x heatDiscount)` (`ParallelHelper.java:399,476`).
- Modify: `src/lib/solver/overclock.ts`, the return's `eut`. 2.8.1 bills `Math.ceil(EUt x heat x eutMultiplier x parallels x stepFactor) / parallels` per recipe (`OverclockCalculator.java:341,406`).
- 2.9 stays as it is in both places.
- Test: `src/lib/solver/float-ceilings-2-8-1.test.ts`

**Interfaces:**
- The tests give the Fluid Shaper a float EU coefficient through `vi.mock("@/lib/machines/overrides-2.8.1/index", ...)` (`{ "Fluid Shaper": { power: Math.fround(0.8) } }`). This task does not depend on 6.8b's real entries.

- [ ] **Step 1: Write the failing tests:**

```ts
test("float modifiers 2.8.1 bill a 30 EU/t Fluid Shaper recipe at 25", () => {
  expect(getOverclockedRecipeStats(shaper30, lvOneHatch, "2.8.1").eut).toBe(25);
  expect(getOverclockedRecipeStats(shaper30, lvOneHatch, "2.9").eut).toBe(24);
});
test("float modifiers 2.8.1 cost a 40 EU/t Fluid Shaper recipe a parallel on one MV hatch", () => {
  expect(getMachineParallelMultiplier(shaper40, mvOneHatch, "2.8.1")).toBe(3);
  expect(getMachineParallelMultiplier(shaper40, mvOneHatch, "2.9")).toBe(4);
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement both ceilings.** Comment each with its Java line.
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS. The goldens are byte-identical.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.8b: Java float coefficients per machine (row 5)

**Files:**
- Modify: `src/lib/machines/overrides-2.8.1/float-coefficients.ts`
- Test: `src/lib/machines/overrides-2.8.1/float-coefficients.test.ts`

**Interfaces:**
- Consumes: `f32`, `floatBonus` and `speedFromBonus` (6.4), and the ceilings (6.8a).
- **Scope:** this file holds only machines with no other `different` row. Machines with their own row get float values in their own task (6.9-6.11).
- **The rule:**
  - An entry restates today's 2.9 formula with `f32` at every float operation the Java does.
  - A coefficient the Java passes as a double gets no entry, for example Boldarnator's `setEuModifier(0.75)` and `setSpeedBonus(1 / 3.0)`.
  - An exactly representable float gets no entry: 1F/2F, 1F/4F, 0.75F, 0.5F, 1F/1.6F.

- [ ] **Step 1: Sweep every hit.**
  - Run `grep -rn "setSpeedBonus\|setEuModifier\|setDurationModifier\|setEUtDiscount" scratch/sources-2.8.1/GT5-Unofficial/src/main/java`. Expect about 75 hits in 49 files.
  - Give every hit one disposition in a table in the task report:
    - `entry` (written here);
    - `exact float`;
    - `double`;
    - `other task` (name it);
    - `not in table` (the machine has no `MACHINES` entry: for example the Godforge modules `MTEExoticModule`, `MTEPlasmaModule`, `MTEMoltenModule` and `MTESmeltingModule` via `getSpeedBonus()`);
    - `not modelled`: a branch the 2.9 entry also does not model. Example: HIP's overheated branch, `setSpeedBonus(2.5F)` and `setEuModifier(1.1F)` (`MTEHIPCompressor.java:369-370`). The table assumes not overheated in both versions; HIP's normal branch `0.75F` is an exact float.
  - Hits that need a formula read, not just a literal:
    - Mega Alloy Blast Smelter `1 - 0.05f x bonusTier`;
    - the Magnetic Flux Exhibitor's `float` magnet table;
    - the Industrial Autoclave's `float euModifier`;
    - the Large Fluid Extractor's `1.0f / getSpeedBonus()` and `getEUMultiplier()`;
    - the Chemical Plant's and Pyrolyse Oven's `2F / (1 + coil)`;
    - the Oil Cracker's `1.0F - min(0.1F x (t + 1), 0.5F)`;
    - the Fluid Shaper's `1F / speedup`.

    Check Zyngen's `100.0 / (100 + 5 x mLevel)`, which is a double, and expect no entry.
  - Expected entries, at least: Volcanus, Thermic Heating Device, Multiblock Dehydrator, Chemical Plant, Pyrolyse Oven, Oil Cracker, Big Barrel Brewery, Large Scale Auto-Assembler v1.01, Nuclear Salt Processing Plant, Ore Washing Plant, Dissection Apparatus, Industrial Precision Lathe, Hyper-Intensity Laser Engraver, Large Electric Compressor (0.9F; its 1F/2F is exact), Hot Isostatic Pressurization Unit (1F/3.5F), Large Sifter, Industrial Forming Press, Matter Fabricator, Pseudostable Black Hole Containment Field (0.2F, 0.7F), Industrial 3D Copying Machine and Fluid Shaper.
- [ ] **Step 2: Write the failing tests.** Write one per `entry`, named `"<Item> 2.8.1 coefficients are Java floats"`. Each asserts that `coefficients(name, "2.8.1")` equals the `f32` expression and that `coefficients(name, "2.9")` equals today's double. Also:

```ts
test("float modifiers 2.8.1 run a 22-tick Volcanus recipe in 9 ticks", () => {
  expect(getOverclockedRecipeStats(volcanus22t, ivNoSpareVoltage, "2.8.1").durationTicks).toBe(9);
  expect(getOverclockedRecipeStats(volcanus22t, ivNoSpareVoltage, "2.9").durationTicks).toBe(10);
});
```

- [ ] **Step 3: Run them.** Run `npx vitest run src/lib/machines/overrides-2.8.1/float-coefficients.test.ts`. Expected: FAIL.
- [ ] **Step 4: Write the entries.** Each has its Java line as a comment.
- [ ] **Step 5: Run the file and `npm run test`.** Expected: PASS. The goldens are byte-identical.
- [ ] **Step 6: Stage the files for the stage commit.** The disposition table goes in the task report.

### Task 6.9: Mega machines and the Naquadah Fuel Refinery (rows 6, 7, 12, 19)

**Files:**
- Modify: `src/lib/machines/overrides-2.8.1/mega.ts`
- Test: `src/lib/machines/overrides-2.8.1/mega.test.ts`

**Interfaces:**
- Entries, with values from the audit rows:
  - **Mega Chemical Reactor:** `fullPowerPool: true` (`MegaMultiBlockBase.java:136`).
  - **Mega Oil Cracker:** `power: (c) => f32(1 - Math.min(f32(f32(0.1) * (c.tier(COIL) + 1)), f32(0.5)))` (`MTEMegaOilCracker.java:223`). It keeps 256 parallels and the mega pool.
  - **Mega Distillation Tower:** `speed: 1`, `power: 1`, `parallels: 256`, `controlsFor: () => []`, `note: undefined`. The distillation-tower map only (`MTEMegaDistillTower.java:250,397`). The 2.9 note describes distillery mode, so it is cleared. `hidesControls: ["structure-tower-height"]` is kept: the dataset's height knob carries made-up multipliers in both versions.
  - **Naquadah Fuel Refinery:** `parallels: 1`, `fullPowerPool: true`. The OC cap is unchanged (`MTEFuelRefineFactory.java:219,226`).

- [ ] **Step 1: Write the failing tests:**

```ts
test("Mega Chemical Reactor 2.8.1 draws both amps of a lone hatch", () => {
  expect(getMachineParallelMultiplier(mcr30, hvOneHatch, "2.8.1")).toBe(34); // 1024 / 30
  expect(getMachineParallelMultiplier(mcr30, hvOneHatch, "2.9")).toBe(17);   // 512 / 30
});
test("Mega Oil Cracker 2.8.1 caps its coil discount at half", () => {
  expect(coefficients("Mega Oil Cracker", "2.8.1", { tier: () => 9 }).power).toBe(0.5);
  expect(coefficients("Mega Oil Cracker", "2.9", { tier: () => 9 }).power).toBeCloseTo(0.9 ** 10, 12);
  expect(coefficients("Mega Oil Cracker", "2.8.1").power).toBe(Math.fround(1 - Math.fround(Math.fround(0.1) * 1)));
});
test("Mega Distillation Tower 2.8.1 has no bonus and no distillery mode", () => {
  expect(coefficients("Mega Distillation Tower", "2.8.1", { recipeMap: "distillery" })).toMatchObject({ speed: 1, power: 1, parallels: 256 });
  expect(getMachineTableControls("Mega Distillation Tower", distilleryRecipe, "2.8.1")).toEqual([]);
  expect(getMachineBehaviour("Mega Distillation Tower", "2.8.1")?.note).toBeUndefined();
  expect(getMachineHiddenControlIds("Mega Distillation Tower", "2.8.1")).toContain("structure-tower-height");
  expect(coefficients("Mega Distillation Tower", "2.9", { recipeMap: "distillery" })).toMatchObject({ speed: 2, power: 0.5 });
});
test("Mega Distillation Tower 2.8.1 still seeds from the map's base", () => {
  expect(machineTableSeedsFromBase("Mega Distillation Tower", "2.8.1")).toBe(true);
});
test("Naquadah Fuel Refinery 2.8.1 runs one parallel on the mega power pool", () => {
  expect(coefficients("Naquadah Fuel Refinery", "2.8.1", { tier: () => 3 }).parallels).toBe(1);
  expect(coefficients("Naquadah Fuel Refinery", "2.9", { tier: () => 3 }).parallels).toBe(16);
  expect(getMachineBehaviour("Naquadah Fuel Refinery", "2.8.1")?.fullPowerPool).toBe(true);
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Write the entries.**
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.10: GT++ machines with flat 2.8.1 numbers, and the arc furnaces (rows 8, 9, 10, 11, 20, 22, 23, 24)

**Files:**
- Modify: `src/lib/machines/overrides-2.8.1/gtpp-flat.ts`
- Test: `src/lib/machines/overrides-2.8.1/gtpp-flat.test.ts`

**Interfaces:** the entries below are 2.8.1 values in Java floats. `voltageTier` is `c.voltageTier`, which is `GTUtility.getTier(getMaxInputVoltage())`.

| Machine | speed | power | parallels | Other | Source |
|---|---|---|---|---|---|
| Large Thermal Refinery | `speedFromBonus(floatBonus(2.5))` | `f32(0.8)` | `8 x voltageTier` | no coil or solenoid | MTEIndustrialThermalCentrifuge.java:152-159 |
| Cryogenic Freezer | `speedFromBonus(floatBonus(2.2))` | `f32(0.9)` | `8` | | MTEIndustrialVacuumFreezer.java:262-269 |
| Industrial Centrifuge | `speedFromBonus(floatBonus(2.25))` | `f32(0.9)` | `6 x voltageTier` | drop the max-speed note | MTEIndustrialCentrifuge.java:209-216 |
| Industrial Extrusion Machine | `speedFromBonus(floatBonus(3.5))` | | `4 x voltageTier` | | MTEIndustrialExtruder.java:157-163 |
| Multiblock Electrolyzer | `speedFromBonus(floatBonus(2.8))` | `f32(0.9)` | `2 x voltageTier` | | MTEndustrialElectrolyzer.java:150-162 |
| Dangote Distillus | tower `speedFromBonus(floatBonus(3.5))`, distillery 2 (`1F/2F` is exact) | tower 1, distillery `f32(0.15)` | tower 12, distillery `8 x voltageTier` | `controlsFor: () => []` | MTEAdvDistillationTower.java:367-374 |
| Arc Furnace | | `1` | | `amperage: 3` kept | RecipeMaps.java:286, LoaderMetaTileEntities.java:8181 |
| Short Circuit Heater | | `1` | | `amperage: 3` kept | LoaderMetaTileEntities.java:8289 |

- [ ] **Step 1: Write the failing tests.** Write one per row, named `"<Item> 2.8.1 ..."`. Each asserts the full `coefficients(name, "2.8.1")` at `voltageTier: 5` and the same call at `"2.9"` against today's numbers. The 2.9 values at coil 0, solenoid 0 and voltage 5 are:
  - Large Thermal Refinery 2.5 / 0.8 / 44
  - Cryogenic Freezer 3 / 0.9 / 16
  - Industrial Centrifuge 3 / 0.9 / 40
  - Industrial Extrusion Machine 3.5 / 1 / 30
  - Multiblock Electrolyzer 2.8 / 0.9 / 20
  - Dangote Distillus tower 3 / 1 / 12
  - Arc Furnace and Short Circuit Heater power 3

  Two of the tests:

```ts
test("Dangote Distillus 2.8.1 runs distillery mode at 8 per tier at any height", () => {
  for (const h of [3, 12]) expect(coefficients("Dangote Distillus", "2.8.1", { recipeMap: "distillery", value: () => h }).parallels).toBe(40);
  expect(coefficients("Dangote Distillus", "2.9", { recipeMap: "distillery", value: () => 3 }).parallels).toBe(10);
});
test("Arc Furnace 2.8.1 bills the EU/t as written on 3 amps", () => {
  expect(getMachineEutMultiplier(arcRecipe90, lvNode, "2.8.1")).toBe(1);
  expect(getMachineEutMultiplier(arcRecipe90, lvNode, "2.9")).toBe(3);
  expect(getOverclockedRecipeStats(arcRecipe90, lvNode, "2.8.1").eut).toBe(90);
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Write the entries.** Each has a source comment.
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.11: GT++ machines whose knob changed or went away (rows 13, 14, 15, 16, 17, 18, 21)

**Files:**
- Modify: `src/lib/machines/overrides-2.8.1/gtpp-knobs.ts`
- Test: `src/lib/machines/overrides-2.8.1/gtpp-knobs.test.ts`

**Interfaces:**

| Machine | 2.8.1 entry | Source |
|---|---|---|
| Industrial Cutting Factory | speed `speedFromBonus(floatBonus(3))`, power `f32(0.75)`, parallels `4 x voltageTier`, `controls: []`, `hidesControls: ["sawblade", "cuttingSawblade"]` | MTEIndustrialCuttingMachine.java:183-190 |
| Industrial Sledgehammer | speed 2, parallels `8 x anvilTier x voltageTier`, `controls: [FORGE_HAMMER_ANVIL_CONTROL]`, `hidesControls: ["solenoidCoil"]` | MTEIndustrialForgeHammer.java:129-144,244 |
| Industrial Maceration Stack | speed 1.6 (`1F/1.6F` is exactly 0.625) with or without the chip; parallels `(chip ? 8 : 2) x voltageTier` | MTEIndustrialMacerator.java:358-366 |
| Industrial Mixing Machine | speed `speedFromBonus(floatBonus(3.5))`, parallels `8 x voltageTier`, `controls: []`, `hidesControls: ["pipeCasing", "itemPipeCasing"]` | MTEIndustrialMixer.java:181-187 |
| Industrial Wire Factory | speed `speedFromBonus(floatBonus(3))`, power `f32(0.75)`, parallels `4 x voltageTier`, no item pipe (as the mixer) | MTEIndustrialWireMill.java:161-184 |
| Amazon Warehousing Depot | speed `speedFromBonus(floatBonus(6))`, power `f32(0.75)`, parallels `16 x voltageTier`, no item pipe | MTEAmazonPackager.java:159-177 |
| Industrial Coke Oven | parallels `c.value("cokeOvenCasing") \|\| 1`; overclock normal when `c.value("cokeOvenCasing") > 0`, else none (the Railcraft brick oven under the "Coke Oven" alias); power `f32(f32(100 - 4 x voltageTier) / 100)`; no coil, no slices | MTEIndustrialCokeOven.java:195-209 |

- `FORGE_HAMMER_ANVIL_CONTROL`: `choiceControl("forgeHammerAnvil", "Anvil", ["Vanilla Anvil", "Steel Anvil", "Dark Steel or Thaumium Anvil", "Void Metal Anvil"])`. The anvil tier is the index + 1. It is exported for nothing else.
- **The coke oven's casing control in 2.8.1 datasets** is fixed here and produced by 6.20: id `cokeOvenCasing`, keys `"18"` (Heat Resistant) and `"30"` (Heat Proof). `value()` reads the key as the parallel count.

- [ ] **Step 1: Write the failing tests.** Write one per row, with 2.9 twins. The others follow the same shape:

```ts
test("Industrial Cutting Factory 2.8.1 is flat 3x, 75% EU, 4 per tier", () => {
  expect(coefficients("Industrial Cutting Factory", "2.8.1")).toMatchObject({ durationMultiplier: Math.fround(1 / Math.fround(3)), power: Math.fround(0.75), parallels: 20 });
  expect(getMachineTableControls("Industrial Cutting Factory", undefined, "2.8.1")).toEqual([]);
});
test("Industrial Cutting Factory 2.8.1 ignores a saved sawblade", () => {
  expect(getMachineStructuralParallels(cuttingRecipe, { ...ivNode, machineConfigTiers: { sawblade: "neutronium" } }, "2.8.1")).toBe(20);
});
test("Industrial Sledgehammer 2.8.1 scales on the anvil, not a solenoid", () => {
  expect(coefficients("Industrial Sledgehammer", "2.8.1", { tier: (id) => (id === "forgeHammerAnvil" ? 3 : 0) }).parallels).toBe(160);
  expect(coefficients("Industrial Sledgehammer", "2.8.1").parallels).toBe(40);
  expect(coefficients("Industrial Sledgehammer", "2.9").parallels).toBe(60);
});
test("Industrial Maceration Stack 2.8.1 keeps 1.6x with the chip", () => {
  expect(coefficients("Industrial Maceration Stack", "2.8.1", { tier: () => 1 })).toMatchObject({ speed: 1.6, parallels: 40 });
  expect(coefficients("Industrial Maceration Stack", "2.9", { tier: () => 1 }).speed).toBe(6.4);
});
test("Industrial Coke Oven 2.8.1 runs 18 or 30 parallels and 4% less EU per tier", () => {
  expect(coefficients("Industrial Coke Oven", "2.8.1", { value: () => 30 })).toMatchObject({ parallels: 30, power: Math.fround(Math.fround(80) / 100) });
  expect(coefficients("Industrial Coke Oven", "2.8.1", { value: () => 0 }).parallels).toBe(1);
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Write the entries and the anvil control.**
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS. `industrial-coke-oven.test.ts` is unchanged and green.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.12: Laser target hatches from IV in 2.8.1 (row 25)

**Files:**
- Modify: `src/lib/machines/energy-hatches.ts`: `energyHatchTypesForTier(tier, gameVersion)`, `energyHatchTypeExistsAtTier(id, tier, gameVersion)`, and `minTierOf(type, gameVersion)` read `MIN_TIER_OVERRIDES: Partial<Record<GameVersion, Record<string, MachineTier>>>`
- Modify the callers: `src/components/flow/RecipeNode.tsx`, `src/components/flow/clean/clean-model.ts`, `src/lib/model/project-normalize.ts`
- Test: `src/lib/machines/energy-hatches.test.ts`

**Interfaces:**
- 2.8.1 minimum tier is `"IV"` for `laser1k`, `laser4k`, `laser16k`, `laser65k`, `laser262k` and `laser1m` (`tectech/loader/thing/MachineLoader.java:1088-1133`, `eM_energyTunnel2_IV`...`eM_energyTunnel7_IV`). `laser4m` (UMV), `laser16m` (UXV) and the multi-amp hatches are unchanged.
- The option hint shows `minTierOf(type, gameVersion)`.

- [ ] **Step 1: Write the failing test:**

```ts
test("energy-hatches.ts 2.8.1 offers every laser up to 1,048,576 A at IV", () => {
  const ids = (v: GameVersion) => energyHatchTypesForTier("IV", v).map((t) => t.id).filter((id) => id.startsWith("laser"));
  expect(ids("2.8.1")).toEqual(["laser256", "laser1k", "laser4k", "laser16k", "laser65k", "laser262k", "laser1m"]);
  expect(ids("2.9")).toEqual(["laser256"]);
  expect(energyHatchTypeExistsAtTier("laser4m", "UIV", "2.8.1")).toBe(false);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it and fix the callers.** Each caller reads the version once per component (6.2b's rule).
- [ ] **Step 4: Run `npm run typecheck`, the file and `npm run test`.** Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.13: TGS fruit has no floor in 2.8.1 (row 27)

**Files:**
- Modify: `src/lib/machines/tree-growth-simulator.ts:321`: `tgsForestryProduct(forestry, mode, settings, gameVersion)` and the callers in the same file
- Test: `src/lib/machines/tree-growth-simulator.test.ts`

**Interfaces:**
- Rule: 2.8.1 fruit is `Math.trunc(base * geneTimesTen(yield))` with no `max(1, ...)` (`MTETreeFarm.java:637`). Sapling keeps its floor in both versions (`:617`).
- In 2.8.1, a zero product gives an output multiplier of 0, never `NaN`, including when the dataset's own fruit amount is 0. The guard is 2.8.1-only: 2.9 keeps today's arithmetic exactly, and a twin test pins today's 2.9 result for the same recipe.

- [ ] **Step 1: Write the failing tests:**

```ts
test("tree-growth-simulator.ts 2.8.1 gives a low-yield tree 0 fruit", () => {
  const forestry = { ...sample.forestry, base: { fruit: 1 }, yield: 0.025 };
  expect(tgsForestryProduct(forestry, "fruit", {}, "2.8.1")).toBe(0);
  expect(tgsForestryProduct(forestry, "fruit", {}, "2.9")).toBe(1);
});
test("tree-growth-simulator.ts 2.8.1 zero fruit is a zero multiplier", () => {
  const m = getTgsOutputMultiplier(lowYieldRecipeWithZeroNeiFruit, fruitOutput, {}, 5, "2.8.1");
  expect(m).toBe(0);
  // 2.9 twin: today's value, captured from the code before the change
  expect(getTgsOutputMultiplier(lowYieldRecipeWithZeroNeiFruit, fruitOutput, {}, 5, "2.9")).toEqual(TODAY_2_9_MULTIPLIER);
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.14: What 2.8.1 does not have (absent rows)

**Files:**
- Modify: `src/lib/machines/overrides-2.8.1/absent.ts`: `null` for Exothermic Hearth, Endothermic Fridge, Steam Hearth, Spinmatron-2737, Industrial Chemical Bath, Industrial Bending Machine, Mass Solidifier, L.A.T.E.X. and Industrial Arc Furnace
- Modify: `src/lib/power/overrides-2.8.1/absent.ts`: `["large-neutralization-engine"]`
- Create: `src/lib/model/planning-cards.ts`: `export function planningCardsFor(opts: { datasetHasCropsNh: boolean })`. It leaves out `crop-farm` when the loaded dataset carries no CropsNH crop recipe. The spec decides this: absent machines do not appear, and the dataset decides; there is no version literal.
- Create in the same file: `export function datasetHasCropsNh(crops: Iterable<Pick<RecipeSummary, "category">>): boolean`, which is true when any summary has category `cropsnh-crop` (`passive-production.ts:789-800`).
- Create: `src/lib/datasets/crops-availability.ts`: `export function cropsNhAvailable(manifestUrl: string, version: DatasetVersion, load = listRecipeDatasetCrops): Promise<boolean>`.
  - It reads the crop picker's own endpoint, `listRecipeDatasetCrops` (`browser-loader.ts:235`, `/api/datasets/<id>/crops`, served by `listDatasetCropFarmRecipes` at `dataset-query.ts:1187`), and applies `datasetHasCropsNh`.
  - The result is cached per `version.id`. A failed load is not cached.
  - The client never fetches the dataset catalog for this. The store holds only the project's recipes, so a catalog fetch for one boolean would be a performance regression.
- Modify: `src/components/chrome/ModPowerPicker.tsx`. It reads the card list from `planningCardsFor`, with `datasetHasCropsNh` from `cropsNhAvailable` for the active plan's dataset. The Crop Farm entry stays out of the list until the result arrives.
- Modify: `src/lib/power/power-recipe.ts`. When `resynthesizePowerRecipes` sees a power card whose source is absent in the plan's version, it marks that node with 5.1's `unconverted` marker instead of leaving the 2.9 recipe as saved.
  - The Crop Farm placeholder is NOT marked. It is a plan-own recipe and stays as it is (5.1's rule), and an empty placeholder produces nothing.
  - A crop card with a picked CropsNH crop holds a dataset recipe, which 5.1 already marks unmatched on conversion.
- Test: `src/lib/machines/overrides-2.8.1/absent.test.ts`, `src/lib/power/power-absent.test.ts`, `src/lib/model/planning-cards.test.ts`

**Interfaces:** consumes 5.1's `FactoryNode.unconverted` / `UnconvertedRecipe`. If the marker takes a reason text, it is `Not in GTNH 2.8.1.`

- [ ] **Step 1: Write the failing tests:**

```ts
test.each(ABSENT_MACHINES)("%s absent in 2.8.1 has no table entry there", (name) => {
  expect(getMachineBehaviour(name, "2.8.1")).toBeUndefined();
  expect(getMachineBehaviour(name, "2.9")).toBeDefined();
});
test("large-neutralization-engine absent in 2.8.1 is not offered", () => {
  expect(getPowerSource("large-neutralization-engine", "2.8.1")).toBeUndefined();
  expect(getPowerSource("large-neutralization-engine", "2.9")).toBeDefined();
});
test("crop placeholder absent in 2.8.1 leaves the picker when the dataset has no CropsNH crops", async () => {
  const v281 = { id: "local-2.8.1" } as DatasetVersion;
  const v29 = { id: "local-2.9.0-rc-2" } as DatasetVersion;
  const load = vi.fn(async (_m: string, v: DatasetVersion) => ({
    crops: v.id === "local-2.8.1" ? [] : [{ category: "cropsnh-crop" }],
  }));
  const ids = async (v: DatasetVersion) =>
    planningCardsFor({ datasetHasCropsNh: await cropsNhAvailable("m", v, load) }).map((c) => c.id);
  expect(await ids(v281)).toEqual(["custom-rate", "fluid-tank"]);
  expect(await ids(v29)).toContain("crop-farm");
  await ids(v29);
  expect(load).toHaveBeenCalledTimes(2); // cached per dataset version
});
test("large-neutralization-engine absent in 2.8.1 marks a converted card, never computed", () => {
  const out = resynthesizePowerRecipes(planWithLneCard("2.8.1"), "2.8.1");
  expect(out.nodes[0].unconverted).toBeTruthy();
  expect(resynthesizePowerRecipes(planWithLneCard("2.9"), "2.9").nodes[0].unconverted).toBeFalsy();
});
test("crop maths absent in 2.8.1 leaves the empty placeholder as it is", () => {
  const plan = planWithCropFarmPlaceholder("2.8.1");
  expect(resynthesizePowerRecipes(plan, "2.8.1")).toEqual(plan);
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the files and `npm run test`.** Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.15: Singleblock generators and their fuels (rows 32, 43, 44, 45, 49)

**Files:**
- Modify: `src/lib/power/overrides-2.8.1/fuels.ts`: `chemFuels`, `semifluidFuels`, `magicSolids`, `singleblockEfficiency`
- Test: `src/lib/power/sources/singleblocks.test.ts` (2.8.1 block)

**Interfaces:**
- **chemFuels (12 rows), acid map `FUEL_VALUE`s** (`bartworks/.../AdditionalRecipes.java:247-268`):
  - Phosphoric Acid 36
  - Diluted Hydrochloric Acid 14
  - Hypochlorous Acid 30
  - Hydrofluoric Acid 40
  - Hydrochloric Acid 28
  - Nitric Acid 24
  - Mercury 32
  - Diluted Sulfuric Acid 9
  - Sulfuric Acid 18
  - Acetic Acid 11
  - Formic Acid 40
  - Molten Redstone 10

  `euPerLiter` holds the acid map's fuel value in the 2.9 JSON too. Mercury is 32 in both versions. Confirm that with one 5.09.54 row before writing.
- **semifluidFuels:** the 2.9 rows, with these changes:
  - Nefarious Oil 572 (`NetheriteRecipes.java:283-287`, the map value directly);
  - add Poop Juice 12, Manure Slurry 24 and Fertile Manure Slurry 32 (`RecipeLoaderAgriculturalChem.java:402-416`);
  - add Hemp Seed Oil and Lin Seed Oil at the value Seed Oil holds (all three are fuel 2, type 3: `MaterialsInit1.java:475-476`).

  First establish how the JSON field relates to Java from two rows whose Java is unchanged (Creosote Oil, Heavy Oil). Write a comment on that relation.
- **magicSolids:** every row whose name starts with "Amber" is scaled by 3/32 (`MaterialsInit1.java:307`, magic fuel 3 against 32).
- **singleblockEfficiency:** `chem` is `[0.97, 0.94, 0.91, 0.88, null, ...]`, so `familyTierOptions` drops IV (`ItemRegistry.java:457-477`).

- [ ] **Step 1: Write the failing tests:**

```ts
test("acid-generator 2.8.1 is LV to EV at 97/94/91/88%", () => {
  const tiers = (v: GameVersion) => getPowerSource("acid-generator", v)!.settings.find((s) => s.id === "tier");
  expect(optionKeys(tiers("2.8.1"))).toEqual(["LV", "MV", "HV", "EV"]);
  expect(optionKeys(tiers("2.9"))).toContain("IV");
});
test("power-planner-data.json: chemFuels 2.8.1 is the 12 old acids", () => {
  expect(powerTablesFor("2.8.1").chemFuels.map((f) => [f.name, f.euPerLiter])).toEqual(CHEM_2_8_1_EXPECTED);
  expect(powerTablesFor("2.9").chemFuels).toHaveLength(20);
});
test("power-planner-data.json: semifluidFuels 2.8.1 has Nefarious Oil at 572 and the manure fuels", () => { /* + 2.9 twin: 512, no Poop Juice */ });
test("power-planner-data.json: magicSolids 2.8.1 Amber is 3/32 of 2.9", () => { /* every Amber row */ });
test("power-planner-data.json: singleblockEfficiency 2.8.1 has no IV acid generator", () => {
  expect(powerTablesFor("2.8.1").singleblockEfficiency.chem[4]).toBeNull();
  expect(powerTablesFor("2.9").singleblockEfficiency.chem[4]).toBe(0.5);
});
```

- [ ] **Step 2: Run them.** Run `npx vitest run src/lib/power/sources/singleblocks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write `fuels.ts`.** Each row has its Java comment.
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS. 6.5a's golden for 2.9 is unchanged.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.16: Large boilers burn one fuel at the old bases (rows 33, 34, 35, 36, 47)

**Files:**
- Modify: `src/lib/power/sources/steam-makers.ts`. `buildSteamMakerSources` builds the four large boilers with a 2.8.1 branch.
- Modify: `src/lib/power/overrides-2.8.1/boilers.ts`: `boilerFuels` for 2.8.1
- Test: `src/lib/power/sources/steam-makers.test.ts` (2.8.1 block)

**Interfaces** (2.8.1 `MTELargeBoiler.java:260-420` and the four subclasses):
- **Steam per tick at full efficiency** is `2 x EUT_GENERATED`, with superheated output `/ 3` (int):
  - bronze 400 → 800 L/t Steam;
  - steel 1000 → 2000 L/t Steam;
  - titanium 4000 → 2666 L/t SH Steam;
  - tungstensteel 16000 → 10666 L/t SH Steam.
- **Water:** 1 L per 160 L of steam. A superheated boiler takes a third of that.
- **One fuel at a time.** The 2.8.1 card has ONE select, `fuel` (None + liquids + solids). Liquids are listed for bronze and steel only: superheated boilers skip liquids (`:275`). `legacyIds: ["liquidFuel", "solidFuel"]` (6.5b) reads a converted plan's 2.9 settings. The liquid wins when both are set, because `checkProcessing` tries liquids first. There is no dual-fuel stat.
- **The 2.8.1 `fuel` options apply the Java's two input filters:**
  - a non-superheated solid needs `fuelValue x 2 / EUt > 1` (`MTELargeBoiler.java:342`);
  - a diesel-map liquid needs `mSpecialValue > 1` (`:278`).
  - The lava-bucket check at `:315,337` is NOT a filter. It compares by reference against a fresh copy from `GTOreDictUnificator.get` (`GTOreDictUnificator.java:119-142`), so it never matches. Write a comment saying so, and keep lava buckets wherever the 2.9 rows have them.
- **Burn ticks** go in `boilerFuels` 2.8.1. They are computed in `boilers.ts` from the 2.9 rows' fuel values, which the audit marks `same`:
  - diesel-map liquid: per 1000 L, `runtimeBoost(sv / 2)`;
  - dense-liquid-map liquid: `runtimeBoost(sv x 2)`;
  - solid: `fuel / 80`, times `1 + log9(fuel / 1600) x 0.025` for non-superheated boilers, then `runtimeBoost`.
- **runtimeBoost** by boiler: bronze `x2`, steel `x1`, titanium `x130/400`, tungstensteel `x120/750`, each in int math.

- [ ] **Step 1: Write the failing tests:**

```ts
test("large-bronze-boiler 2.8.1 makes 800 L/t on one fuel", () => {
  expect(steamOut("large-bronze-boiler", { fuel: "Coal" }, "2.8.1")).toBe(800 * 20);
  expect(steamOut("large-bronze-boiler", { liquidFuel: "Creosote Oil", solidFuel: "Coal" }, "2.9")).toBe(1200 * 20);
});
test("large-steel-boiler 2.8.1 makes 2000 L/t", () => { /* + 2.9: 2400 single fuel */ });
test("large-titanium-boiler 2.8.1 makes 2666 L/t SH steam and burns no liquid", () => {
  expect(optionKeys(fuelSetting("large-titanium-boiler", "2.8.1"))).not.toContain("Creosote Oil");
});
test("large-tungstensteel-boiler 2.8.1 makes 10666 L/t SH steam", () => { /* + 2.9 twin */ });
test("power-planner-data.json: boilerFuels 2.8.1 coal burns 40/20/6/3 ticks", () => {
  expect(burnTicks("bronzeSolid", "Coal", "2.8.1")).toBe(40);
  expect(burnTicks("steelSolid", "Coal", "2.8.1")).toBe(20);
  expect(burnTicks("titaniumSolid", "Coal", "2.8.1")).toBe(6);
  expect(burnTicks("tungstensteelSolid", "Coal", "2.8.1")).toBe(3);
});
test("large-bronze-boiler 2.8.1 reads a 2.9 dual-fuel setting as the liquid", () => {
  expect(model("large-bronze-boiler", { liquidFuel: "Creosote Oil", solidFuel: "Coal" }, "2.8.1").inputs.map((i) => i.name)).toEqual(["Creosote Oil", "Water"]);
});
test("large-bronze-boiler 2.8.1 converted card shows and computes the same fuel", () => {
  const stored = { liquidFuel: "Creosote Oil" };
  expect(powerSettingsSelectModel(getPowerSource("large-bronze-boiler", "2.8.1")!, stored, "fuel").current).toBe("Creosote Oil");
  expect(model("large-bronze-boiler", stored, "2.8.1").inputs[0].name).toBe("Creosote Oil");
});
test("large-bronze-boiler 2.8.1 offers only fuels the boiler accepts", () => {
  // the two filters: a solid under EUt/2 fuel value, a diesel liquid with special value <= 1
  for (const name of FILTERED_OUT_2_8_1) expect(optionKeys(fuelSetting("large-bronze-boiler", "2.8.1"))).not.toContain(name);
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the branch and the table.** Add the four boiler ids to `branched-steam.ts` (6.5a).
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS. The 2.9 golden is unchanged.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.17: Turbine truncation and XL dense steam (rows 37, 38, 39, 40)

**Files:**
- Modify: `src/lib/power/sources/turbines.ts`. `largeSteamRun` and `xlSteamRun` take `gameVersion`, passed down from `buildTurbineSources`.
- Test: `src/lib/power/sources/turbines.test.ts` (2.8.1 block)

**Interfaces:**
- **large-sc-steam-turbine, off optimal flow** (`goodgenerator/.../MTESupercriticalFluidTurbine.java:77-82`): 2.8.1 is `max(1, trunc(f32(trunc(f32(f32(flow) x eff)) x rotorEff)))`, two truncations. On optimal flow it is unchanged.
- **XL dense steam** (`MTELargeTurbineSteam.java:120-131`, `MTELargeTurbineSHSteam.java:115`, `MTELargeTurbineSCSteam.java:101`):
  - `denseFlow = min(hatch, f32(remainingFlow / 1000))`;
  - drained per tick: `trunc(denseFlow)` dense L;
  - credited flow: `trunc(f32(denseFlow x 1000))` steam-equivalent L.
  - Water for dense steam is `steamFlowForWater / 160.1`.
  - Plain steam is unchanged.

- [ ] **Step 1: Write the failing tests.** For the SC turbine, pick the first rotor and the first off-optimal flow in `[optimal/2, optimal)` where the two rules differ. The test asserts 2.8.1 = 2.9 − 1, and that 2.8.1 equals the Java expression written out in the test. For each XL (`xl-turbo-steam-turbine`, `xl-turbo-hp-steam-turbine`, `xl-turbo-sc-steam-turbine`), use dense steam with a rotor setup whose flow cap (`remainingFlow` at the start of the tick, which is the optimal flow times the overflow allowance) is exactly 2500 L/t, and more dense steam offered than it can take. Then `remainingDenseFlow = 2500 / 1000 = 2.5` (`MTELargeTurbineSteam.java:124`), so 2 L are drained and 2500 L credited. Pick the rotor and fitting that give a 2500 cap, or state the cap the chosen rotor gives and derive the numbers from it the same way.

```ts
test("xl-turbo-steam-turbine 2.8.1 drains whole dense litres and credits the fraction", () => {
  const run = xlRun("xl-turbo-steam-turbine", "Dense Steam", 2500, "2.8.1");
  expect(run.denseLitersPerTick).toBe(2);
  expect(run.steamPerTick).toBe(2500);
  expect(xlRun("xl-turbo-steam-turbine", "Dense Steam", 2500, "2.9")).toEqual(TODAY_2500); // captured from 2.9 first
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the version branches inside the two run functions.** Add the four turbine ids to `branched-turbines.ts` (6.5a).
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.18: The bartworks HTGR and LV-up solar panels (rows 41, 42, 46)

**Files:**
- Modify: `src/lib/power/sources/reactors.ts`:
  - `buildReactorSources(tables, "2.8.1")` builds `htgr` from the 2.8.1 model below and keeps the id `"htgr"`;
  - `buildPassiveSources(tables, "2.8.1")` drops the ULV panel.
- Modify: `src/lib/power/overrides-2.8.1/reactors.ts`: `htgrPebbles: []`. Nothing in 2.8.1 reads the kubatech constants.
- Test: `src/lib/power/sources/reactors.test.ts` (2.8.1 block)

**Interfaces** (2.8.1 `bartworks/common/tileentities/multis/MTEHighTempGasCooledReactor.java:130-388`):
- **Settings:**
  - `fuel`: Thorium (coolant x1), Uranium (x1.5), Plutonium (x2). The type index is 0, 1, 2.
  - `fill`: TRISO pebbles kept in, from 72,000 to 720,000 (number, step 1,000, default 720,000).
- **The operation:**
  - `ratio = fill / 72000`;
  - `eff = min(ratio², 100) / 100`;
  - burned per operation `floor(fill x 0.025 x eff)`, handed back as `floor(n / 64)` Burned out TRISO Balls plus `n mod 64` Burned out TRISO Pebbles;
  - duration `trunc(72000 x (1 - eff / 2))` ticks.
- **Inputs:** fresh pebbles at the burn rate; IC2 Coolant at `trunc(4000 x (type x 0.5 + 1) x eff)` L/s. Helium is a one-off 730,000 L charge, shown as a stat.
- **Outputs:** IC2 Hot Coolant equal to the coolant.
- **Power:** `euPerTick: -30720` (LuV, `TierEU.RECIPE_LuV`).
- **Fluid and item names** are the 2.8.1 names: "TRISO pebble (Thorium)", "Burned out TRISO Ball (Thorium)" and so on, as `HTGRMaterials` builds them (`:547-600`).
- **solar-panel 2.8.1:** LV-UV only (`LoaderMetaTileEntities.java:10630`). The default stays LV.
- **A converted 2.9 HTGR card.** Its kubatech settings (pebble type and the rest) have no 2.8.1 id. 6.5b's `unknownSettings()` names them on the card (`Not in GTNH 2.8.1: <labels>.`), so the reset to the 2.8.1 defaults is never silent.

- [ ] **Step 1: Write the failing tests:**

```ts
test("htgr 2.8.1 at a full 720,000 pebbles burns 18,000 per 36,000-tick operation", () => {
  const m = model("htgr", { fuel: "Thorium", fill: "720000" }, "2.8.1");
  expect(m.euPerTick).toBe(-30720);
  expect(perSecond(m.inputs, "IC2 Coolant")).toBe(4000);
  expect(perSecond(m.outputs, "Burned out TRISO Ball (Thorium)")).toBeCloseTo(281 / 1800, 12);
});
test("htgr 2.8.1 Plutonium doubles the coolant", () => { /* 8000 L/s at full fill */ });
test("htgr 2.8.1 at the 72,000 minimum runs at 1%", () => { /* 18 pebbles per 71,640 ticks, 40 L/s */ });
test("power-planner-data.json: htgrPebbles 2.8.1 is empty", () => {
  expect(powerTablesFor("2.8.1").htgrPebbles).toEqual([]);
  expect(powerTablesFor("2.9").htgrPebbles).toHaveLength(9);
});
test("htgr 2.8.1 names the kubatech settings it drops", () => {
  expect(warningsFor("htgr", KUBATECH_HTGR_SETTINGS, "2.8.1").some((w) => w.startsWith("Not in GTNH 2.8.1: "))).toBe(true);
});
test("solar-panel 2.8.1 starts at LV", () => {
  expect(optionKeys(panelSetting("2.8.1"))[0]).toBe("LV");
  expect(optionKeys(panelSetting("2.9"))[0]).toBe("ULV");
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement it.** The 2.9 `htgr` model is untouched. Add `htgr` and `solar-panel` to `branched-reactors.ts` (6.5a).
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.19: Fusion recipes in 2.8.1 (row 48)

**Files:**
- Modify: `src/lib/power/overrides-2.8.1/fusion.ts`: `fusionRecipes` for 2.8.1, derived from the 2.9 rows
- Test: `src/lib/power/overrides-2.8.1/fusion.test.ts`

**Interfaces:**
- **Check every one of the 65 rows** against the 2.8.1 fusion recipe sources. Most are in `gregtech/loaders/postload/recipes/FusionReactorRecipes.java`; then the GT++, bartworks and goodgenerator fusion loaders the 2.9 extract names.
  - A row 2.8.1 lacks is removed.
  - A row whose EU/t or startup differs is changed. Recompute its per-mark columns with the rule the 2.9 rows follow.
- **Every literal `.eut(...)` in `FusionReactorRecipes.java` at 5.09.51.476** is compared with the same recipe at 5.09.54:
  - 4096 at `:39` (D + T Helium Plasma);
  - 10240 at `:55`;
  - 16384 at `:63` (Be + D Nitrogen Plasma) and `:192` (Ga + Rn Duranium);
  - 24576 at `:95`, `:184`, `:208` and `:216`;
  - 24578 at `:136`, a likely typo for 24576 and so a likely change;
  - 49152 at `:103`, `:160`, `:168`, `:176`, `:224`, `:232`, `:240` and `:248`;
  - 98304 at `:256`, `:264`, `:272` and `:282`.

  The audit names two differences. The task settles every line and lists each one with its 5.09.54 value in the task report.
- **The alternative recipes** 2.8.1 lacks (FT1 Europium from Neodymium + Promethium, FT2 Americium from Lutetium + Promethium, Redstone + Ichorium Hexanite) are not in the 2.9 table. Confirm that and record it in a comment.

- [ ] **Step 1: Write the failing tests.** Write one named assertion per changed or removed row, with its 2.8.1 value and its 2.9 twin. A stub is not enough. Add one test asserting that the 2.9 table is unchanged (65 rows). For example:

```ts
test("power-planner-data.json: fusionRecipes 2.8.1 bills D + T helium at 4096 EU/t", () => {
  expect(row("2.8.1", "Helium Plasma", "Deuterium", "Tritium").drainEutByMark).toEqual(DRAIN_FROM_4096);
  expect(row("2.9", "Helium Plasma", "Deuterium", "Tritium").drainEutByMark).toEqual(TODAY_ROW.drainEutByMark);
});
// one test per further changed row, including the :136 recipe if 24578 differs from 5.09.54
```

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Write `fusion.ts`.**
- [ ] **Step 4: Run the file and `npm run test`.** Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.20: Pipeline knobs for 2.8.1, and the 2.8.1 rebuild (rows 29, 30, 31, and coke oven slices)

**Files:**
- Modify: `tools/dataset-pipeline/scripts/machine-configs.mjs:175-235`. For an export whose `gtnhVersion` is `"2.8.1"`, the industrial coke oven gets:
  - no heating coil control;
  - no `cokeOvenSlices`;
  - `cokeOvenCasing` with keys `"18"` and `"30"`, `parallelMultiplier` 18 and 30, and tooltips `Parallels: 18` and `Parallels: 30`.
- Modify: `tools/dataset-pipeline/scripts/machine-wiki-stats.mjs`: `wikiStatsForMachine(label, machineType, gtnhVersion)` returns no `industrial cutting factory` entry for 2.8.1.
- Thread `gtnhVersion` from `normalize-oracle-export.mjs:33` through `buildMachineHandlerTemplates` (`machine-configs.mjs`), or reuse the parameter 3.2 added.
- Test: `tools/dataset-pipeline/scripts/machine-configs-2-8-1.test.mjs` (create)

**Interfaces:**
- Produces the `cokeOvenCasing` shape Task 6.11 reads.
- 2.9 output is unchanged.

- [ ] **Step 1: Write the failing tests:**

```js
test("machine-configs.mjs: industrial coke oven coil is not offered on 2.8.1", () => {
  expect(controlIds(templatesFor("Industrial Coke Oven", "2.8.1"))).not.toContain("heatingCoil");
  expect(controlIds(templatesFor("Industrial Coke Oven", "2.9"))).toEqual(TODAY_IDS);
});
test("machine-configs.mjs: industrial coke oven casing is 18 or 30 on 2.8.1", () => { /* keys, parallelMultiplier; no cokeOvenSlices */ });
test("machine-wiki-stats.mjs: industrial cutting factory offers no sawblade on 2.8.1", () => {
  expect(wikiStatsForMachine("Industrial Cutting Factory", "Cutting Machine", "2.8.1")).toBeUndefined();
  expect(wikiStatsForMachine("Industrial Cutting Factory", "Cutting Machine", "2.9")?.selector.id).toBe("cuttingSawblade");
});
```

- [ ] **Step 2: Run them.** Run `npx vitest run tools/dataset-pipeline/scripts/machine-configs-2-8-1.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Run `npx vitest run tools/dataset-pipeline`. Expected: PASS.
- [ ] **Step 4: Rebuild and reinstall 2.8.1** (Task 3.3's steps): `bash scratch/dataset-run-281-client/run.sh normalize`, then `... index`, then copy to `public/datasets/gtnh/local-2.8.1/` after `normalize-fluid-icon-alpha.mjs --rename`.
  - Expected: `DONE index`.
  - With `npm run dev:local`, the 2.8.1 catalog's Industrial Coke Oven handler carries `cokeOvenCasing` with keys 18/30 and no slices.
  - The recipe count equals the count before the rebuild.
- [ ] **Step 5: Leave 2.9 alone.** No 2.9 rebuild: the change is keyed on `gtnhVersion`, and the pipeline tests pin 2.9's templates.
- [ ] **Step 6: Stage the files for the stage commit.**

### Task 6.21: The oracle's machine data files on 2.8.1 (not checkable: bio-vat.json, radio-hatch.json, tgs-trees.json)

**Files:**
- Modify (only if 6.2a did not already do it): `src/lib/machines/bacterial-vat.ts` and `tree-growth-simulator.ts`, so their data reads go through `forVersion` and pick `src/lib/machines/data/2.8.1/*.json`
- Modify: `docs/audits/2-8-1-machine-audit.md`. These three rows get the outcome in the Difference column: counts, and how many entries differ.
- Test: `src/lib/machines/machine-data-2-8-1.test.ts` (create)

- [ ] **Step 1: Diff the files.** Run `node -e` over each pair. Count the entries in each version, the entries in one version only, and the entries whose fields differ. Write the numbers into the three audit rows.
- [ ] **Step 2: Write the failing tests.** Each file gets one entry that differs, pinned through the module with its 2.9 twin, for example `"bio-vat.json 2.8.1 gates <recipe> on glass <n>"`. Where nothing differs, test `"<file> 2.8.1 is read from data/2.8.1"`: a spy on the import or a field only that file carries.
- [ ] **Step 3: Run them.** Expected: FAIL, unless 6.2a already wired the files. Then the identical-file tests pass at once, and the report says so.
- [ ] **Step 4: Wire any read that is missing.** Run the file and `npm run test`. Expected: PASS.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.22: Power resource and icon maps for 2.8.1 (not checkable: machine-icons.json, resource-map.json)

**Files:**
- Create: `tools/power-tables-dump.ts`. Run as `npx tsx tools/power-tables-dump.ts <version>`, it prints `powerTablesFor(version)` and every flow name `powerSourcesFor(version)` produces at every option.
- Modify: `tools/power-resource-map.mjs` and `tools/power-machine-icons.mjs`. Add `--data <json>` (names from the dump) and `--out <path>`. The defaults keep today's behaviour.
- Create: `src/lib/power/data/2.8.1/{resource-map,machine-icons}.json`
- Modify: `src/lib/power/planner-data.ts`: `resolvePowerResource(name, gameVersion)` and `getPowerMachineIcon(sourceId, gameVersion)`, which read the 2.8.1 files for 2.8.1. Fix their callers.
- Test: `src/lib/power/power-maps-2-8-1.test.ts`

- [ ] **Step 1: Generate.** With `npm run dev:local` serving `local-2.8.1`:
  - `npx tsx tools/power-tables-dump.ts 2.8.1 > scratch/power-tables-2.8.1.json`;
  - `node tools/power-resource-map.mjs --base http://localhost:3000 --version local-2.8.1 --data scratch/power-tables-2.8.1.json --out src/lib/power/data/2.8.1/resource-map.json`;
  - `node tools/power-machine-icons.mjs --base http://localhost:3000 --version local-2.8.1 --out src/lib/power/data/2.8.1/machine-icons.json`.

  Expected: both write. The unresolved list is copied into the task report, including the new 2.8.1 names: the manure fuels, the HTGR pebbles and the old acids. Also check the laser hatch icon ids from 6.12 against the 2.8.1 catalog.
- [ ] **Step 2: Write the failing tests:**

```ts
test("resource-map.json 2.8.1 resolves the 2.8.1 fuel names", () => {
  // after Step 1, assert the outcome Step 1 found, one line per new 2.8.1 name: toBeDefined() or toBeUndefined()
  expect(resolvePowerResource("Poop Juice", "2.8.1")).toBeDefined();
  expect(resolvePowerResource("Steam", "2.9")).toEqual(TODAY_STEAM);
});
test("machine-icons.json 2.8.1 names a 2.8.1 icon path", () => {
  expect(getPowerMachineIcon("steam-turbine", "2.8.1")?.iconPath).toContain("local-2.8.1");
});
```

- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement the version reads.** Run the file and `npm run test`. Expected: PASS. The 2.9 maps are byte-identical.
- [ ] **Step 5: Stage the files for the stage commit.**

### Task 6.23: IC2 reactors in 2.8.1 (not checkable: ic2-fluid-reactor, vacuum-reactor)

**Files:**
- Create: `docs/audits/2-8-1-ic2-reactors.md`
- Modify: `docs/audits/2-8-1-machine-audit.md`. The two rows get the outcome.

**Method:**
- [ ] **Step 1: Fetch both IC2 jars** named in the manifests: `2.2.82a-experimental` for 2.8.1 and `2.2.2.828` for 2.9. Take them from the GTNH maven the pack manifests point at, into `scratch/ic2/`.
- [ ] **Step 2: Compare the reactor classes.** Compare `ic2/core/block/reactor/**` and `ic2/core/item/reactor/**` by SHA-256 of each class. Expected: a list of identical and differing classes.
- [ ] **Step 3: Decide.**
  - If every class is identical, the rows become `same` with the hashes as the source. There is no code change.
  - If any class differs, decompile those classes with CFR and diff them, then write the differing rules.
  - If a rule cannot be settled from bytecode, list it for the owner's in-game check: a reactor design, the expected EU/t and heat, and an empty "owner confirmed" column.
- [ ] **Step 4: Stage the docs for the stage commit.** A code fix found here becomes a new task, planned by the manager.

### Task 6.24: Closing check (rows 26, 28; the absent names against the catalog)

**Files:**
- Modify: `src/lib/machines/machine-audit-coverage.test.ts`
- Modify: `docs/audits/2-8-1-machine-audit.md` (the absent-row outcomes)

- [ ] **Step 1: Write the tests:**

```ts
test("machine-table.ts 2.8.1 overrides cover every Machine table row", () => {
  for (const row of auditRows("Machine table")) {
    if (row.verdict === "different") expect(MACHINE_OVERRIDES["2.8.1"]?.[row.item]).toBeTruthy();
    if (row.verdict === "absent in 2.8.1") expect(MACHINE_OVERRIDES["2.8.1"]?.[row.item]).toBeNull();
  }
});
test("power-planner-data.json 2.8.1 overrides cover every Power data row", () => {
  for (const row of auditRows("Power data").filter((r) => r.verdict === "different"))
    expect(POWER_DATA_OVERRIDES["2.8.1"]).toHaveProperty(row.item.replace("power-planner-data.json: ", ""));
});
test("every different row has a test named after it", () => {
  const titles = collectTestTitles(["src", "tools"]); // test(/it( titles in *.test.ts and *.test.mjs
  for (const row of differentRows()) expect(titles.some((t) => t.startsWith(row.item))).toBe(true);
});
```

- [ ] **Step 2: Run them.** Run `npx vitest run src/lib/machines/machine-audit-coverage.test.ts`. Expected: PASS. A failure names the row and the task that missed it.
- [ ] **Step 3: Check the absent names against the 2.8.1 catalog.**
  - For each `absent in 2.8.1` machine row, search the local 2.8.1 catalog for any machine or handler name that normalizes (`normalizeMachineName`) to its key.
  - Expected: none. A hit is recorded in the audit row, with the 2.8.1 machine it belongs to. A hit that needs table values becomes a new task for the manager.
- [ ] **Step 3b: No 2.8.1 recipe gets the CropsNH maths.**
  - Load the local 2.8.1 catalog and run every recipe through `isCropNhRecipe` and `isCropFarmRecipe` (`passive-production.ts:772-784`). A local harness in `scratch/probes/` is enough; record the count in the report.
  - With `npm run dev:local` running, also fetch `/api/datasets/local-2.8.1/crops`, the endpoint 6.14's gate and the crop picker read. Record its count and categories. Expected: no `cropsnh-crop` entry, so the gate is false. If IC2 crops sit on the Crop Farm map, they show in the crop picker too: record that as a hit.
  - Expected: 0. IC2 crops from the 2.8.1 export must not silently get the CropsNH maths, which the audit marks absent.
  - A hit is fixed in the classifier: key it on the recipe's category, never on the version. Add a test named `crop maths absent in 2.8.1 never classifies an IC2 crop`, with a 2.9 twin.
- [ ] **Step 4: Run `npm run typecheck` and `npm run test`.** Expected: green apart from the parent plan's known two. The goldens are byte-identical.
- [ ] **Step 5: Stage the files for the stage commit.**
