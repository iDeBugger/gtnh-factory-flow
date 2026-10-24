"use client";

import { useMemo, useRef, useState } from "react";
import { wheelChangesValues } from "@/lib/device-settings";
import type { FormulaLine, FormulaTerm } from "@/lib/machines/formula-lines";
import { useFactoryStore } from "@/store/factory-store";
import { ArtBox } from "./ArtBox";
import { MenuPortal, anchorOf, type MenuAnchor } from "./MenuPortal";
import { OptionListMenu } from "./OptionListMenu";
import {
  isPinned,
  pinMachineKey,
  settingControls,
  settingPatch,
  steppedOption,
  toggledPins,
  type SettingControl,
} from "./settings-model";
import { workingLines } from "./working-lines";
import { planGameVersion } from "@/lib/model/game-version";

/** Each setting's number in a colour of its own, as on the mod's sheet. */
const KNOB_COLORS: Record<string, string> = {
  tier: "#5aa7d9",
  amps: "#5aa7d9",
  coil: "#e0904a",
  tgsLogTool: "#c9a24a",
  tgsSaplingTool: "#6fbf50",
  tgsLeavesTool: "#3fb08a",
  tgsFruitTool: "#e06060",
  tgsHeight: "#b06fd9",
  tgsSaplings: "#b06fd9",
  tgsYield: "#b06fd9",
  bioVatFill: "#5aa7d9",
  bioVatOutputHatch: "#c9a24a",
  bioVatGlass: "#9fd3e6",
  bioVatRadio: "#7fd94a",
  bioVatShutter: "#e0a060",
};

const NONE = "No settings for this machine.";

/** The game's font has no floor brackets or minus sign: written out, as the mod does. */
const glyphs = (text: string) => text.replace(/−/g, "-").replace(/⌊/g, "floor(").replace(/⌋/g, ")").replace(/⌈/g, "ceil(").replace(/⌉/g, ")");

function Term({ term }: { term: FormulaTerm }) {
  if (typeof term === "string") return <>{glyphs(term)}</>;
  if ("sup" in term) return <sup style={term.knob ? { color: KNOB_COLORS[term.knob] } : undefined}>{term.sup}</sup>;
  return <span style={{ color: KNOB_COLORS[term.knob] }}>{term.text}</span>;
}

function FormulaRows({ lines }: { lines: FormulaLine[] }) {
  return (
    <>
      <div className="cs-title">Formulas</div>
      {lines.map((entry, index) => (
        <div key={`${index}:${entry.label}`} className="cs-f">
          <span className="cs-f-label">{entry.label}</span>
          <span className="cs-f-math">
            {entry.math.map((term, i) => (
              <Term key={i} term={term} />
            ))}
          </span>
          <span className="cs-f-result" data-tone={entry.tone}>
            {entry.math.length > 0 ? "= " : ""}
            {entry.result}
          </span>
        </div>
      ))}
    </>
  );
}

/** A pushpin, 7 wide and 10 tall. */
function PinGlyph() {
  return (
    <svg width="9" height="13" viewBox="0 0 7 10" shapeRendering="crispEdges" aria-hidden>
      <path d="M1 0h5v1H1zM2 1h3v2H2zM1 3h5v1H1zM0 4h7v1H0zM3 5h1v4H3z" />
    </svg>
  );
}

/**
 * A card's settings (its gear key), in the mod's look: a Settings column (each setting a row with a pin, its name and
 * its list) and beside it a Formulas column (the supply, overclocks, time, draw and recipes a second, worked out with
 * the card's own numbers), and a line on how it works. A machine with nothing to set says so beside its working.
 * Pinned settings show on the card as chips, on every card of the machine; the sheet stays open while settings change.
 */
