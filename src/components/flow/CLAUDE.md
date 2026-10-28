# The board (src/components/flow)

`FactoryFlow.tsx` hosts the React Flow canvas. The cards, drawers, groups and notes are the clean ones (`clean/`,
its own notes); the node data types are in `board-node-types.ts`; `grid-edge-router.ts` is the wire router. Auto-arrange lives in
`src/lib/board-arrange*.ts`, the grid constants in `src/lib/board-grid.ts`.

## Performance invariants

The board must stay smooth with 100+ cards on weak PCs.

1. Routing is viewport-independent: routes depend only on flow-space geometry, never on
   zoom, pan or the DOM. React Flow culling is off, but DOM reads still leak viewport and
   mount state into routes.
2. Geometry is published, not measured ad hoc. `publishBoardGeometry` snapshots
   positions and sizes; it refreshes on a geometry fingerprint and explicitly on drop.
3. Caches key on content fingerprints, not object identity. Keep React Flow's `measured`
   sizes when rebuilding nodes, or every rebuild looks like a resize.
4. Identity is currency: node `data` through `reuseObjectIdentity`, edges through
   `reuseDeepObjectIdentity` (`layoutEpoch` is the deliberate bust), custom `memo`
   comparators on node components, stable callbacks for toolbar children.
5. Drags never show a guessed route. Small boards rerun the real solve on a throttle;
   past `LIVE_DRAG_ROUTE_EDGE_LIMIT` wires hold their routes until the drop.
6. An effect that touches every card at once (the hop map, `hop-map.ts`) paints CSS
   custom properties; it does not go through React.
7. No `querySelectorAll` / `getBoundingClientRect` per edge, node or frame. No card
   subscribes to per-frame values (raw zoom, pointer); derive a coarse level
   (`node-detail.ts`). A hover re-renders one wrapper.
8. Round every DOM-measured routing input; sub-pixel jitter breaks determinism.
9. The scroll camera: only the wrapper scrolls. React rewrites the board's className,
   so hang CSS on data attributes. Per-frame CSS variables go on the smallest element;
   under the shell zoom animate left/width, not transforms. The viewport wears
   `will-change: transform` only while the zoom moves (`zoomingMark`, `data-zooming`):
   worn at rest, Chrome draws a board zoomed out from its old, larger raster (soft text).
10. Profile with Playwright + CDP Profiler (CPU throttle 6-20x) on a cloned stress plan. If
   route scoring shows up during pan, zoom or hover, a cache is being invalidated.

## Grid and card sizes

- `BOARD_GRID = 20`. Positions, card sizes and port-row centres are whole cells; check
  with a Playwright measurement, not by eye. The grid is always on (no snap toggle).
- Recipe card: 19 cells wide, 40px port rows, machine picture between the rails
  (flex-1, 96px, at least 2 rows tall). The card frame is an inset shadow, not a border.
