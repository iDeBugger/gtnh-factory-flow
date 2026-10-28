import { useState } from "react";
import { wheelChangesValues } from "@/lib/device-settings";
import { MenuPortal, anchorOf, type MenuAnchor } from "../menus/MenuPortal";
import { OptionListMenu } from "../menus/OptionListMenu";

/**
 * The gear sheet of the cards whose settings are not a machine's controls (a generator's knobs, the custom rate's
 * dial). The same menu portal and the same rows as the machine settings sheet (`menus/SettingsSheet`): a Settings
 * column, each setting a row with its pin, name and well, and beside it the readings the card keeps (a generator's
 * efficiency, its flow, its lifespans).
 */
export interface SheetRow {
  id: string;
  label: string;
  value: string;
  /** A select's options and the one in use: the well opens their list. */
  options?: Array<{ key: string; label: string }>;
  currentKey?: string;
  /** A number: the well is typed into. */
  number?: { text: string; commit: (text: string) => void };
  /** A switch: the well flips it. */
  flip?: () => void;
  /** Switched off by another setting: greyed, nothing happens. */
  enabled: boolean;
  /** Offered a pin (shown on the card as a chip). */
  pinned?: boolean;
  onPin?: () => void;
  onPick?: (key: string) => void;
  onStep: (direction: -1 | 1) => void;
}

/** A pushpin, 7 wide and 10 tall (the settings sheet's own). */
function PinGlyph() {
  return (
    <svg width="9" height="13" viewBox="0 0 7 10" shapeRendering="crispEdges" aria-hidden>
      <path d="M1 0h5v1H1zM2 1h3v2H2zM1 3h5v1H1zM0 4h7v1H0zM3 5h1v4H3z" />
    </svg>
  );
}

export function SpecialSheet({
  anchor,
  rows,
  readings,
  locked,
  foot,
  onClose,
}: {
  anchor: MenuAnchor;
  rows: SheetRow[];
  readings: Array<{ label: string; value: string }>;
  locked: boolean;
  foot?: string;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<{ id: string; anchor: MenuAnchor }>();
  const [draft, setDraft] = useState<{ id: string; text: string }>();
  const none = rows.length === 0;
  const wide = readings.length > 0;
  const openRow = open ? rows.find((row) => row.id === open.id) : undefined;
  const commit = () => {
    if (!draft) return;
    const row = rows.find((entry) => entry.id === draft.id);
    setDraft(undefined);
    row?.number?.commit(draft.text);
  };
  return (
    <>
      <MenuPortal
        anchor={anchor}
        width={wide ? (none ? 533 : 711) : 330}
        maxHeight={660}
        label="Settings"
        onClose={onClose}
        keepOpenOn="[data-cc-sheet]"
      >
        <div
          className="cs-body"
          data-cc-sheet=""
          style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          <div style={{ display: "flex", alignItems: "stretch", minHeight: 0, overflowY: "auto" }}>
            <div
              className="cs-col"
              style={{ flex: wide ? "0 0 auto" : "1 1 auto", minWidth: wide ? 250 : 0 }}
            >
              <div className="cs-title">Settings</div>
              {none ? <div className="cs-none">No settings for this card.</div> : null}
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="cs-row"
                  style={row.enabled ? undefined : { opacity: 0.45 }}
                  onWheel={(event) => {
                    if (!locked && row.enabled && wheelChangesValues()) {
                      row.onStep(event.deltaY < 0 ? 1 : -1);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!locked && row.enabled) row.onStep(-1);
                  }}
                >
                  {row.onPin ? (
                    <button
                      type="button"
                      className="cs-pin"
                      data-on={row.pinned ? "" : undefined}
                      aria-pressed={row.pinned === true}
                      aria-label={
                        row.pinned
                          ? `Unpin ${row.label} from the card`
                          : `Pin ${row.label} to the card`
                      }
                      onClick={() => {
                        if (!locked) row.onPin?.();
                      }}
                    >
                      <PinGlyph />
                    </button>
                  ) : (
                    <span className="cs-pin" style={{ visibility: "hidden" }} />
                  )}
                  <span className="cs-label">{row.label}</span>
                  <div
                    role="button"
                    tabIndex={0}
                    className="cs-well"
                    onClick={(event) => {
                      if (locked || !row.enabled) return;
                      if (row.number) setDraft({ id: row.id, text: row.number.text });
                      else if (row.options && row.options.length > 2)
                        setOpen({ id: row.id, anchor: anchorOf(event.currentTarget) });
                      else if (row.flip) row.flip();
                      else row.onStep(1);
                    }}
                  >
                    {draft?.id === row.id ? (
                      <input
                        autoFocus
                        className="nodrag"
                        value={draft.text}
                        inputMode="decimal"
                        aria-label={row.label}
                        style={{
                          width: "100%",
                          background: "transparent",
                          border: 0,
                          outline: 0,
                          color: "inherit",
                          font: "inherit",
                        }}
                        onChange={(event) => setDraft({ id: row.id, text: event.target.value })}
                        onBlur={commit}
                        onFocus={(event) => event.currentTarget.select()}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") setDraft(undefined);
                          event.stopPropagation();
                        }}
                      />
                    ) : (
                      <span className="cs-value">{row.value}</span>
                    )}
                    <span className="cs-chev" />
                  </div>
                </div>
              ))}
            </div>
            {wide ? (
              <div className="cs-col" style={{ flex: "1 1 auto" }}>
                <div className="cs-title">Working</div>
                {readings.map((reading) => (
                  <div key={reading.label} className="cs-f">
                    <span className="cs-f-label">{reading.label}</span>
                    <span className="cs-f-math" />
                    <span className="cs-f-result">{reading.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {none || !foot ? null : <div className="cs-foot">{foot}</div>}
        </div>
      </MenuPortal>
      {open && openRow?.options ? (
        <OptionListMenu
          anchor={open.anchor}
          control={{
            id: openRow.id,
            group: "Card",
            label: openRow.label,
            value: openRow.value,
            warn: false,
            options: openRow.options,
            currentKey: openRow.currentKey ?? "",
            pinDefault: false,
          }}
          onPick={(key) => {
            openRow.onPick?.(key);
            setOpen(undefined);
          }}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </>
  );
}