export function SettingsSheet({ nodeId, anchor, onClose }: { nodeId: string; anchor: MenuAnchor; onClose: () => void }) {
  const project = useFactoryStore((state) => state.project);
  const locked = useFactoryStore((state) => state.isReadOnly || state.checklistMode);
  const updateNode = useFactoryStore((state) => state.updateNode);
  const setSettingPins = useFactoryStore((state) => state.setSettingPins);
  const node = project.nodes.find((entry) => entry.id === nodeId);
  const recipe = project.recipes.find((entry) => entry.id === node?.recipeId);
  const gameVersion = planGameVersion(project);
  const [open, setOpen] = useState<{ id: string; anchor: MenuAnchor }>();
  const sheetRef = useRef<HTMLDivElement>(null);
  const controls = useMemo(
    () => (node && recipe ? settingControls(recipe, node, gameVersion) : []),
    [recipe, node, gameVersion],
  );
  const formulas = useMemo(
    () => (node && recipe ? workingLines(recipe, node, gameVersion) : []),
    [recipe, node, gameVersion],
  );
  if (!node || !recipe) return null;
  const machine = pinMachineKey(recipe, node);

  const choose = (control: SettingControl, optionKey: string) => {
    if (locked || optionKey === control.currentKey) return;
    updateNode(node.id, settingPatch(recipe, node, control.id, optionKey));
  };
  const step = (control: SettingControl, direction: -1 | 1) => {
    const next = steppedOption(control, direction);
    if (next) choose(control, next.key);
  };
  const openControl = open ? controls.find((entry) => entry.id === open.id) : undefined;
  const none = controls.length === 0;
  const wide = formulas.length > 0;

  return (
    <>
      <MenuPortal anchor={anchor} width={wide ? (none ? 597 : 813) : 330} maxHeight={660} label="Machine settings" onClose={onClose} keepOpenOn="[data-cc-sheet]">
        <div ref={sheetRef} className="cs-body" data-cc-sheet="" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "stretch", minHeight: 0, overflowY: "auto" }}>
            <div className="cs-col" style={{ flex: wide ? "0 0 auto" : "1 1 auto", minWidth: wide ? (none ? 220 : 250) : 0 }}>
              <div className="cs-title">Settings</div>
              {none ? <div className="cs-none">{NONE}</div> : null}
              {controls.map((control) => {
                const pinned = isPinned(project, machine, control);
                return (
                  <div
                    key={control.id}
                    className="cs-row"
                    data-warn={control.warn ? "" : undefined}
                    onWheel={(event) => {
                      if (!locked && wheelChangesValues()) {
                        step(control, event.deltaY < 0 ? 1 : -1);
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!locked) step(control, -1);
                    }}
                  >
                    <button
                      type="button"
                      className="cs-pin"
                      data-on={pinned ? "" : undefined}
                      aria-pressed={pinned}
                      aria-label={pinned ? `Unpin ${control.label} from the card` : `Pin ${control.label} to the card`}
                      onClick={() => {
                        if (!locked) setSettingPins(machine, toggledPins(project, machine, controls, control.id));
                      }}
                    >
                      <PinGlyph />
                    </button>
                    <span className="cs-label">{control.label}</span>
                    <div
                      role="button"
                      tabIndex={0}
                      className="cs-well"
                      onClick={(event) => {
                        if (!locked) setOpen({ id: control.id, anchor: anchorOf(event.currentTarget) });
                      }}
                    >
                      {control.icon ? <ArtBox src={control.icon} size={16} /> : null}
                      <span className="cs-value">{control.value}</span>
                      <span className="cs-chev" />
                    </div>
                  </div>
                );
              })}
            </div>
            {wide ? (
              <div className="cs-col" style={{ flex: "1 1 auto" }}>
                <FormulaRows lines={formulas} />
              </div>
            ) : null}
          </div>
          {none ? null : (
            <div className="cs-foot">
              Pinned settings show on the card. Click, right-click or scroll to change.
            </div>
          )}
        </div>
      </MenuPortal>
      {open && openControl ? (
        <OptionListMenu
          anchor={open.anchor}
          control={openControl}
          onPick={(key) => {
            choose(openControl, key);
            setOpen(undefined);
          }}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </>
  );
}
