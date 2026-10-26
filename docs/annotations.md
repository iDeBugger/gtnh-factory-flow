# Board annotations (notes, boxes, arrows; zones shown only)

Written 2026-10-14 (AN1), reworked the same day (AN2). One file, copied verbatim into the website
(`docs/annotations.md`); change both together. Both planners show the annotations a library plan carries in one look,
make and edit them one way (the right-click menu), and a plan round-trips between them.

## What is supported

| Kind | Made from the board menu | Shown | Edited |
| --- | --- | --- | --- |
| `text` (sticky note) | yes: Add sticky note | yes | its own menu: write, colour, text size, delete |
| `box` | yes: Add box | yes | menu: colour, fill, border, marks, delete; drag, resize |
| `arrow` | yes: Add arrow | yes | menu: colour, thickness, heads, delete; drag, reshape |
| `zone` (polygon outline) | **no** | yes, as it came | colour, fill, border, marks, delete in the same menu; move; resize by its bottom right corner (the outline scales) |
| `image` | no | **no** | nothing: pictures are no longer supported |

**Pictures.** An image annotation is not drawn, not selectable, and nothing offers to add one in either planner. The
data is kept so a plan loses nothing on a round trip: the website leaves it in `project.annotations` untouched (the
board filters it out of the nodes it draws); the mod imports it as a `Note` of kind
`image` that has no widget, skips it in select-all and marquee, and writes it back on export (`PlanExport.note`). The
mod's picture download (`ImageCache`) and the picture panel are gone.

