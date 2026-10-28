# Dataset pipeline (tools/dataset-pipeline)

A Forge mod (`gtnh-calc-oracle`) running inside a real GTNH client (2.9 or 2.8.1) exports every
recipe map, NEI layout, catalyst, multiblock config and rendered icon. Node scripts in
`scripts/` normalize that into the `RecipeDataset` the app reads:
`normalize-oracle-export.mjs`, `machine-configs.mjs`, `build-resource-index.mjs`,
`build-recipe-index.mjs` (recipe index, lookup index, 250-recipe shards).

## Build and publish

Datasets are built only by the repo's command, on a machine with Docker:

```bash
npm install                                                            # the image runs the scripts with the repo's node_modules
node tools/dataset-pipeline/scripts/build-datasets.mjs all --export   # export both packs, rebuild, install
node tools/dataset-pipeline/scripts/build-datasets.mjs 2.9            # rebuild 2.9 from its last export
```

Before the first run:

- Docker: OrbStack or Docker Desktop on the Mac, Docker Engine on Linux. The containers run as your user
  (`--user`), so nothing they write is root's. The VM needs about 10 GB of memory (the game takes 4 to 6 GB of
  heap, plus xvfb and llvmpipe; `GTNH_EXPORT_MAX_MEMORY` sets the heap) and every core it can get.
- Disk: about 15 GB under `.pipeline/datasets/` (pack zips, unpacked raw exports, the previous export, the replaced
  copies, `recipes.json`, Gradle and icon caches), 1.5 GB installed, and the two instance volumes (about 1.2 GB each).
