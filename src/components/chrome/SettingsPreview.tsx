import type { CSSProperties } from "react";
import { MouseIcon } from "@/components/flow/clean/interaction/TipPanel";
import { useDeviceSettings } from "@/lib/device-settings";

/** The size choice's card scale in the picture (Tiny, Small, Normal, Large). */
const CARD_SCALE = [0.78, 0.9, 1, 1.14];

/**
 * The settings' pictures of what they change, beside the section's rows, drawn from the settings as they are now so a
 * switch shows its effect at once (the mod's SettingsPreview): Board shows two cards on a board over a little world,
 * names under the cards when zoomed out, the
 * cards bigger or smaller with Size; Sound shows a speaker at its loudness; Controls the mouse and what each button does.
 */
export function SettingsPreview({
  section,
  names,
  sizeIndex,
  soundIndex,
}: {
  section: string;
  names: boolean;
  sizeIndex: number;
  soundIndex: number;
}) {
  if (section === "Sound") return <SoundPicture level={soundIndex} />;
  if (section === "Controls") return <ControlsPicture />;
  return <BoardPicture names={names} scale={CARD_SCALE[sizeIndex < 0 ? 2 : sizeIndex]} />;
}

function BoardPicture({ names, scale }: { names: boolean; scale: number }) {
  const paper = { "--sp-scale": String(scale) } as CSSProperties;
  return (
    <div className="sp-board" style={paper} data-names={names ? "" : undefined}>
      <div className="sp-world" />
      <div className="sp-paper" />
      <div className="sp-rail">
        <i />
        <i />
        <i />
      </div>
      <svg className="sp-wire" viewBox="0 0 244 150" shapeRendering="crispEdges" aria-hidden>
        <path d="M104 58H128V98H146" fill="none" stroke="#22d3ee" strokeWidth="2" />
      </svg>
      <div className="spv-card" style={{ left: 54, top: 36 }}>
        <span className="sp-chip" />
        <span className="spv-pic" />
        <span className="sp-name">Electric Blast Furnace</span>
      </div>
      <div className="spv-card" style={{ left: 146, top: 80 }}>
        <span className="sp-chip" data-tier="ev" />
        <span className="spv-pic" data-tone="blue" />
        <span className="sp-name">Large Chemical Reactor</span>
      </div>
    </div>
  );
}

function SoundPicture({ level }: { level: number }) {
  const bars = [10, 18, 26];
  return (
    <div className="sp-sound" aria-hidden>
      <svg
        width="44"
        height="44"
        viewBox="0 0 11 11"
        shapeRendering="crispEdges"
        fill="currentColor"
      >
        <path d="M0 4h2l3-3v9l-3-3h-2z" />
      </svg>
      <div className="sp-bars">
        {bars.map((height, index) => (
          <i key={height} style={{ height }} data-lit={level > index ? "" : undefined} />
        ))}
      </div>
      {level === 0 ? <b className="sp-off" /> : null}
    </div>
  );
}

function ControlsPicture() {
  const { scrollChangesValues } = useDeviceSettings();
  return (
    <div className="sp-controls" aria-hidden>
      {(
        [
          ["left", "Select, drag, wire"],
          ["right", "Menus, go back a choice"],
          ["wheel", scrollChangesValues ? "Zoom; over a value, change it" : "Zoom"],
          ["middle", "Pan; over a rate, clear it"],
        ] as const
      ).map(([input, text]) => (
        <div key={input} className="sp-control">
          <span className="sp-mouse">
            <MouseIcon input={input} />
          </span>
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}
