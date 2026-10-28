import "./mod-panel.css";

import { useCallback, useState } from "react";
import { ChromeMenu, chromeAnchorOf, MENU_ANCHOR_ATTR, type ChromeAnchor } from "./ChromeMenu";

/**
 * A choice among a few, the mod's way: a flat key naming the choice that opens the compact list menu (the mod's
 * PickList) under it. Replaces a native select, whose popup nothing in the page's style can reach.
 */
export function ModPick<T extends string>({
  value,
  options,
  onChange,
  label,
  title,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  /** The accessible name of the key. */
  label: string;
  title?: string;
}) {
  const [anchor, setAnchor] = useState<ChromeAnchor>();
  const close = useCallback(() => setAnchor(undefined), []);
  const current = options.find((option) => option.value === value);
  return (
    <>
      <button
        type="button"
        className="pn-pick-key"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== undefined}
        title={title}
        data-open={anchor ? "" : undefined}
        {...{ [MENU_ANCHOR_ATTR]: "" }}
        onClick={(event) => {
          const next = chromeAnchorOf(event.currentTarget);
          setAnchor((open) => (open ? undefined : next));
        }}
      >
        <span>{current?.label ?? value}</span>
        <span className="pn-pick-arrow" aria-hidden />
      </button>
      {anchor ? (
        <ChromeMenu
          anchor={anchor}
          label={label}
          zIndex={80}
          minWidth={Math.max(120, (anchor.right ?? anchor.left) - anchor.left)}
          entries={options.map((option) => ({
            label: option.label,
            current: option.value === value,
            onSelect: () => onChange(option.value),
          }))}
          onClose={close}
        />
      ) : null}
    </>
  );
}