- Network, first run only per cache: `downloads.gtnewhorizons.com` (pack zips), `nodejs.org` and Docker Hub (the
  image), Maven repositories and `maven.minecraftforge.net` (the oracle's Gradle build), Mojang's
  `launchermeta`/`libraries` hosts (the client's libraries).
- Time, on an M-series Mac: an export is 10 to 12 minutes per pack cold (Gradle and the client's libraries
  downloading, every icon rendered), about 7 warm; a rebuild alone is about 5 minutes per pack. The image is
  rebuilt on every run, from cache in seconds.

Options and steps:

1. Versions: `2.9` (`local-2.9.0-rc-2`), `2.8.1` (`local-2.8.1`), or `all`. The pack table in
   `build-datasets.mjs` names each pack's client zip URL and its SHA-256, the oracle pack and the Docker volume.
   The zip comes only from that URL and is used only while its bytes hash to the pin, on download and on every
   reuse from the cache; a pack re-uploaded under the same name fails the run. 2.8.4 is retired.
2. `--export` runs the GTNH client with the oracle in the pipeline image (`docker/Dockerfile`: base images by
   digest, Node by version and checksum), through `run-gtnh-oracle-export.sh`: the instance unpacks onto its
   case-sensitive volume (`gtnh-rc2-client-instance`, `gtnh-281-client-instance`), and the raw export
   (`oracle-export.json`, `rendered-icons/`, `machine-data/`) is written to `.pipeline/datasets/<id>/raw-export.new/`.
   Only a finished export replaces `raw-export/`, and the one it replaces stays as `raw-export.previous/` (for
   `oracle-diff.mjs`); a failed one leaves the last good export in place. Export once per pack version and after
   an oracle change; it is the only way to get NEI's item list, and an export whose list is not `exported` is not
   installed unless `--carry-nei-order` says to carry the installed copy's order. `--fresh-icons` empties the
   pack's icon cache first: the cache serves an icon by its stack whatever renderer drew it, so a renderer change
   needs it. Never export with `GTNH_RENDER_STACK_ICONS=false`: the export stamps icon filenames, and a run
   without them broke live search.
3. Every run then rebuilds from the raw export in the image (`rebuild-dataset.sh`, the pack's mod jars read
   from the volume): normalize, icon hints, asset fingerprint, resource index with NEI's order, recipe index
   and shards, faint fluid icons, gzips. `recipes.json` stays in `.pipeline/datasets/<id>/`; it is never published.
4. The build is installed into `public/datasets/gtnh/<id>` (`--out` for another root) only when the publish
   checks pass (`deploy-lib.mjs`: icon hints resolved, and no NEI order lost against the installed copy). The
   rendered textures the installed copy has and the build lacks are copied into the build first, as a publish adds
   them (saved plans cite names an earlier export drew); then two renames swap the copies, the old one to
   `.pipeline/datasets/<id>/replaced/`. Installed into the default root (or with `--power-maps`), the build also
   points the power maps (`src/lib/power/data`) at itself: `refresh-power-maps.mjs --check` runs against the build
   before the swap, so a map naming an id the build lacks refuses the pack with nothing swapped and nothing written
   (the map's choice needs `tools/power-machine-icons.mjs` or `tools/power-resource-map.mjs` again); after the swap
   each map entry's icon, colour and name become the installed build's record for its id, so a map never cites an
   icon the build does not draw. A refresh that fails after the swap leaves the pack installed and says so. `--out`
   elsewhere leaves the repo's maps alone unless `--power-maps`. Exam: the power map tests check every map icon is
   the dataset's icon for that id, `scripts/refresh-power-maps.test.mjs`.
5. Every pack runs even when one fails, and the manifest is rebuilt whenever one was installed (a swap happened),
   so it always names the installed bytes. A refused or failed pack is listed at the end and the command exits 1; a refused build
   stays in `.pipeline/datasets/<id>/dataset/`. Logs: `.pipeline/datasets/<id>/logs/` (`export.log`,
   `build.log`, the last run's as `.previous`). Exam: `scripts/build-datasets.test.mjs`.
6. A failed export: read `logs/export.log` (the runner prints the last 160 lines of the game log on a crash). The
   last good export is still in `raw-export/`, so `build-datasets.mjs <version>` rebuilds it; `raw-export.new/` holds
   what the failed one wrote. A stuck run leaves its container: `docker rm -f gtnh-export-<29|281>`. An instance
   volume in doubt can go (`docker volume rm <volume>`): the next export unpacks the zip onto a new one.
7. Publish with `tools/deploy/publish-datasets.sh <target> <id>...` (`docs/deploy.md`, Datasets) into the
   server's `/srv/gtnh/datasets/<id>/`. It keeps this order, and any other way of publishing must too:
   1. Textures first, additively, straight into the served directory: `rsync -a --ignore-existing`. Never
      `--delete`, never a staged swap of `textures/`, never removing a file there. Texture URLs
      are served immutable for a year: a browser or Cloudflare holding an old URL keeps asking
      for it, and saved plans' own icons, card overrides, cached recipe responses and
      the power maps (`src/lib/power/data/*.json`) name old files. A content name never changes
      its bytes, so `--ignore-existing` is safe, and the served directory grows by the changed
      icons on each publish. The first publish with content names renames every icon once.
   2. Then the data: staged in `/srv/gtnh/datasets-staging` (outside the served root), moved in entry by entry,
      never `recipes.json`; the manifest last; then a site restart. Before publishing, compare icon counts and
      icon tables against the served ones (every name changes on the first content-named publish), and check that
      every rendered name the new gzips cite exists in the build's `textures/rendered/`.
   The dataset tree is the pipeline's bytes alone, and the site mounts it read-only: the site's own
   content-addressed answers (`/datasets/gtnh/<id>/client/...`, `src/lib/server/client-files.ts`) live in its
   cache directory (`GTNH_CLIENT_FILES_DIR`), never under a version directory, and a publish neither copies nor
   checks them. The script writes only version directories; the datasets root is the infra role's.
   3. The script verifies the served manifest, every published gzip's checksum, a texture per version and
      `recipes.json` refused. Commit the power maps the build refreshed with the datasets they name.

`build-recipe-index.mjs` also writes `recipes.json.gz` from the bytes of `recipes.json`. Every
dataset gzip goes through `deterministic-gzip.mjs` (level 9, no name, zero mtime, OS byte pinned
to Unix), so one `recipes.json` gives the same files and manifest checksum on macOS and in the image.

Texture URLs are cache-immutable (a year, no dataset checksum in the URL), so a changed icon
must get a new name. The normalizer stages every rendered icon (item, block, fluid) under a
content-addressed name (`stage-rendered-icons.mjs`): the export's `<slug>-<sha1(stack key)[:12]>.png`
becomes `<slug>-<sha1(bytes)[:12]>.png`, same length, and the dataset records point at that. A
rebuild whose pixels did not change keeps every URL; one whose pixels changed moves only those.
Exam: `stage-rendered-icons.test.mjs`. Publishing adds files beside the live ones and never deletes
old names: a plan's own icon and other stored references keep the name they were saved with.

Icon hints: where the oracle knows a texture's name but draws no pixels it writes
`asset:<mod>:textures/...` into `iconPath` (`GtnhCalcOracleExporter.aspectIconPath`: the 21 Thaumcraft
aspects other mods add, GregTech's Radio, Electrum and Magneto among them). A browser cannot load it and
the app draws `?`. `resolve-icon-hints.mjs <instance root or mods dir> <recipes.json> <out dir>` runs after
the normalizer and before the index builds (`rebuild-dataset.sh`). It reads `recipes.json` line by line, so it runs
on a dataset of any size, copies each hinted PNG out of the mod jars to
`textures/rendered/<mod>_<file>-<sha1(bytes)[:12]>.png`, rewrites every copy, clears a hint no jar holds (listed,
with the missing mod, in `textures/icon-report.json`), and refuses a mods directory with no jars rather than clear
them all. `publish-datasets.sh` refuses a version with no icon report, one
that says `skipped`, or any published file holding `"asset:` (`deploy-lib.mjs icons`). Exam:
`resolve-icon-hints.test.mjs`, `tools/deploy/deploy-lib.test.mjs`.

Every rebuild runs `normalize-fluid-icon-alpha.mjs --rename` after the index builds
(`rebuild-dataset.sh`), on 2.9 as on 2.8.1, so faint fluids never ship invisible. It
repaints fluids under 20% mean opacity under a NEW content name and patches whole basenames
only; a fluid it leaves alone already has its content name, so the pass changes nothing on a
dataset with no faint fluid.

`rebuild-manifest.mjs` lists every complete dataset under the root, newest pack first. Its
`latestStableVersion` (the app's default) is `GTNH_LATEST_STABLE_VERSION` when set (it must name
a dataset there), else the previous manifest's while that dataset remains, else the newest
`stable-*` build. Local builds are all "experimental", so the default survives a rebuild only
through the previous manifest. A new `stable-*` build therefore never takes the default from a
previous one still present: set `GTNH_LATEST_STABLE_VERSION` to switch. Exam: `scripts/rebuild-manifest.test.mjs`.
Every published file and directory name under a version stays within `[A-Za-z0-9._-]`: the site's request gate
(`src/server/middleware/dataset-gate.ts`) refuses any dataset path a browser would percent-encode, so a name with a space, `#`, `%`, `?` or a
character outside ASCII would be unreachable. `rebuild-manifest.mjs` refuses a version directory holding one
(`scripts/publishable-names.mjs`). Exam: `scripts/publishable-names.test.mjs`.

Recipe ids come from what a recipe is, never from the export: `recipeContentKey` in
`normalize-oracle-export.mjs` hashes the map (GT++'s `gtpp.recipe.*` read as
`gt.recipe.*`), sorted slots, amounts, chances, ticks, EU and special value, plus the grid
cell of a shaped pattern. The id is `oracle:<category>:<map>:<hash>` with no dataset
version, so a rebuild or another pack keeps every unchanged recipe's id with nothing to
carry. Recipes sharing a key take `-2`, `-3`... in the order of a hash of their whole body.
Bees, crops, veins, small ores, mobs and underground fluids keep ids named by their game identity,
and only the same identity folds: two veins with the same ores in other dimensions stay two veins.
An identity exported twice folds only when both copies are the same; different contents under one id
refuse the export (`identityExportGaps`, listed in the oracle report's `failures`).
Some recipes differ between two exports of one pack because the game rolls them (Crop
Breeder and assembly line ore picks, Gadomancy aspects, and Thaumcraft's generated item
aspects behind essentia smelting): 18 to 70 ids across three pairs of exports. A plan
holding one finds it again by content (`resolveProjectRecipes`). Exam: `normalize-oracle-export.test.mjs`.

Datasets built before this carry versioned ids (`oracle:local-2.9.0-beta-2:...`) and the
published RC-2 still does; `scripts/carry-recipe-ids.mjs` maps ids between such builds.

## Pre-2.9 exports

2.8.1 (`-PgtnhPack=2.8.1`, GT5U 5.09.51) normalizes with the same code. Exam: the
"a GTNH 2.8.1 export" block in `normalize-oracle-export.test.mjs`, over
`__fixtures__/oracle-2.8.1-sample.json` (trimmed from the real export). What differs:

- No version in the export: `gtnhVersion` is `GTNH_DATASET_VERSION_LABEL` (`2.8.1`), the id
  `GTNH_DATASET_VERSION_ID` (`local-2.8.1`). A version-specific rule keys on `gtnhVersion`, never the id.
- GT++ maps are `gtpp.recipe.*`: ids read them as `gt.recipe.*` (`gameRecipeMapId`), so unchanged
  recipes keep their 2.9 id. Two took other names in 2.9: `cokeoven` is `industrialcokeoven`, and
  `thermalgeneratorfuel` (the Thermal Boiler, which shares its id with GT's geothermal fuel map) is
  `thermalboiler` (`RECIPE_MAP_ID_RENAMES`).
- Cell fills and empties live in `gt.recipe.fluidcanner` ("Fluid Canner"), mirrored into the Tank like the Canner.
- `gt.recipe.multiblockrockbreaker` is exported untranslated (its name is its id) and with no
  catalysts: it is named Boldarnator (`UNTRANSLATED_RECIPE_MAP_NAMES`, used only when the name is the id).
- No fluid alternatives (5.09.51 has no `mAltFluidInputs` or `mOreDictAlt`): fluid slots carry none.
- No CropsNH (`cropsnh-crop-cards` is `not_present`): IC2 crops normalize alone; 159 of 160 drop
  something (Weed drops nothing in the game either).
- Mining: dimensions carry no `tier`, so none is written; small ores name dimensions by full name
  in `dims` (no `enabledDims`), resolved through the `fullName` alias; veins have no `dimHeightRanges`.
  5.09.51's NEI plugin lists only `OreMixes`, so the oracle also reads bartworks' `BWOreLayer.sList`
  (Ross128b/ba) and `WorldGenEvergladesOreLayer.sList`, with each vein's chance among its dimension's
  veins. Everglades veins take 2.9's ids (`ore.mix.gtpp<n>`, n their `validOreveins` number) and its
  dimension naming (`dimensionDarkWorld`, `Eg`, added to `dimensions`); every 2.8.1 Everglades layer
  is configured at y 5-14 whatever it is given (ore blocks at about y 4-13), and the export says so.
- `getMaxCatalystDurability` takes the catalyst stack there (no argument in 2.9); the oracle tries both,
  so Chemical Plant catalysts export `wearingInputs` on both. Nothing reads `wearingInputs` yet.
- Machine names are the version's own (Primitive Blast Furnace, Naquadah Reactor MkI, Zhuhai -
  Fishing Port); `machineType` keeps them, so tables keyed by name need the 2.8.1 spelling too.
- Machine knobs follow the pack (`gtnhVersion` threads into `buildMachineHandlerTemplates` and
  `machineConfigControlsForOracleRecipe`): the 2.8.1 Industrial Coke Oven has no coils or slices and
  its casing control is keyed `"18"`/`"30"` (the app reads the key as the parallels); the 2.8.1
  Industrial Cutting Factory takes no sawblade (`ABSENT_BY_PACK` in `machine-wiki-stats.mjs`). Exam:
  `machine-configs-2-8-1.test.mjs`, and through the normalizer the 2.8.1 block's Cutting Factory test.
- Generators named Mark I to IV fold into one tiered family (Plasma Generator Mark, EV to ZPM);
  2.9's Mk-I names keep one family per mark.
- 2.8.1 registers one arcane wand or sceptre recipe per rod and cap pair, all with the same
  output item (the wand is its NBT): they stay apart by their grid items and share one catalog
  resource, named after one of them. Each output slot keeps its own name (and, where the export
  drew one, its own icon), and the app shows the slot's: a slot that is the browsed or context
  item keeps its own face (`contextualizePreviewRecipe`, `applyUsesResourceContext`,
  `buildRecipeInputOverrides`), as on 2.9's shulker box colours and Forestry saplings. Thaumcraft
  wands render no pixels on 2.8.1 (`dropped-icons.json`), so they have no icon there.

## NEI's item list order (NeiItemListExport.java)

- The export's root `neiItemList` is every stack NEI's item panel lists, sorted as the pack's
  `inventory.itemsort` sorts it (`minecraft, mod, id, default, damage, name` in both packs), one resource key per
  stack (`item:<id>[@meta]`, `fluid:<name>`, `aspect:thaumcraft:aspect:<tag>`, null where a stack has none), with
  `status` (`exported`, `failed` with `error`, `not_present`) and the `sort` it used; adapter `nei-item-list`.
- NEI builds that list only when a world loads and the oracle exports from the main menu, so the export does what the
  load does with NEI's own code: `NEIClientConfig.bootNEI()`, then a join of the "NEI Plugin Loader" thread (its flag is set before `NEIConfigsLoadedEvent`, whose handlers may still hide items) (plugins hide items and
  add variants; `ItemInfo` fills the owners the `mod` rule reads), NEI's `getPermutations` per registry item, the
  registry-order numbering into `ItemSorter`'s `default` rule, `ItemStackSet` for duplicates, `ItemSorter.sort`. It
  runs last, after every domain, so nothing else sees NEI half booted. Then NEI's collapsible groups, as both NEI
  versions apply them after the sort (`updateOrdering` and the panel's stable sort by it): every member of a group
  moves to the group's first member's place, in sorted order, expanded or collapsed (`NeiOrdering.groupOrdered`,
  exam `NeiOrderingTest`). `-Dgtnh.oracle.neiItemList=false` skips it;
  `gtnh.oracle.neiBootTimeoutSeconds` (900) bounds the wait.
- Per pack, by what the classes have, never by a version check: 2.9's NEI (2.8.155-GTNH) has `getPermutations`
  static on `ItemListLoader` and lists fluids as `neiFluidDisplay` stacks (`StackInfo.isFluidDisplayItem`, mapped to
  the fluid); 2.8.1's (2.8.19-GTNH) has it on the `ItemList.loadItems` task and lists no fluids. Aspects come from
  aspectrecipeindex (2.9) or the Thaumcraft NEI plugin (2.8.1) by the plugin's `getAspects` or Thaumcraft's
  `Aspects` NBT.
- Client only: a dedicated server writes `not_present` (`server side`), so the list comes from the client export
  (`GTNH_EXPORT_PACK_KIND=client`), the only kind `build-datasets.mjs` runs.
- A failure is logged and leaves `status: "failed"`; the rest of the export is unchanged.
- The pipeline (`scripts/nei-item-order.mjs`): the normalizer writes `neiItemOrder` (each key once, at its first
  place, so a resource NEI lists as several NBT stacks takes the smallest index); `build-resource-index.mjs` writes
  `resourceOrder`, one place per `resourceIndex` record or null where NEI does not list it, and
  `build-recipe-index.mjs` copies it beside `resourceIndex` in `resource-index.json.gz`. A separate array, never a
  field per record: a field changes every byte of every `/resources` answer. An export without the list writes
  neither, and the files come out byte for byte as before. A list whose `sort` does not start with NEI's default
  (`NEI_DEFAULT_SORT`: the export instance's `inventory.itemsort` was changed) is refused with a WARNING line.
- An export without the list (one whose list failed, run with `--carry-nei-order`) carries the order on, as icons are carried: `build-resource-index.mjs` takes it
  from this version's last build (its `resource-index.json.gz`, before it is overwritten), then from
  `GTNH_PREVIOUS_DATASET_DIR` (the installed copy, which `build-datasets.mjs` mounts); `GTNH_NEI_ORDER_CARRY=0` turns
  that off. A dataset left with no order prints `WARNING: this dataset has NO NEI order`, and
  `publish-datasets.sh` refuses a version that would lose the order its served copy has (`docs/deploy.md`). The app places nulls after every placed record and sorts
  a dataset with no order by its approximation (`src/lib/search/nei-order.ts`). Exam: `nei-item-order.test.mjs`.

## Stand-ins: one stack, member or drop by the game's rules (scripts/stand-in-order.mjs)

The export walks the game's hash maps, so the order it meets stacks in changes between two exports of one pack.
Nothing the app shows may follow that order:

- The catalog's record for an id (name, icon, NBT tooltip, the search text) is always one stack's, never a name from
  one stack over another's icon. Where NEI lists the item and the export drew NEI's first listed stack (the oracle
  writes each item key's first stack beside the list, `neiItemList.firstStacks`, with its NBT, name and the icon the
  export already drew for that exact stack: nothing new is drawn for the list, since drawing every first stack
  crashed llvmpipe on 2.8.1's Draconic armour), that stack stands for it (`applyNeiStandIns`). Otherwise the rule's
  stand-in: the stack with no NBT, else the smallest NBT string, then the smaller name (`compareStandIns`), among the
  stacks with an icon when any has one. `build-resource-index.mjs` names each `resourceIndex` record after the
  catalog, never after the first recipe slot, and orders equal recipe counts by key.
- An ore dictionary tag's members (a slot's alternatives and the catalog's): GregTech's unification target for the
  tag first (`oreDictionary.unificationTargets`, from the unificator's name-to-stack map), then NEI's order, then
  id (`orderOreMembers`).
- A map's icon: its NEI catalyst where the export has one (GregTech's maps, crafting, Thaumcraft, the machines the
  normalizer names). A map built from many records with no catalyst (bees, crops, veins, small ores, underground
  fluids) takes the candidate first in NEI's order, then by id (`setRecipeMapIcon(..., { ordered: true })`).
- CropsNH drops: heaviest weight first, then id (`orderCropDrops`); liked biome tags and soils are sorted.
- Recipes and their numbers are untouched. Exam: `stand-in-order.test.mjs`, the "stand-in" block in
  `normalize-oracle-export.test.mjs`.

## Comparing two exports (scripts/oracle-diff.mjs)

- A new export of a pack is checked against the previous one before its build is published (`--export` keeps the
  previous raw export as `raw-export.previous`):
  `node tools/dataset-pipeline/scripts/oracle-diff.mjs .pipeline/datasets/<id>/raw-export.previous .pipeline/datasets/<id>/raw-export`
  (about 12 GB of heap; it re-runs itself with it). Exit 0 means every difference is a known one: record order
  the game fills from hash maps, display names an item rolls each start, and the records each rule in
  `GAME_ROLLED` names. Pixels are not compared (time-driven icons differ every export).
- Every rule has a ceiling of about twice the worst count seen between exports of one pack; past it the records
  count as unexpected, so a real loss cannot hide under a rule. Rules seen only on 2.8.1 apply only to a 2.8.1
  export. A new rule needs the records it covers named and its ceiling measured, never a looser match.

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
- Each icon starts from the GL state the first icon rendered in (`applySavedGlState`, before the draw
  as well as after it): the first icon of a frame otherwise inherited the menu screen's state, depth test
  off, and a fresh 2.9 export drew about a hundred blocks inside out there (the RC-2 dataset shipped such
  icons). The restore after each icon also covers face winding, the culled side and the texture matrix:
  without them cells came out on a solid square and some machines, ores and Bibliocraft or ProjectRed
  items garbled after the icon before them.
- Each icon starts from CodeChickenLib's reset state with dynamic lighting on (`LibraryRenderState`:
  `CCRenderState.reset()`, then `setDynamic()`), the state CCL item renderers leave. A CCL model drawn
  without its own reset inherits the last icon's state: without the reset, 2.8.1's Logistics Pipes
  crafting table, power junction and security station came out blank in a fresh export. A reset alone
  leaves CCL's face shading on, and 2.9's Logistics Pipes pipe items (a vertex buffer built on their first
  draw) came out darker than a chest GUI frame in the game draws them. Exam: `LibraryRenderStateTest`.
  Every icon the checks drop is listed with its reason in `dropped-icons.json` beside `icon-map.json`
  (the log shows only the first `gtnh.oracle.maxIconRenderWarnings`).
- The missing-texture check counts magenta only beside the checkerboard's black half (`IconChecks`):
  plain magenta is a tint, as on 2.8.1's computronics colorful upgrade, whose cycling colour dropped
  it at random. Exam: `IconChecksTest` (`gradlew test`, part of `build`).
- GregTech 5.09.51 (2.8.1) animates some materials' colours on every client tick: its client proxy walks lists
  such as `mPosR` and `mMoltenNegB` (Enderium, Thaumium, the infused materials, Uranium, Plutonium, Naquadria,
  Nether Star, Force, Vinteum, Sunnarium) and moves one channel of each `mRGBa` by one, turning every 50 ticks.
  Every part of those materials (GT and TGregworks tools, ingots, plates, molten fluids) showed whatever colour
  the tick count had reached: two cold exports of 2.8.1 drew 2,132 icons a few to 30 levels apart.
  `MaterialColorFreezer` copies every material's colours when loading completes, before the first client tick,
  and while icons render empties those lists and puts the copied colours back. 2.9's GregTech has no such
  lists. The icon cache keeps what an earlier renderer drew, so export with `--fresh-icons` after a change here.
- Animated textures are held on their first frame while icons render
  (`IconAnimationFreezer`), so fluids and machines come out the same on every export. About
  400 icons from time-driven renderers still differ between exports (magmatter, infinity, six-phased
  copper, the timepiece, the phononic seed crystal, TwilightForest's carminite reactor debris). About 37
  GT++ alloy items (Laurenium, Grisium, Eglin Steel, Indalloy 140, Octiron) change with each game launch:
  GT++ picks their texture set (shiny or metallic) by a hash map count whose ties fall by identity hash.
- The mod writes `icon-colors.json` beside the icons (`IconColors`, a step-for-step port of
  `getDominantOpaqueColor`); `stage-rendered-icons.mjs` decodes only icons it lacks. The two
  must stay identical.
- The icon cache (`GTNH_ICON_CACHE_DIR`) is one PNG per icon plus `icon-pack.bin` (`IconCache`):
  every cached icon's bytes and colour in one file, rewritten by an export that changed it. Opening
  a file through the bind mount costs about 0.7 ms however many threads ask, so hits read file
  by file take over a minute; pack hits run on the encode threads with no decode. A pack entry
  serves while its PNG keeps the size and mtime it was packed with; same size with another mtime
  is compared byte for byte first. A pack hit skips the item check (`IconChecks`) and the colour,
  so the pack format carries their answers on fixed images: changing either sets old packs aside
  without a manual bump. The first export over a cache with no usable pack reads file by file.
  Clone a run dir's `icon-cache` with `cp -cRp`: without kept mtimes every entry is re-read once.

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
- Thaumcraft arcane recipes (`ShapedArcaneRecipe`, `ShapelessArcaneRecipe`, the same classes in
  2.8.1 and 2.9) keep their grid in `input`, read through `getInput()`: a shaped cell exports its
  3x3 `gridSlot` (row * 3 + column), placed there and keyed by it like shaped crafting; a
  shapeless recipe takes every entry. A cell stack of size 0 counts as one item. A cell the
  oracle cannot read is counted in `unresolvedGridInputs` with its class and text
  (`unresolvedGridCells`); the normalizer lists those recipes in the oracle report
  (`unresolvedArcaneGrids`) and refuses the export above 2. Arcane subclasses (Automagy's
  filter copy, Witching Gadgets' photo) land in the generic "Thaumcraft" map. Arcane ids from
  before the grid (RC-2 and older) carry aspects only: plans find them again by output and
  exact aspect cost (`isGridlessArcaneMatch` in `src/lib/import-export/recipe-ref-match.ts`,
  kept on for good).
- A recipe's `minimumTier` and its singleblock handlers' divide the EU/t by the map's amperage
  (`recipe-map-amperage.mjs`, keyed by `gtnhVersion`, pinned to the app's table by its test);
  multiblock handlers keep the tier of the whole EU/t.
- Concrete items carry their oredict membership.
- What a slot accepts (2.9's `SubstituteFluidStack`, `mOreDictAlt`) stays on that recipe's input. The
  catalog and the resource index carry only item-level alternatives (ore dictionary groups): the server
  gives every slot without its own the index entry's. Exam: `build-resource-index.test.mjs`.
- A steam multiblock with no fluid input hatch leaves a recipe with a fluid input, and one with no fluid
  output hatch a recipe with a fluid output, per pack (`steam-fluid-hatches.mjs`: inputs, 2.9 the
  Separator, Grinder, Fuser and Hearth, 2.8.1 also the Squasher and Presser; outputs, all but the
  Separator and Blender, since void protection is on by default). NEI lists them on the whole map.
  Exam: `steam-fluid-hatches.test.mjs`. The local datasets got the rule by re-applying it to their
  normalized `recipes.json` (no raw exports at hand): at the next run from raw exports, diff its shards
  against those. Expected: identical but for stamps, with 81 recipes on 2.8.1 and 70 on 2.9 short of the
  steam handlers the rule removes.
- NEI layout: keep exported slot positions and progress bars; empty slots stay visible;
  non-consumed slots stay visible except TGS tool placeholders; never replace a real slot
  with a fake label.
- Every fluid-touching Canner recipe is mirrored into the synthesized "Tank" map
  (`addTankRecipe`, 0 EU, 1 tick, real slots).
- The Tree Growth Simulator, Bacterial Vat and radio hatch facts the recipes lack go to
  `machine-data/` beside `oracle-export.json` (`MachineDataExport`, ids only, no icons), for
  `tools/audits/import-machine-side-data.mjs`. The export's order of the radio hatch's GT++
  rods changes on every launch, so the importer sorts the materials by id.
- IC2 crop drops are sampled from the crop card on a simulated tile, at the largest size
  where `canBeHarvested` holds (Eating Plant drops only below its max size). An item's amount per
  harvest round is (its summed stack sizes + its hits x (gain + 1) / 100) / samples, keyed by id,
  damage and NBT: the game adds the gain bonus to the one stack a round drops, so Red Wheat at gain
  31 makes 1.32 items a round, not 0.32 per item. `IC2.random` and the world's random are seeded
  per crop and stat set, so a rebuild samples the same harvests; crops rolling their own generator
  (GT's ThreadLocalRandom, CropsPP's XSTR) still move a little. Crop methods are called with
  `setAccessible` (`invokeCrop`; CropsPP's Bonsais are a package-private class). During `getGain`
  the tile reports `OracleCropWorld`, an all-air world with no constructor run, so Red Wheat and
  Mana Bean can read it (Mana Bean exports only the bean of no crystal cluster under it). Each block
  a crop asks for under it (`isBlockBelow`) and a redstone signal is sampled again on its own;
  conditions with the same items at the same rates share one recipe
  `ic2-crop:<owner>:<id>:under-<block>` (or `:redstone-signal`) whose `metadata.requirements`
  ("Needs Red Granite under it") the recipe search card shows (`CropRequirementNote`); the plain
  crop keeps its id. IC2's own cards export their lang key (`ic2.crop.redwheat`) as the name, on
  2.8.1 and 2.9: the normalizer names them after their seed bag ("Redwheat Seeds" is Redwheat),
  else from the key's last part (`ic2CropDisplayName`, only for crops IC2 owns); ids never use the name. Exam: the IC2 crop
  block in `normalize-oracle-export.test.mjs`.
- Extreme Entity Crusher mobs come from the `kubatech-eec-mobs` oracle adapter (drop
  chances replayed in `eec-drops.mjs`). Sparge Tower rolled outputs and fusion startup EU
  are per-recipe export fields; `sparge-byproducts.mjs` appends rolled slots AFTER the
  exported ones so recipe ids stay stable. The oracle picks the GT++ maps for sparge and
  wear data by name without the mod prefix (`isGtppMap`: `gtpp.recipe.*` to 2.8,
  `gt.recipe.*` since 2.9). The normalizer refuses an export whose sparging map has
  recipes but none with `spargeFluidOutputs`, and one whose Chemical Plant or IsaMill map has
  recipes but none with `wearingInputs` or any with `wearError` (`spargeExportGaps`,
  `wearExportGaps`; listed in the oracle report's `failures`). It deletes its `recipes.json`
  and `recipes.json.gz` before it starts, so a refused run leaves no earlier output behind.
- Faint fluid icons: repair only captures under 20% mean opacity, starting from the
  original PNGs (`normalize-fluid-icon-alpha.mjs`).
