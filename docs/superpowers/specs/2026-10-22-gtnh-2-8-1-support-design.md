# GTNH 2.8.1 next to 2.9

## Why

The owner's game server runs GTNH 2.8.1. Players on it need the planner to show 2.8.1's
recipes and to compute machines and power the way 2.8.1 does. Players on 2.9 keep using the
same deployment, so 2.9 stays as it is. When the server later moves to 2.9, players carry their
plans across.

## Goals

1. A GTNH 2.8.1 dataset, exported from the real 2.8.1 client by the oracle mod and normalized by
   the same pipeline as 2.9, served next to the 2.9 dataset.
2. A plan belongs to a game version. It records the version it was made on and always opens on
   it: switching to a tab with a 2.8.1 plan shows 2.8.1 recipes, a 2.9 tab shows 2.9.
3. A player picks the version for new plans.
4. Converting a plan to another version: an explicit action that makes a NEW plan on the target
   version and leaves the original untouched. Recipes found in the target version carry over;
   cards whose recipe was not found are highlighted on the new plan's board so the player sees
   what to replace.
5. Machine math and power are checked against 2.8.1's sources, and where 2.8.1 differs from 2.9
   the planner computes it the 2.8.1 way on 2.8.1 plans.

## Non-goals

- Comparing versions side by side (owner: not at this stage).
- Any version other than 2.8.1 and 2.9. 2.8.4 stays retired.
- Deploying. Deploys happen only when the owner says so (AGENTS.md).
- The in-game mod. This deployment does not talk to it at all (see "Switched off").
- The community library (see "Switched off").

## Anti-goals

- A 2.8.1 plan silently showing 2.9 numbers (a machine or power source computed the 2.9 way, or
  a recipe body quietly kept from another version). Wrong without a warning is the failure.
- Opening or converting a plan overwrites the plan the player has open (AGENTS.md: every arriving
  plan opens as a new design; nothing calls `setProject`).
- 2.9 players notice anything other than the new choice: their plans, numbers, ids and speed stay
  the same.

## Decided by the owner

- Only 2.8.1 recipes on 2.8.1; no comparison.
- Both 2.9 and 2.8.1 live in the owner's deployment.
- Plans open on the version they were made on.
- Conversion to a separate plan, with the unconverted parts highlighted.
- Machines and power are verified against 2.8.1 in this project, not later.
- The in-game mod is not extended and nothing talks to it: every module that serves it is
  switched off.
- A converted card whose recipe was not found stays on the board with its machine, rate and
  wires, highlighted and left out of the solve; its wires count as outside inputs and outputs, so
  the rest of the plan keeps solving.
- The community library is switched off.

## Switched off

Two features leave this deployment. Players see no trace of them: no buttons, menu items, links,
dialogs, copy or routes that answer.

- **In-game mod.** Everything that exists to talk to the game: the mod download and its bar
  (`src/components/chrome/ModBar.tsx`), "Open in the mod", receiving plans the mod sends, and the
  live-service ops kept for the game's engine (`src/live/CLAUDE.md`, `live-vectors.json`). Plan
  share links that the site itself makes keep working. If a part of the live service serves both
  the browser and the game, only the game's side goes; if that split is unclear, it is a question
  for the owner, not a guess.
- **Community library.** Browsing, posting and opening community plans, their API routes
  (`src/app/api/community/...`) and any entry points (welcome page, share dialog, header).

How (my call): switched off at the entry points and routes behind one deployment setting, not
deleted, so the code stays mergeable with the parent repository; tests that pin those features
run with the setting on, and new tests pin that nothing shows or answers with it off. No setting
without a visible control is persisted in the browser (AGENTS.md invariant).

## What exists (recon, 2026-10-22)

App:
- Datasets are already multi-version end to end: manifest (`rebuild-manifest.mjs`), per-version
  server caches (`src/lib/server/dataset-query.ts`), every `/api/datasets/[versionId]/...` route,
  `selectedDatasetVersionId` in `src/store/factory-store.ts`, `loadDatasetVersion` in
  `src/components/FactoryPlannerApp.tsx`.
- The old pack picker `src/components/AppIdentity.tsx` exists but nothing renders it.
  `HIDDEN_DATASET_VERSION_IDS` (`src/lib/datasets/remote.ts`) hides `local-2.8.4`.
- `FactoryProject` has no version field; each recipe carries an informational
  `source.datasetVersionId`. Community posts store `game_version` and `dataset_version`; the list
  API can filter by game version but no UI uses it.
- The selected version is not persisted; each load takes the manifest default.
- Cross-version matching exists: `resolveProjectRecipes` (`src/lib/datasets/refresh-project-recipes.ts`)
  and `hydrateImportedProjectRecipes` (`src/lib/import-export/open-plan-file.ts`) match by id, then
  content, and keep the stored body of anything unmatched without telling the player.
- Prewarm warms one version (`prewarmLatestDatasetVersions`).
- Machine table, machine modules (bacterial vat, TGS, EEC), `src/lib/machines/data/*.json`,
  power sources and passive production are written against 2.9 / GT5U 5.09.54.x, with no version
  key anywhere.