**Zones** are drawn as before (the box's look on the outline) but are not in the Add menu: there is no polygon tool
here, so a zone only arrives with an imported plan.

## The model (the website's `FactoryAnnotation`, plan JSON `annotations[]`)

| Field | Kinds | Meaning |
| --- | --- | --- |
| `id`, `kind` | all | `box`, `zone`, `arrow`, `text`, `image` |
| `position`, `size` | all | top-left and bounding box, board px (the website's and the mod's are one to one since 2026-10-15). An arrow's size may be 0 on one axis: a level arrow |
| `colorTag` | all | one of the 22 colour tags; absent = yellow |
| `text` | text, image | note body; an image's caption (kept, not shown) |
| `fontSize` | text | 8..96, 14 default |
| `arrowDirection` | arrow | `down-right` (default), `down-left`, `up-right`, `up-left`: tail to head across the bounding box. Dragging an end past the other flips it |
| `arrowHeads` | arrow | `end` (default, a head at the head end) or `both` |
| `arrowWidth` | arrow | the line's thickness in board px: 1 thin, 2 normal (default), 4 thick; 1..8 allowed |
| `points` | zone | closed outline, vertices relative to `position` (3 or more) |
| `imageUrl` | image | kept, unused |
| `style.border` | box, zone | `solid` (default), `dashed`, `none` (a plan can carry it; the menu offers solid and dashed) |
| `style.borderColor`, `style.fillColor` | box, zone | colour tags; absent = `colorTag`. The menu's Colour sets `colorTag` and lets these go |
| `style.fill` | box, zone | `tint` (default), `solid`, `none`; the legacy mark names (`dots`, `grid`, `graph`, `ruled`, `hatch`) mean tint wearing that mark, `paper` means solid. Choosing a fill from the menu keeps a legacy mark |
| `style.marks` | box, zone | `none`, `dots`, `grid`, `graph`, `ruled`, `hatch` |
| `style.fillTheme` | box, zone | a textured paper; not drawn, kept in the data (a menu colour pick drops it) |
| `pocketId` | all | the group (board) it lives in, its position measured from that group's frame (docs/design/groups.md) |

Nothing here takes part in the solve, the wiring or Arrange. The website keeps unknown fields; the mod keeps the ones
above. Old builds ignore `arrowHeads` and `arrowWidth` and draw a normal one-headed arrow.

## The look (the clean card's: flat, square, 1 px chrome, Monocraft)

Colours are the colour tag's swatch (`GT_NODE_COLORS` / `NoteColors.SWATCH`, same 22). Sizes are in board px, the
website's and the mod's one to one since the website's board draws the mod's card (2026-10-15; its `drawing-look.ts`
`DRAWING`).

- **Box**: a square rectangle. Border 2 px in the border colour (`dashed`: 8 on, 6 off), nothing rounded, no
  shadow. Surface: `tint` is the fill colour at 8% alpha (`0x14`), `solid` at 28% (`0x47`), flat; `none` is empty.
  Marks over the surface in the fill colour at 16..35%: dots (a pixel per 10 px cell), grid (1 px lines per cell),
  graph (grid plus a stronger line every 5 cells), ruled (a line every 2 cells), hatch (diagonals).
- **Zone**: the box's look on the outline `points` (square joins, flat fill, same border, surface and marks).
- **Arrow**: a line of `arrowWidth` px (2) in the colour from the tail corner to the head corner, ending in a flat
  filled head, at one end or both. The head is 14 long and 10 wide, bigger on a thick line (4 times the thickness
  long, 3 times wide, whichever is more).

Order, back to front: boxes and zones (under everything, the board's backdrop), drawers and cards, and arrows with
the notes (over the wires). A box and a zone are click-through inside: only the border takes the pointer; an arrow
only its line and its ends.

## Making and editing (the same in both planners)

**Add**: right-click empty board: Add sticky note, Add box, Add arrow (then New product drawer). A box lands 200 by 140
(mod px; 240 by 160 on the website) and an arrow 160 long running level to the right, both blue, with their top left at
the click, selected. A sticky note starts being written on.

**Right-click** a box, zone or arrow (on its border or line; the website only on a plan board). A box or zone:
Colour..., Fill... (Tint, Solid, None), Border... (Solid, Dashed), Marks... (None, Dots, Grid, Graph, Ruled, Hatch),
Delete. An arrow: Colour..., Thickness... (Thin, Normal, Thick), Heads... (One end, Both ends), Delete. Each "..." row
opens a short list with the current choice ticked; a pick is one undoable step. A sticky note keeps its own menu.

**Direct**, as notes do (a press let go within 3 GUI px is a click and selects; moved further it acts):

- *Box*: drag its border (the line and a band inside it) to move it; drag a corner, or just outside an edge, to resize
  it from that side (to the 10 px grid, never under two cells; the far side stays). A zone moves by its outline and
  resizes by its bottom right corner.
- *Arrow*: drag its line to move it; drag either end handle to reshape it (the end lands on the grid, the other stays,
  and dragging past it flips the direction; the ends may line up but never meet). The handles show while it is
  selected or the pointer is on it.
- Selecting: a click (Shift adds), marquee, select all. Delete or Backspace removes the selection. Everything is in
  undo, copy and paste and saves with the plan. A selection outline shows only with two or more things selected; a
  single drawing shows its handles (corners, ends) instead.

## Plan JSON both ways

Import keeps every field above (mod `importer/FfPlanParser` to `FfConverter.placeNotes`); export writes them back
(`library/PlanExport.note`). Positions are board px one to one and sizes are snapped to whole 20 px cells (an arrow's
0 axis stays 0); zone points are as they are. Shared plans carry each drawing exactly, with the game's data on it
(docs/design/cloud-live.md, Game mapping). The mod saves them as a `kind` on its note
(`data/flowchart/Note`), so older saves are all text.

## Where it is (code)

Website: `src/components/flow/clean/note/` (`CleanDrawing` the shapes, handles and resize; `AnnotationMenu` the menu;
`drawing-look.ts` the look and the pure helpers `arrowFromEnds`, `boxStyleWith`; `note-actions.ts` Add box and Add
arrow), `BoardContextMenu.tsx` (the board menu), the store's `updateAnnotation` (an arrow keeps a 0 axis).
Mod: `ui/note/NoteCard` (menu, handles, drag), `DrawingGrips` (what is held where and what dragging does: pure,
tested), `DrawingPaint` (look and hit), `BoardCanvas.openBoardMenu`, `BoardSession.addDrawing`.
