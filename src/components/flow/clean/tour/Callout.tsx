import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { getUiScale } from "@/lib/ui-scale";
import { getTourCursor } from "./tour-controller";
import type { Aim, NoteSpec } from "./director";
import { mouseGlyphSvg } from "./cursor";
import { parseLines, type Line, type Span } from "./markup";
import { placeNote, type Rect } from "./placement";
import { rectOf } from "./targets";
import { getBoardBridge } from "./TourBridge";

/**
 * The note (the mod's Callout): a dark box with a gold edge beside the thing it is about, a tip pointing at it,
 * the thing framed in gold (bare when it should show as it is). Words between asterisks are gold. Keys: x (leave)
 * on the left, back and next on the right; next turns gold when the step is done, a tick on the last step.
 * It sits where it covers least, below the thing if there is room, else above, right or left, and off the cursor.
 * A note whose target never shows says its piece in the middle after a moment rather than leave the tour waiting.
 */

const GLYPH: Record<string, "middle" | "wheel" | "left" | "right"> = { M: "middle", W: "wheel", L: "left", R: "right" };

/** A small key cap, for the lines about keys. */
const KEY_GLYPH =
  "<svg width='16' height='16' viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'><rect x='1.5' y='2.5' width='13' height='11' fill='#26282d' stroke='#e8e9ee'/><path d='M4 6h2M7 6h2M10 6h2M4 9h8' stroke='#ffd257' fill='none'/></svg>";

function Words({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <span key={i} data-ink={s.ink === "plain" ? undefined : s.ink}>
          {s.text}
        </span>
      ))}
    </>
  );
}

/** What an aim points at right now, as a rect. */
function aimRect(aim: Aim | undefined): Rect | null {
  if (!aim) return null;
  const got = aim();
  if (got instanceof Element) return rectOf(got);
  if (got) return { x: got.x - 12, y: got.y - 12, w: 24, h: 24 };
  return null;
}

export function Callout({
  note,
  last,
  done,
  onNext,
  onBack,
  onLeave,
  canBack,
}: {
  note: NoteSpec;
  last: boolean;
  done: boolean;
  canBack: boolean;
  onNext: () => void;
  onBack: () => void;
  onLeave: () => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const lines: Line[] = useMemo(() => parseLines(note.text), [note.text]);
  const withGlyphs = lines.some((l) => l.glyph);

  // Placed every frame from where the thing is now (cards move, the board pans); written straight to the DOM.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const frame = frameRef.current;
    if (!box) return;
    let raf = 0;
    const t0 = performance.now();
    let last = "";
    let avoidAt = -1000;
    let cards: Rect[] = [];
    const loop = () => {
      // The note wears the interface zoom as the menus do: measured in real pixels, placed in its own (zoomed) ones.
      const zoom = getUiScale();
      const box0 = box.getBoundingClientRect();
      const size = { w: box0.width, h: box0.height };
      const viewport = { w: window.innerWidth, h: window.innerHeight };
      let rect = note.nothing ? null : aimRect(note.at);
      // The thing never showed: say it in the middle after a moment.
      const giveUp = rect === null && performance.now() - t0 > 1400;
      if (rect === null && !giveUp && !note.nothing && note.at) {
        box.style.visibility = "hidden";
        raf = requestAnimationFrame(loop);
        return;
      }
      if (note.nothing || giveUp) rect = null;
      const cursor = getTourCursor();
      // Cards, drawers and notes on the board (looked at a few times a second, not every frame).
      const now = performance.now();
      if (now - avoidAt > 250) {
        avoidAt = now;
        cards = [];
        // Open menus too: a step may leave one open, and the note must not sit under it.
        for (const el of document.querySelectorAll(".react-flow__node, [role=\"menu\"]")) {
          const r = rectOf(el);
          if (r.w > 0 && r.h > 0) cards.push(r);
        }
      }
      const avoid: Rect[] = [...cards];
      if (cursor && cursor.x > 0) avoid.push({ x: cursor.x - 6, y: cursor.y - 6, w: 36, h: 40 });
      // Not over the top bar or the board's own corner keys.
      let place = placeNote({ target: rect, size, viewport, avoid, inset: { top: 40, bottom: 8, left: 0, right: 0 } });
      // A note about nothing in particular sits at the top of the board, across its middle (the mod's noteAt).
      const pane = note.nothing ? getBoardBridge()?.paneRect() : null;
      if (pane) {
        place = { x: Math.max(10, pane.left + (pane.width - size.w) / 2), y: pane.top + pane.height * 0.1, side: "centre", tip: 0 };
      }
      const key = `${Math.round(place.x)},${Math.round(place.y)},${place.side},${Math.round(place.tip)}`;
      if (key !== last) {
        last = key;
        box.style.transform = `translate(${Math.round(place.x / zoom)}px, ${Math.round(place.y / zoom)}px)`;
        box.dataset.side = place.side;
        box.style.setProperty("--tip", `${Math.round(place.tip / zoom)}px`);
      }
      box.style.visibility = "visible";
      if (frame) {
        if (rect && !note.bare && !note.nothing && !giveUp) {
          frame.style.display = "block";
          frame.style.transform = `translate(${Math.round(rect.x - 3)}px, ${Math.round(rect.y - 3)}px)`;
          frame.style.width = `${Math.round(rect.w + 6)}px`;
          frame.style.height = `${Math.round(rect.h + 6)}px`;
        } else frame.style.display = "none";
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [note]);

  useEffect(() => {
    boxRef.current?.focus({ preventScroll: true });
  }, [note]);

  return (
    <>
      <div ref={frameRef} className="tour-frame" data-tour="frame" />
      <div ref={boxRef} className="tour-note ui-zoom" data-tour="note" data-nothing={note.nothing ? "" : undefined} key={note.text} role="note">
        <div className="tour-note-tip" />
        <div className="tour-note-body" data-glyphs={withGlyphs ? "" : undefined}>
          {lines.map((line, i) => (
            <div key={i} className="tour-line" data-lit={note.lit === i ? "" : undefined}>
              {withGlyphs ? (
                <span
                  className="tour-glyph"
                  dangerouslySetInnerHTML={{ __html: line.glyph ? (line.glyph === "K" ? KEY_GLYPH : mouseGlyphSvg(GLYPH[line.glyph]!)) : "" }}
                />
              ) : null}
              <span className="tour-words">
                <Words spans={line.spans} />
              </span>
            </div>
          ))}
        </div>
        <div className="tour-keys">
          <div role="button" aria-label="Leave the tour" title="Leave the tour (Esc)" className="tour-key tour-key-x" onClick={onLeave} />
          <span className="tour-keys-gap" />
          <div
            role="button"
            aria-label="Back"
            title="Back (left arrow)"
            className="tour-key tour-key-back"
            data-off={canBack ? undefined : ""}
            onClick={canBack ? onBack : undefined}
          />
          <div
            role="button"
            aria-label={last ? "Finish" : "Next"}
            title={last ? "Finish (Enter)" : "Next (right arrow, Space or Enter)"}
            className="tour-key tour-key-next"
            data-done={done ? "" : undefined}
            data-last={last ? "" : undefined}
            onClick={onNext}
          />
        </div>
      </div>
    </>
  );
}