- Port chips: name 9px, two-line clamp (`.flow-port-name` does ONLY the clamp; size and
  weight are utilities on the element so a late stylesheet can't burst the chip). Smaller
  type buys width; reach for it before shrinking the picture.
- Content-height blocks use `GridBlock`: round up to the next cell, never compress.

## Cards and ports

- A wired port keeps its row at any rate (`buildRailPorts`): the row holds the handle its wire is drawn to, and a card
  the plan runs at almost nothing would otherwise drop it and leave the wire undrawn while the plan still runs it.
  Exam: `flow-explainers.test.ts`.
- The port ROW is the control: click = what makes it, right click = what uses it, R / U
  over the hovered row, long press = menu, drag = wire. The icon is `pointer-events-none`.
  `port-browse.ts` holds the hovered row imperatively; do not subscribe cards to it.
- Hover highlight (`flow-scope.ts`): a wire belongs to the recipe section its handle
  names; the walk passes through drawers and stops at the first machine.
- Every knob on a recipe card checks `checklistLocked()` at event time; drawer rate
  controls read `isReadOnly || checklistMode`. Wheel controls need `nowheel` or the
  camera takes the wheel; one that steps a value also wears `data-wheel-value` and returns
  early when `wheelChangesValues()` is false (Settings, "Scroll changes values"), so the
  camera takes the wheel from it then. A popup that scrolls keeps `nowheel` alone.
- A shared-machine card stacks its recipes on one pair of rails (`SharedMachineRails`),
  each under a one-cell rule: share % and verdict word on the left, move up/down and
  remove keys on the right, no name. The picture spans them all.
  The machine menu lists the intersection of the sections' handlers
  (`getSharedMachineHandlers`; model rules in `src/lib/model/CLAUDE.md`).

## Drawers (clean/drawer)

- A one-port machine card, 6x4 cells: a title bar (move grip, board menu, never starts a
  wire) and a port chip that answers exactly like a port row (`usePortRowBrowse`). Keep
  the two zones separate.
- The move grip is `.cd::before`, taller than the 7 px bar: the bar and 6 px of the row, edge to edge, over the row's
  wiring handle (z 30) and under the delete and side keys (z 41). It never reaches past the drawer: a drawer drawn
  after a card right above it would take that card's presses. The bar's tip rides `.cd` (zoomed out, the whole drawer
  shows it).
- Source and product drawers show a rule (Any / At least / Exactly / At most) and a rate (`useRateRule`,
  `setStorageRule`). A buffer has none: it passes what its users take, and the adapter sends it as Any whatever it
  stores (`docs/buffer-drawers.md`). Any is `targetMode: "ignore"` or no number.
- A buffer's spills (Up to makers making more than its users take, `plan.spills`) are the makers' forced rows; the
  buffer only totals them on a small Forced out tile left of its figure (`.cd-forced`; the drawer grows a cell wider
  by it, and routing and arrange read the measured size). Hovering any tile of a spill, or a maker's row, lights every tile of that
  spill and nothing else (`clean/interaction/spill-hover.ts`, a store of its own).
- The side key (`.cd-flip`, the delete key's twin at the top right, on hover) makes an input drawer an output one or
  the reverse (`flipStorageSide`): its wires come off and its rate goes, and its declared `poolSide` keeps it on the
  board unwired. Never on a buffer.
- Traps: drawer content is not clipped so lists can open past the edge; open lists carry `data-tooltip-stop`.
- Exams: `clean/drawer/drawer-model.test.ts`.

## Groups (containers)

- A group is a `FactoryPocket`: open (`expanded` + `size`, a frame) or collapsed (a summary card). There is no
  other container. The rules are `docs/groups.md` and `clean/group/`.
- A collapsed group is a summary, not a machine: no ports, nothing wires to it. Its figures come from the plan-wide
  solve (`computeGroupSummaries`). Do not build a per-group scoped solve. Arrange sizes it before it is measured
  (`pocketCardHeight`).
- Open groups: members are React Flow children with frame-relative positions. A card joins the group its centre is
  let go over, and the frame grows to hold it; a carried group keeps its parent. Held cards whose group is also held
  are passengers (`dragPassengersRef`), or they would move twice.
- Nothing solid overlaps: `board-placement.ts` runs live while dragging (blockers computed once at drag start).
- Floors paint in `BoardFloors` (one portal at z -4, `GroupFloor`); the frame sits between wires (10) and cards
  (20). `boardChromeOccluders` only cuts the frame out of the export capture.
- Every `NodeToolbar` goes through `CameraNodeToolbar` and wears `nopan`; the scroll
  camera otherwise applies the pan twice and a press starts a pan.

## Wires and routing (grid-edge-router.ts)

- One deterministic solve over every edge (`solveGridRoutes`), independent of zoom and
  render order: plan docks per card so siblings don't cross (`planDocks`), route the
  thickest then longest wires first, keep the board with the fewest points (`retainBest`,
  `routePoints`), then rip up and reroute crossing wires with escalating costs and dock
  swaps. Never add per-edge scoring or special-case paths.
- 8-direction A* on the 20px grid; nothing within one cell of a card except the port
  stub. Diagonals only for trips whose card rims are 6+ cells apart, at least two cells
  long. Self loops use 90-degree turns and land a cell from their exit. Turns and
  crossings are priced; reversals are all but forbidden.
- Docking is free on the whole perimeter (corners excepted). Docks sit on each side's first grid line at or
  outside the border, never the nearest (`cardRimDocks`, which Arrange's judge uses too), and `stubDepth` draws the wire on to the border: clean
  drawers and cards come in 10 px sizes and group members can sit half a cell off, and a dock inside the card
  loses the whole side or draws the wire from under it. Wire width follows flow
  (`laneWidthForHeat`) and wires sit under cards. No rate labels on wires. One drawn wire per material between two cards
  (`channelEdgeIdsByRepresentative`).
- Frames are routing obstacles but invisible to wire gestures. Wires inside a board pay to
  leave it (`costOutsideHome`); wires leaving pay per px spent inside (`costInsideExempt`).
- Every dial is in `router-tuning.ts` (`DEFAULT_ROUTER_TUNING`), editable per device in the
  dev menu. Arrange dials are left out of `routerTuningKey` so they never re-route.
- Past `ASYNC_ROUTE_EDGE_LIMIT` wires, routing runs in a worker (`grid-route-solve.ts`).
  A worker file must never import the module that spawns it. Vite builds that without a warning: the worker bundle
  carries the spawner and its imports, and its `new Worker(...)` becomes `new Worker(self.location.href)`, so the
  worker can start a copy of itself.
- Crossing hops (`wire-hops.ts`) are measured along the whole wire; arrows avoid hops.
- Count crossings with `measureWireRoutes` (`src/lib/route-metrics.ts`), which counts them
  at bends and run ends too. Tools: `router-replay.local.test.ts`,
  `node tools/audit-board.mjs <plan.json> <output-prefix> [--arrange] [--layout <file>]`
  (prints crossings, total length).

## Auto-arrange (src/lib/board-arrange*.ts)

- Three candidates (column pass, annealed challenger, free placement in
  `board-arrange-free.ts`), each judged by the real router on points (flow-weighted via
  `wireWeight`) plus stranger air; the best two are polished and the lower wins. The proxy
  scorer must price like the router and must never pin ports.
- The arrange dissolves every board first (`flattenBoards`) unless the "Keep boards on
  rearrange" browser setting is on. Islands emerge from `board-arrange-air.ts`
  (`islandAir`), not from cutting rules. Drawers are placed by pattern (a line beside
  their one machine, or between their two), not searched.
- Run the `free-explain` harness before tuning arrange weights. The free placement spots
  drawers by width, not role. Every router-judged search needs a time cap, not only a count.
- Cancel terminates the worker (`cancelArrange`). Keep the loader's `role=status`
  `aria-live=polite`; `tools/audit-board.mjs` waits on it.
- Harnesses in `src/lib/`: `arrange-capture`, `free-explain`, `versus`, `score-layout`,
  `proxy-score` (`*.local.test.ts`).

## Other board rules

- Other people in a live plan are `LivePresenceLayer.tsx`, mounted only with live plans: a ViewportPortal layer
  over the cards fed by `src/lib/live/live-presence.ts`, never by a board store, so a remote pointer never re-renders
  a card. Its outline selector costs one length check while nobody else has anything selected.
- Delete and Backspace take React Flow's selection only, never the store's `selectedNodeId` (never drawn), and do
  nothing while the recipe search, Library, Welcome, a task board, an open menu or a focused dialog covers the board
  (`isBoardCovered`); the search walks back on a bare Backspace. Escape lets go of the selection unless a popup took
  it (`defaultPrevented`). Exam: `board-delete-key.test.ts`.
- One right-click menu, `BoardContextMenu.tsx`. A control with its own right click calls
  `preventDefault`; board handlers skip prevented events.
- Calm mode and the glance view are session-only and never stored (`board-view.ts`): the image export borrows them
  for one capture, and the board has no switch for either.
- No `fitView` prop: it fires after the plan loads and overwrites the restored camera.
  The app frames the camera itself wherever it puts cards on the board. Each design's
  camera is stored per browser (`src/lib/designs/design-camera.ts`), never in the plan.
- Touch gestures are native capture-phase listeners (`board-touch-gestures.ts`). On compact
  screens a card drags only while selected.
- Checklist mode is presentation only; wires keep full routes in an invisible hit layer,
  and middle mouse and wheel still reach the camera.
- Animate values and routes through `board-motion.tsx`, never ad-hoc CSS transitions or
  node wrapper transforms.
- Card pictures: structure renders in `public/power-art` beat dataset icons, and can be
  edited in place (dataset icons are immutable).
- Sounds (`src/lib/sound/`, the mod's files and rules; its `CLAUDE.md` has the table): edits
  sound from the plan diff, the hand from page events; an action with its own sound claims
  the edit (`playEditSfx`); plan arrivals call `quietBoardSoundsFor`; judge "the plan
  changed" by `projectSoundFingerprint`, never object identity.

## Virtual cards (virtual/)

A plan of a thousand cards is a thousand React Flow wrappers but only the cards on or near the screen have
contents. Read `virtual/card-virtualizer.ts` first (pure, tested); budgets and numbers are in
`docs/design/backport/spec-performance.md` (10.4 and the WP7b section).

- Three phases a plain recipe card (`useVirtualPhase`): 2 its contents are mounted (the camera's rectangle grown
  by half a screen, the nearest 150, plus the selected, hovered, focused and everything while `data-cv-hold` is on
  the board for the export), 1 a `CardShell` (two elements: the frame and the glance face) on or near the screen,
  0 far and hidden (`data-vfar` on the wrapper, `display: none`; React Flow ignores a zero-sized measure and
  keeps the card's size and handles). Drawers and special cards keep their contents and are only hidden when far.
- The glance step shows shells only (the flip releases every card's contents at once). Nothing reads a card's
  inner DOM to route: routes come from the published boxes, so what is mounted never changes where a wire goes.
- A shell does not run the card's model (`useCardFace`: count, picture, red ring, a layout key). A card never
  drawn is drawn once in the background pass (a few a frame, nearest first, only while the camera rests) so React
  Flow gets its real size and handle boxes; it is marked drawn when React Flow holds its handles, and not
  released before. A layout change while a card is away (`useCardLayoutKey`) draws it again.
- Another plan on the board (`boardVirtualizer.useBoard(project.id)`) forgets every box, so the geometry publish keys
  on the plan id as well as the geometry fingerprint: a plan with the same cards in the same places (a converted
  copy, a file opened twice) would otherwise keep no boxes, and no wire would be picked to draw.
- A shown shell carries one empty marker per handle (`data-vstub`) at the last measured place: the measure a
  hidden wrapper provokes when it is shown again reads them back instead of wiping the handles.
- Wires: `board-edges.ts` hands React Flow only the wires whose box (the two cards, or the routed path once there
  is one) meets the camera grown by a third. The controller writes React Flow's store as the camera moves; the
  `edges` prop only changes with the plan, and the memo in FactoryFlow applies the current choice.
- `--board-zoom` is written on the board only at the glance step and on each sticky note directly (`zoom-var.ts`):
  an inherited property written per step restyles every element under it.
- The prompts (a count's "Set" box, "Set rate") blink off one clock: `data-cc-blink` on the root, flipped twice a second
  by `prompt-phase.ts` while a prompt is mounted, and their colour follows it in CSS. Never a CSS animation per
  prompt: one running animation keeps the page drawing and restyling every frame. The acceptance glow (a wire in
  hand) is still an animation, pinned to the shared phase by one `document.getAnimations()` a frame.
- While only the camera moves the board carries `data-camera-moving` (150 ms past the last step; never with a wire,
  card or marquee in hand) and its cards and wires take no pointer events; a pan captures the pointer on the pane
  as React Flow starts it. Both keep the browser from hit-testing everything on screen at every pointer event.
- React Flow's `ViewportPortal` and `EdgeLabelRenderer` query the DOM in a store selector on every store change; use
  `virtual/flow-portals.tsx` (FactoryFlow imports them under the same names).
- Wires and the overview rail follow an edit in a deferred render (`useDeferredValue` of the project and the solve):
  the click paints the cards first. Anything that needs wires and project in the same render reads `edgeProject`.
- `localStorage["gtnh-factory-flow.no-virtual"] = "1"` turns all of it off. `window.__gtnhVirtual` reads
  the counts (mounted, wires shown, pump cost, handle report) for the perf harness.
