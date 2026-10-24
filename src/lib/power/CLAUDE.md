# Power generation (src/lib/power)

- Generator cards follow the community "GTNH Power Planner" workbook, decoded in
  `docs/power-planner-math.md`; where the workbook and the Java disagree on flows, the Java
  wins (THTR: TRISO pebbles in, burned pebbles out per 9-hour operation, helium is a kept
  charge; HTGR: fuel, burned fuel and 256 L helium lost per cycle, cycle length from
  onRunningTick's speedups, `htgrOperation` in `sources/reactors.ts`).
- A power card's unlock chip is the tier of the controller's own recipe.
- EU is a wireable resource. The EU-per-unit rate display never splits energy between a
  recipe's outputs (`src/lib/model/rate-unit.ts`).
- Coolant cells are ports; the vacuum freezer is a placed machine, not built in.
- "Free" inputs (`FREE_INPUT_ITEM_IDS`) are never consumed or wired.
- Tooltips can lie (the ECE's lubricant line) and the workbook can be wrong (MOX rods);
  the Java wins.
- `boilerFuels`: `euPerItem` is burn ticks, `burnTime` is large-boiler seconds.
- On load, `resynthesizePowerRecipes` must run before `dropCrossFormConnections`, or power
  cards lose their fuel wires. A cloned power card remints its owned recipe.
- The closed-plan rule waives unwired power outputs, or old generators load dead.
- The Java to check against is GT5U tag `5.09.54.20` for 2.9 and `5.09.51.476` for 2.8.1,
  not the newer local clone. Table fixes where it beats the workbook go in the extractor's
  "Java corrections" section; never hand-edit `power-planner-data.json`. Regenerate from
  `~/Downloads/Copy of GTNH Power Planner 2.9.xlsx` (the copy whose EOH sheet is "13. EOH").
- New flow names resolve through `tools/power-resource-map.mjs` (`AUX_NAMES`); an
  unresolved name shows as a stat, not a port. A name a pack shows differently ("Amber" for the
  workbook's "Amber Gem") goes in that pack's `VERSION_ID_ALIASES`, pinned by id, since the
  display name can collide with other mods' items.
- The fuel-name and machine-face maps are per pack (`resolvePowerResource(name, gameVersion)`,
  `getPowerMachineIcon(sourceId, gameVersion)`): 2.9's in `data/`, 2.8.1's in `data/2.8.1/`, made
  against `local-2.8.1`. Regenerate 2.8.1's after any 2.8.1 dataset rebuild, because icon file
  names carry a content hash. With `PORT=3622 npm run dev:local` serving the dataset:

  ```bash
  npx tsx tools/power-tables-dump.ts 2.8.1 > scratch/power-tables-2.8.1.json
  node tools/power-resource-map.mjs --base http://localhost:3622 --version local-2.8.1 --data scratch/power-tables-2.8.1.json --out src/lib/power/data/2.8.1/resource-map.json
  node tools/power-machine-icons.mjs --base http://localhost:3622 --version local-2.8.1 --game-version 2.8.1 --out src/lib/power/data/2.8.1/machine-icons.json
  ```
- Retiring a select option key needs `legacyKeys`: shipped plans store the old key.
- Exam: `power.test.ts`, `rotor-data.test.ts` and each `sources/*.test.ts` (Java values).
- Railcraft's Water Tank and boiler (`sources/railcraft.ts`) follow Railcraft's own source (GTNH fork, tag
  9.17.26), not the workbook; the mod pins the same values. The tank is the one source in the
  "other" group, the picker's Other column after its planning cards.
- Sources are built per game version: `powerSourcesFor(v)` and `getPowerSource(id, v)`, each
  `sources/*.ts` a `PowerSourceBuilder` over `powerTablesFor(v)`. A version's differing tables
  are whole-table overrides in `overrides-<v>/`; a difference with no table branches in the
  builder on `gameVersion`. `power-version.test.ts` pins 2.9 to `__fixtures__/power-sources-2.9.json`
  (one source per line; `npx vitest run src/lib/power/power-version.test.ts -u` rewrites it after a
  meant 2.9 change). Inner factories that branch take the version (`buildTurbine`, `htgr`,
  `solarPanel`); module-constant sources (`thtr`, `waterTank`) take none and are shared by every
  version's list: a task that branches one turns the constant into a factory taking `gameVersion`.
- 2.9 can carry source corrections too: `overrides-2.9/` holds whole tables fixed where the
  workbook disagrees with GT5U 5.09.54.205 (each row cites its line), and `powerTablesFor`
  layers them under every other version's overrides. Fixes true on both versions live in a
  shared module (`fusion-corrections.ts`); a version's own file holds only its deltas.
  `powerPlannerData` is the raw workbook, not 2.9's tables: read `powerTablesFor("2.9")`.

## Game version

- `getPowerSource(id, gameVersion)`, `powerSourcesFor(gameVersion)`, `searchPowerSources(query,
  gameVersion)`, `buildPowerRecipe(..., gameVersion)` and `resynthesizePowerRecipes(project,
  gameVersion)` take the plan's version as a required argument, with no default, so a 2.8.1 plan's
  power card, picker and gear menu never list 2.9 options. UI callers read it once with
  `useFactoryStore((s) => planGameVersion(s.project))` and put it in their memo dependencies.
- A version's differing workbook tables are `POWER_DATA_OVERRIDES[v]` (`planner-data.ts`, filled from
  `overrides-<v>/`); `powerTablesFor(v)` swaps each named table in whole over 2.9's, never row by row,
  so a fuel the version lacks is simply absent. 2.8.1 values are a hand read
  of the 2.8.1 Java; the corrections go in the overrides or the extractor, never in
  `power-planner-data.json`.
- Converting a plan (`convertProjectToVersion`) rewrites each power card's settings with
  `convertPowerSettings` (`version-settings.ts`): every select the source card read is written, its default
  too, because an unset fuel means each version's own default. The target card then reads the same choice, or
  names it with what it uses instead ("Not in GTNH 2.8.1: Ether. Using Solid Super Fuel."). A 2.8.1 boiler's one
  fuel moves onto 2.9's liquid or solid select, and the HTGR's material onto the other reactor's fuel or pebble
  by element (Uranium is Uranium-235); one the target lacks is named (`FOREIGN_POWER_SETTINGS`). 2.9 dual fuels
  on 2.8.1's one-fuel boiler read "GTNH 2.8.1 boilers burn one fuel at a time. Using <fuel>." (`merged()`). On
  2.9 a stored value or setting is named only when another version's card has it. Exam: the "power card's fuel"
  block of `src/lib/datasets/convert-plan-version.test.ts`, `power-reader.test.ts`.
