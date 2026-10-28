import { useEffect, useRef } from "react";
import {
  MINIMAP_CORNER_LABELS,
  MINIMAP_SIZE_LABELS,
  setMinimap,
  useMinimapSettings,
  type MinimapCorner,
  type MinimapShape,
  type MinimapSize,
} from "./minimap-settings";
import "./minimap.css";

const SIZES: MinimapSize[] = ["small", "medium", "large", "huge"];
const SHAPES: MinimapShape[] = ["circle", "square"];
const CORNERS: MinimapCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/**
 * The minimap's settings, row by row, as the mod's Minimap section: Show, Size, Shape, Position, Centre on the card
 * you select. Used by the map's own gear and by the settings dialog.
 */
export function MinimapSettingsRows({ className = "" }: { className?: string }) {
  const s = useMinimapSettings();
  return (
    <div className={`mmap-rows ${className}`} role="group" aria-label="Minimap settings">
      <div className="mmap-row">
        <span className="mmap-row-name">
          Show the minimap <kbd className="mmap-kbd">N</kbd>
        </span>
        <div
          role="switch"
          aria-checked={s.show}
          tabIndex={0}
          className="mmap-switch"
          data-on={s.show ? "" : undefined}
          onClick={() => setMinimap({ show: !s.show })}
          onKeyDown={(e) => (e.key === " " || e.key === "Enter") && setMinimap({ show: !s.show })}
        />
      </div>
      <div className="mmap-row">
        <span className="mmap-row-name">Size</span>
        <div className="mmap-seg" role="radiogroup" aria-label="Size">
          {SIZES.map((size) => (
            <div
              key={size}
              role="radio"
              aria-checked={s.size === size}
              tabIndex={0}
              className="mmap-seg-item"
              data-on={s.size === size ? "" : undefined}
              onClick={() => setMinimap({ size })}
            >
              {MINIMAP_SIZE_LABELS[size]}
            </div>
          ))}
        </div>
      </div>
      <div className="mmap-row">
        <span className="mmap-row-name">Shape</span>
        <div className="mmap-seg" role="radiogroup" aria-label="Shape">
          {SHAPES.map((shape) => (
            <div
              key={shape}
              role="radio"
              aria-checked={s.shape === shape}
              tabIndex={0}
              className="mmap-seg-item"
              data-on={s.shape === shape ? "" : undefined}
              onClick={() => setMinimap({ shape })}
            >
              {shape === "circle" ? "Circle" : "Square"}
            </div>
          ))}
        </div>
      </div>
      <div className="mmap-row">
        <span className="mmap-row-name">Position</span>
        <span className="mmap-row-aside">{MINIMAP_CORNER_LABELS[s.corner]}</span>
        <div className="mmap-corners" role="radiogroup" aria-label="Position">
          {CORNERS.map((corner) => (
            <div
              key={corner}
              role="radio"
              aria-checked={s.corner === corner}
              aria-label={MINIMAP_CORNER_LABELS[corner]}
              tabIndex={0}
              className="mmap-corner"
              data-on={s.corner === corner ? "" : undefined}
              onClick={() => setMinimap({ corner })}
            />
          ))}
        </div>
      </div>
      <div className="mmap-row">
        <span className="mmap-row-name">Centre on the card you select</span>
        <div
          role="switch"
          aria-checked={s.follow}
          tabIndex={0}
          className="mmap-switch"
          data-on={s.follow ? "" : undefined}
          onClick={() => setMinimap({ follow: !s.follow })}
          onKeyDown={(e) => (e.key === " " || e.key === "Enter") && setMinimap({ follow: !s.follow })}
        />
      </div>
    </div>
  );
}

/** The map's gear popover: the rows in a small panel beside it, shut by Escape or a press away from it. */
export function MinimapSettingsPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".mmap-gear")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="mmap-panel nodrag nopan nowheel" role="dialog" aria-label="Minimap settings">
      <div className="mmap-panel-head">
        <span>Minimap</span>
        <div role="button" aria-label="Close" className="mmap-panel-x" onClick={onClose} />
      </div>
      <MinimapSettingsRows />
    </div>
  );
}
