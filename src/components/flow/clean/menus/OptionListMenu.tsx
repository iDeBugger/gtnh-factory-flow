import { useState } from "react";
import { ArtBox } from "./ArtBox";
import { MenuPortal, type MenuAnchor } from "./MenuPortal";
import type { SettingControl } from "./settings-model";

/**
 * A setting's list (the mod's strip-chip menu): a Filter box over the options, each with its own block or item beside
 * it, the one in use gold. Only the values that are valid are listed (a coil hot enough for the recipe). Enter takes
 * the first match, Escape closes.
 */
export function OptionListMenu({
  anchor,
  control,
  onPick,
  onClose,
}: {
  anchor: MenuAnchor;
  control: SettingControl;
  onPick: (optionKey: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = control.options.filter((option) => option.label.toLowerCase().includes(needle));
  return (
    <MenuPortal anchor={anchor} width={292} maxHeight={457} label={control.label} onClose={onClose}>
      <input
        autoFocus
        className="cm-filter nodrag"
        placeholder="Filter..."
        value={query}
        aria-label={`Filter ${control.label}`}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && shown[0]) onPick(shown[0].key);
          if (event.key === "Escape") onClose();
        }}
      />
      <div className="cm-scroll">
        {shown.length === 0 ? <div className="cm-empty">Nothing matches.</div> : null}
        {shown.map((option) => (
          <div
            key={option.key}
            role="menuitem"
            className="cm-row"
            data-current={option.key === control.currentKey ? "" : undefined}
            onClick={() => onPick(option.key)}
          >
            <ArtBox src={option.icon} size={18} />
            <span className="cm-name">{option.label}</span>
          </div>
        ))}
      </div>
    </MenuPortal>
  );
}
