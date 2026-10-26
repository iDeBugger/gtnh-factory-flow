# Sticky notes (src/components/flow/clean/note)

The mod's sticky note (`ui/note/NoteCard`) on the board. A note is the website's
text annotation (`kind: "text"`, `colorTag`, `fontSize`), so import, export and posts are unchanged.

- `AnnotationSwitch` is what FactoryFlow registers as `annotationNode`: a text annotation is `StickyNote`, a box,
  zone or arrow `CleanDrawing`, a picture nothing.
- `visibleAnnotations` (used where FactoryFlow builds its nodes): the board drops picture annotations (kept in the data
  untouched). The board has no pencil menu or image key; a file dropped on it opens as a plan.
- `note-model.ts` is pure and tested: the mod's colours (`notePalette`, from `GT_NODE_COLORS` swatches), parts under the
  pointer, key rects (fixed screen size via `--board-zoom`), wrapping, `neededHeight`. Chrome sizes are the mod's, one to one
  (the board places and sizes everything as the mod does).
- Pointer: React Flow carries the note; a press let go within 3 px is a click (writes, or a key). The resize zone (right and
  bottom edges, folded corner) toggles `nodrag nopan` so a press there resizes instead; set on pointerdown too, as the
  mouse press follows it. Written on, the textarea keeps the keyboard through a press that drags.
- DOM: the note, its text (or textarea) and three keys. Paper, band, fold, grip and the selection outline are pseudo-elements
  and a `filter: drop-shadow`; state is on data attributes (`data-editing`, `data-multi`, `data-part`).
- Face and words are the mod's: Monocraft (`--cc-font`, measured with `measureClean`), "Double-click to write" on an empty
  note, tips as `NoteCard.tip`; a new note is 180 by 120, the mod's.
- Selection outline only when several nodes are selected. Stacked over wires, under cards (`STICKY_NOTE_Z_INDEX`).

## Drawn annotations (box, zone, arrow)

Designed once for both planners: `docs/annotations.md` (the mod has the same file). `AnnotationSwitch` sends them to
`CleanDrawing`: flat, square, 2 px line, sizes the mod's one to one (`drawing-look.ts`, tested). Made and edited from the board's right-click menu (`BoardContextMenu`: Add sticky note, Add box, Add arrow;
right-click a drawing for `AnnotationMenu`: Colour, Fill, Border, Marks, or Thickness, Heads, Delete). A box moves by
its border strips and resizes by React Flow's corner handles and outer edge bands (`drawing.css`); an arrow moves by its
line and is reshaped by its two end handles (`CleanDrawing`'s `Arrow`, pointer capture, board space through
`screenToFlowPosition`, snapped to the grid, one undoable `updateAnnotation`; `arrowFromEnds` turns two ends into box and
direction). An arrow may have a 0 axis (store `snapAnnotationToGrid` by kind; the node stays 1 px so it is measured).
Handles: a box's corners while selected, an arrow's ends while selected or hovered; the outline only with several
selected (`data-multi`). Pictures (`kind: "image"`) are no longer supported: `visibleAnnotations` drops them on a plan
board and `AnnotationSwitch` renders nothing; the data stays in the project. Zones are shown, not offered in Add.