- Copy says 2.9 only: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/llms.txt/route.ts`,
  `src/components/chrome/ModBar.tsx`, AGENTS.md.

Pipeline:
- 2.8.1 client (Java 17+, MMC):
  `https://downloads.gtnewhorizons.com/Multi_mc_downloads/GT_New_Horizons_2.8.1_Java_17-25.zip`
  (571 MiB). `download-gtnh-pack.mjs` builds this stable URL from `GTNH_DATASET_VERSION_LABEL=2.8.1`.
- The oracle compiles against `GT5-Unofficial:5.09.54.20:dev`; 2.8.1 ships 5.09.51.476 (a dev
  jar exists on nexus; transitive POM resolution unverified). Recipe maps, `GTRecipe`, GT++,
  kubatech and the NEI default handler have the same names there. The ore-vein export
  (`GtnhCalcOracleExporter.java`, roughly lines 1940-2180) uses the post-2.8.1 ore rework
  (`IStoneType`, `IOreMaterial`, `StoneType`, new `gtneioreplugin.util` helpers) and will not
  compile; 2.8.1 has the older `GT5OreLayerHelper` / `GT5OreSmallHelper` / `DimensionHelper` API.
- Other mods are reached by reflection and already have branches for both sides where 2.8.1
  differs (IC2 crop plugin vs CropsNH, TC NEI plugins present).
- `normalize-oracle-export.mjs` already maps pre-2.9 `gt.recipe.fluidcanner` for Tank recipes.
- Recipe ids no longer carry the version (`oracle:<category>:<map>:<hash>`), so a recipe
  unchanged between 2.8.1 and 2.9 has the same id in both.
- Mod version table (2.8.1 / 2.9-RC-2): GT5U 5.09.51.476 / 5.09.54.205, NEI 2.8.19 / 2.8.155,
  Forestry 4.10.17 / 4.11.39, IC2 2.2.82a / 2.2.2.828, EnderIO 2.9.27 / 2.10.48.

## Shape (my calls, open to the builder where marked)

- **Plan version.** `FactoryProject` gains the game version it belongs to (dataset id or pack
  version: builder's choice, but a 2.8.1 plan must keep opening on 2.8.1 after the 2.8.1 dataset
  is rebuilt under a new id). Plans saved before this have no field and read as 2.9. It travels
  with every path a plan takes that stays on: local save, account sync, plan files, share links,
  the live service. A plan from a version this deployment does not serve opens with a
  plain notice, not silently on another version.
- **Active dataset follows the active plan.** Switching tabs to a plan on the other version loads
  that dataset; loaded datasets stay cached client-side so switching back is quick. A dataset
  switch never re-solves a plan against the other version's recipes.
- **Picker.** The version choice for new plans sits where the old picker was (the header), and
  the open plan shows which version it is on. The last choice for new plans is remembered per
  device (it has a visible control, so persisting it is allowed). Exact UI is the builder's,
  checked in the real app with Playwright.
- **Conversion.** An action on a plan: "Convert to <other version>". It builds a new design on
  the target version from the original, matching each recipe by id, then by content (reuse
  `resolve-recipes`), and never keeps a source-version body for a card it could not match. Those
  cards keep their machine, rate and wires, are marked on the board and listed so the player can
  find each one, and stay out of the solve (their wires become outside inputs and outputs) until
  the player picks a recipe. The original plan is not modified.
- **Version-aware machine math.** Audit every curated table, machine module and power source
  against 2.8.1's mod sources at the tags in the 2.8.1 manifest (GT5U 5.09.51.476 etc.). Where
  2.8.1 differs, key the behaviour by version; where it matches, record that it was checked.
  The audit covers the shared rules too: overclocks (standard, perfect, laser, multiblock),
  parallels, wireless EU, how runtime calculation tables are read, not only the curated tables.
  Machines absent in 2.8.1 simply do not appear (they come from the dataset). Prefer data the
  2.8.1 oracle export provides over new hand tables (AGENTS.md invariant).
- **Oracle for 2.8.1.** One source tree. The ore export is ported so the mod builds against
  5.09.51.476 (a version-selected source set, reflection, or a build flag: builder's choice); the
  2.9 build must produce the same output as before. The export runs through the existing Apple
  Silicon client path (`scratch/dataset-run/run.sh`, parameterised by pack instead of RC-2 hard
  code).
- **Serving.** Both datasets in the manifest, 2.9 stays `latestStableVersion` (the default for
  new players), prewarm covers both, the 2.8.4 hide rule stays. Measure server memory with both
  loaded (my call); if it is tight, 2.8.1 is prewarmed second rather than loaded on first request.
- **Copy.** Site copy and AGENTS.md stop saying "2.9 only" and name both versions.

## Exams

- Existing suites stay green; 2.9 dataset rebuilt with the new oracle build is identical to the
  current 2.9 build (except known game-rolled recipes).
- 2.8.1 dataset: spot-check against the 2.8.1 client's NEI (a handful of GT, GT++, crafting,
  Thaumcraft, bees, ore veins).
- Plan version: unit tests for every load path, including old plans without the field.
- Conversion: a 2.8.1 plan with a recipe that changed between versions converts to a new 2.9
  plan with that card marked and the original unchanged.
- Machine audit: a list of every curated machine and power source with its 2.8.1 verdict (same /
  different, with the source line), and tests pinning each difference.
- Real-app Playwright check of tab switching across versions, the picker and conversion, and
  that no trace of the mod or the community library shows.

## Left to the builder

Storage format of the version field, the exact UI of the picker and the conversion marking,
how the oracle selects GT version at build time, order of work.
