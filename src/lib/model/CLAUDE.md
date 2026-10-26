# Domain model (src/lib/model)

Types, Zod schemas, resource keys, recipe rules, and the load funnel
(`project-normalize.ts`) every saved or imported plan passes through.

## Cells are items

- A filled cell is an ordinary ITEM; it never satisfies its fluid's slot or the reverse.
  `resourceMatchesInput` compares kinds strictly. Don't add a cross-kind branch.
- Crossing forms takes a machine, as in the game (thousands of Canner recipes). The
  pipeline also mirrors fluid Canner recipes into a free "Tank" map (0 EU, 1 tick, real
  slots including empty cells).
- No wire crosses forms: a cell and its fluid meet only in a fluid tank card
  (`fluid-tank.ts`), as in the mod. A cell port and a fluid port never take or glow for
  each other's wires.
- Older plans carry loose cell wires (`edge.crossForm`: the Canner's litres per cell).
  `convertLooseCellWires` (cell-wires.ts) makes each a tank card between its two ends where
  a plan lands: the funnel, `applyLiveOps`, a paste, Pool's bridges. Ids come from the wire,
  so two screens write the same tank. Parsers (`keepMode`) leave them for the landing,
  which says so (`planNotice`). Exam: `cell-wires.test.ts` (numbers recorded from the old
  hidden tank).
- Never auto-convert at a guessed 1000 L per cell: it hid a real machine, its empty cells
  and its power.
- `isFluidEquivalentToFilledCell` (name-tolerant) is shared by search and Pool's cell
  pairs. It converts nothing.
- `dropCrossFormConnections` compares KINDS only, never ids (slots legitimately carry ids
  the edge does not). It lets `crossForm` wires through for the conversion.

## Ore dictionary and concrete items

- Concrete items carry their oredict membership. Uses of a concrete item include exact
  recipes, compatible oredict recipes and alternatives that contain it.
- A recipe picked from a concrete item keeps that concrete item in its slots through
  creation, refresh and reload (Spruce Log never silently becomes Oak Log). Handles and
  matching use the effective rendered resource, overrides included.
- Unresolved oredict slots cycle their ART only; names stay "Any ...", and rates, wire
  colours, handles and solver identity stay fixed. Never store animation frames or invent a
  concrete source for an icon (`category-presentation.ts`).
- A pick from "what makes X" never puts X in a slot of that recipe (`switchesSlotToOwnProduct`
  in `buildRecipeInputOverrides`). The funnel never drops a saved pick or its wire: it has no
  dataset, and a recipe that takes its own product can be a real loop (a Thaumcraft Crucible
  turns any iron nugget into three).
- A pick the stored body offered in a slot and the refreshed body does not is REVOKED
  (`revoked-substitutes.ts`, found by `refreshProjectRecipes`, which stays quiet and changes
  nothing). `settleRevokedSubstitutes` then moves a card onto its one same-map twin that takes
  the pick in that slot (`swapMachineRecipe`: wires kept, one undo step, sent to a live room as
  an edit, which every client makes the same way, so the plan never differs between them) and
  leaves any other card as it is; the plan notice names each card. A move keeps the card's picks
  on slots the twin shares and selects nothing. Until the lookup answers, a card holding a revoked
  pick keeps its stored body and node (the only evidence); a failed lookup or a plan no longer on the
  board forgets the check (`forgetRecipeChecks`), so the next landing finds it again. A plan file
  import keeps the file's body for such a recipe for the same reason. A migrated id cannot wait and is
  settled from that one refresh.

## Shared machines (shared-machine.ts)

- One card can run several recipes on one machine. Section 0 is `recipeId`; sections
  1..n are `FactoryNode.extraRecipes`. Count, tier, power and knobs are shared; slots,
  wires and oredict picks are per section.
- Addressing: section handles wear an `r<n>:` prefix (`sectionHandleId` /
  `splitSectionHandleId`); a section's solve node is `card#r<n>` (`sectionNodeId`).
  Anything resolving "the recipe at this handle" reads the section (`sectionNodeView`),
  never `node.recipeId` alone.
- `removeRecipeSection` (a factory-store action) drops the section's wires and renumbers
  later ones; removing section 0 promotes the next. A card that owns its recipe never
  shares (`ownsItsRecipe`: generators, crop farms, custom rate, fluid tanks, the EEC).
  Exam: `shared-machine.test.ts`.

## Boards and lists

- `board-windows.ts` (`computeBoardLevelView`) decides what the canvas shows: the root plus
  every open board, recursively. `board-paper.ts` picks papers (`pickBoardPaper`,
  `paperForBoardId`). `flattenBoards` surfaces members where their frames stood.
- `machine-list.ts` (`buildMachineList`): one row per card. Build counts the card's
  `machineCount`; Solve / Pool sum its sections' required machines, fractions kept.
  Order: tier, then EU/t biggest first on `rate-order.ts`'s key (rounded to 9 significant
  digits, so float noise never swaps two cards), then name, then card order.
