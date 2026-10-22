# Dataset pipeline (tools/dataset-pipeline)

A Forge mod (`gtnh-calc-oracle`) running inside a real GTNH 2.9 client exports every
recipe map, NEI layout, catalyst, multiblock config and rendered icon. Node scripts in
`scripts/` normalize that into the `RecipeDataset` the app reads:
`normalize-oracle-export.mjs`, `machine-configs.mjs`, `build-resource-index.mjs`,
`build-recipe-index.mjs` (recipe index, lookup index, 250-recipe shards).

## Rebuild and publish (by hand, in WSL)

The GitHub "GTNH dataset pipeline" workflow is a decoy (no runner). Never dispatch it.

1. `~/gtnh-factory-flow` in WSL Ubuntu is a git-less SNAPSHOT: copy changed pipeline
   scripts into it first or the rebuild runs old code.
2. Raw exports live at `~/gtnh-factory-flow/.pipeline/raw-export/<id>/oracle-export.json`
   with `rendered-icons/` beside them; reuse them while the pack version stands. Never
   export with `GTNH_RENDER_STACK_ICONS=false`: the export stamps icon filenames, and a
   run without them broke live search.
3. `~/run-both.sh` (fuller: `~/rebuild-cokeoven.sh`) normalizes, indexes and gzips into
   `~/gtnh-export/datasets/gtnh/<id>`. Only 2.9 is supported; 2.8.4 is retired.
4. `~/copy-datasets.sh` copies results into the Windows repo's `public/datasets/gtnh`.
5. Publish: scp the changed gzips, shards and oracle-report to the droplet's
   `/opt/shared/gtnh-datasets/<id>/` (stage first; move staging dirs out of the datasets
   root before `rebuild-manifest.mjs`), then `systemctl restart gtnh-flow`. Before the
   swap, compare icon counts and icon tables against live. Verify the live manifest and
   the published gzip afterwards.

Rebuilds must run `normalize-fluid-icon-alpha.mjs` (with `--rename`) after the index
builds and before publishing, or faint fluids ship invisible. Texture URLs are cache-immutable: fix pixels under a NEW filename (`--rename`),
and patch whole basenames only.

Recipe ids come from what a recipe is, never from the export: `recipeContentKey` in
`normalize-oracle-export.mjs` hashes the map (GT++'s `gtpp.recipe.*` read as
`gt.recipe.*`), sorted slots, amounts, chances, ticks, EU and special value, plus the grid
cell of a shaped pattern. The id is `oracle:<category>:<map>:<hash>` with no dataset
version, so a rebuild or another pack keeps every unchanged recipe's id with nothing to
carry. Recipes sharing a key take `-2`, `-3`... in the order of a hash of their whole body.
Bees, crops, veins, mobs and underground fluids keep ids named by their game identity.
About 20 recipes differ between two exports of one pack because the game rolls them
(Crop Breeder and assembly line ore picks, Gadomancy aspects); a plan holding one finds it
again by content (`resolveProjectRecipes`). Exam: `normalize-oracle-export.test.mjs`.

Datasets built before this carry versioned ids (`oracle:local-2.9.0-beta-2:...`) and the
published RC-2 still does; `scripts/carry-recipe-ids.mjs` maps ids between such builds.

## Exporting on Apple Silicon

The client export runs natively in arm64 Docker (OrbStack): `prepare-forge-client-launch.mjs`
picks LWJGL's `linux-arm64` natives, and Mesa llvmpipe renders under xvfb. Keep the instance
on a case-sensitive Docker volume: the pack has file names that differ only in case.

- Icons render into a pool of reused framebuffers and are read back 64 at a time
  (`gtnh.oracle.iconReadBackBatch`); PNG encoding and writes run on a thread pool. Do not
  draw several icons into one framebuffer: llvmpipe rasterizes 3D blocks differently there.
- A flat item icon (every 8x8 square one colour, about 70% of items) is written as 32x32,
  one pixel per texel, margins kept (`asPixelArt`). The app draws every icon pixelated and
  sized from the padded canvas, so it shows the same picture; blocks and models stay 256.
- Animated textures are held on their first frame while icons render
  (`IconAnimationFreezer`), so fluids and machines come out the same on every export. About
  400 icons from time-driven renderers still differ between exports.
- The mod writes `icon-colors.json` beside the icons (`IconColors`, a step-for-step port of
  `getDominantOpaqueColor`); `stage-rendered-icons.mjs` decodes only icons it lacks. The two
  must stay identical.

## Import principles

- Prefer data exported from NEI or the runtime over hand-written tables and fallbacks.
- A missing recipe: check the raw oracle export first, then the mod source at the pack's
  exact GT tag.
- A map with one uncapped machine family carries no `machineHandlers` by design; a lone
  capped singleblock keeps its handler (below).
- Never parse tooltips globally. Multiblock stats come from tooltips only for catalysts
  flagged `multiblock` (`isMultiblockCatalyst` in `machine-configs.mjs`); singleblocks read
  only `Voltage IN` and `Machine Type`.
- Fold singleblock tier variants into one family (Liquefying Suckers are Fluid
  Extractors); multiblocks stay separate handlers (Large Fluid Extractor, Steam
  Separator). A map with one real family keeps the map name.
- Singleblock families: group voltage-input singleblocks by Java class plus their
  `Machine Type` tooltip (else recipe-map membership), named from the lowest tier. Keep a
  lone capped handler, or its `maximumTier` disappears. Exam:
  `scripts/singleblock-tiers.test.mjs`. A multiblock whose name collides with a
  singleblock gets its own id.
- Concrete items carry their oredict membership.
- NEI layout: keep exported slot positions and progress bars; empty slots stay visible;
  non-consumed slots stay visible except TGS tool placeholders; never replace a real slot
  with a fake label.
- Every fluid-touching Canner recipe is mirrored into the synthesized "Tank" map
  (`addTankRecipe`, 0 EU, 1 tick, real slots).
- Extreme Entity Crusher mobs come from the `kubatech-eec-mobs` oracle adapter (drop
  chances replayed in `eec-drops.mjs`). Sparge Tower rolled outputs and fusion startup EU
  are per-recipe export fields; `sparge-byproducts.mjs` appends rolled slots AFTER the
  exported ones so recipe ids stay stable.
- Faint fluid icons: repair only captures under 20% mean opacity, starting from the
  original PNGs (`normalize-fluid-icon-alpha.mjs`).