- `rate-order.ts` (`sortByRate`, `compareByRate`, `rateOrderKey`): the order of every list of
  rates the plan-mode board shows (overview, group summary card, machine list, boundary
  lists, plan stats). Biggest first on the rate rounded to 9 significant digits (a sort key,
  so the sort stays transitive), ties by the name the list prints A to Z, then key. The file
  names the two rare edges no fixed key avoids.

## Game version (game-version.ts)

- `FactoryProject.gameVersion` is the plan's version family ("2.9", "2.8.1"), set when the
  plan is made and never edited. Read it through `planGameVersion`: absent or blank is 2.9,
  and nothing writes the field into an old plan on load. Any other string is kept as
  written. `gameVersionOfDataset` maps a dataset's `gtnhVersion` to its family.
- Live editing leaves it out (`live-shape.ts` `DROPPED_FIELDS`): it is never a meta op, and
  the live service refuses a batch that sets or deletes it (`validate.ts` `NEVER_LIVE_FIELDS`).
- New plans are stamped by the caller: `createNewProject(v)`, `addDesign({ gameVersion })`,
  `addTaskBoard({ gameVersion })`; with no version none is written. `DesignSummary.gameVersion`
  is copied off the plan (`toDesignSummary`, kept by `keepStoredPlanMarks`); a summary from the
  account listing alone has none until the plan is pulled.
- Exam: `game-version.test.ts`, the round trips in `factory-json.test.ts` and
  `plan-code.test.ts`, `live-shape.test.ts`, the library PUT's `route.test.ts`, and the
  stored paths: `design-library.test.ts`, `design-store.test.ts`, `library-sync.test.ts`,
  `project-normalize.test.ts`, `validate.test.ts`, `room.test.ts`, `live-session.test.ts`.

## The load funnel (project-normalize.ts)

`normalizeLoadedProject` snaps positions to the grid and migrates legacy shapes (trash
cans to trash drawers, stored setup rules dropped, unratioed cross-form wires and overrides
dropped, loose cell wires to tank cards, stored recipe bodies on multi-amp maps restamped at the amp tier as the
pipeline stamps it: `amp-map-stamp.ts`, for a card the landing refresh does not re-find). Unknown keys
are stripped by the Zod schema on import, paste and server paths, not here; IndexedDB
loads are not schema-parsed. Old plans must keep opening: add a migration rather than
breaking a schema.

## Icon paths (icon-path.ts)

- A stored icon (`iconPath`, `iconAtlas.imagePath`, `nei.iconPath`, `nei.backgroundImage`, a plan's or
  a post's `icon`) may point only at the site's own art: `/datasets/gtnh/<any version>/...` or `/nei/...`,
  an image extension, no query, quote, space, `\` or dot segment, at most 500 characters
  (`isSiteIconPath`). A plan's icons are `<img src>` and `url(...)` in every viewer's browser, so an
  outside address would make every viewer fetch it. Every icon field is `siteIconPathSchema` /
  `siteIconAtlasSchema`, which DROP anything else rather than refuse (an icon must never sink a plan
  load); the landing refresh restamps dataset icons. `ResourceIcon` applies the same rule to what it
  draws: a dataset-served recipe never passes the schema, and a dataset built before
  `resolve-icon-hints.mjs` still carries the export's `asset:<mod>:textures/...` hints (21 Thaumcraft
  aspects other mods add, drawn as `?`). The pipeline now copies each hinted PNG out of the mod jars into
  `textures/rendered/` and clears the rest, whatever the dataset's size, and the publish refuses a version
  that still holds `"asset:` (`tools/dataset-pipeline/CLAUDE.md`, Icon hints). A test fixture that
  renders an icon needs a site-shaped path (`/nei/test/x.png`). Exam: `icon-path.test.ts`,
  `factory-json.test.ts` "drops icons that are not the site's own art", `src/lib/live/validate.test.ts`,
  `src/components/nei/ResourceIcon.test.tsx`.

## Cloud plan additions (schemas.ts)

- `gtnhplanner` on the project, nodes, storages, edges and annotations is the in-game
  planner's own data: opaque here, kept exactly as written through every edit, at most
  64 KB a thing. Never strip it or rebuild these things field by field.
- `primaryView` ("plan" or "tasks") and the task board: `tasks`, `taskItems` (checklist
  lines, their own things so two people can tick two at once) and `taskComments`, bounded
  by `PLAN_TASK_LIMITS`. Live editing treats each as a collection (`src/lib/live/ops.ts`).
- Exam: `plan-additions.test.ts` (schema, export and import, plan links) and the library
  PUT's `route.test.ts`.
