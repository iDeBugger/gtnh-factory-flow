import {
  storedSelectValue,
  type PowerSelectOption,
  type PowerSelectSetting,
  type PowerSetting,
  type PowerSourceDefinition,
} from "@/lib/power/types";

/**
 * A generator's knobs as the clean card shows them: the tier select lives on the header chip, every other
 * setting that is switched on and differs from its default is a chip in the strip, and all of them are rows of the
 * gear menu. Pure: the card's hook only reads the node's values into it.
 */
export interface PowerSettingRow {
  id: string;
  label: string;
  /** The value as words. */
  value: string;
  /** Differs from the default. */
  changed: boolean;
  enabled: boolean;
  /** More than one value to step through. */
  steps: boolean;
  /** A select's current option key. */
  key?: string;
  setting: PowerSetting;
}

function rawOf(values: Record<string, string> | undefined, id: string): string | undefined {
  const raw = values?.[id];
  return raw === undefined || raw === "" ? undefined : raw;
}

function currentNumber(
  setting: Extract<PowerSetting, { type: "number" }>,
  raw: string | undefined,
): number {
  const parsed = Number(raw);
  if (raw === undefined || !Number.isFinite(parsed)) return setting.defaultValue;
  return Math.min(setting.max, Math.max(setting.min, parsed));
}

function currentToggle(
  setting: Extract<PowerSetting, { type: "toggle" }>,
  raw: string | undefined,
): boolean {
  return raw === undefined ? setting.defaultOn : raw === "1" || raw === "true";
}

/** The value of one setting right now, as the settings reader types it. */
export function powerSettingValue(
  source: PowerSourceDefinition,
  values: Record<string, string> | undefined,
  id: string,
): string | undefined {
  const setting = source.settings.find((entry) => entry.id === id);
  if (!setting) return undefined;
  if (setting.type === "select") return storedSelectValue(setting, values);
  const raw = rawOf(values, id);
  if (setting.type === "toggle") return currentToggle(setting, raw) ? "1" : "0";
  return String(currentNumber(setting, raw));
}

export function powerSettingRows(
  source: PowerSourceDefinition,
  values: Record<string, string> | undefined,
): PowerSettingRow[] {
  return source.settings.map((setting): PowerSettingRow => {
    const raw = rawOf(values, setting.id);
    const gate = setting.enabledWhen;
    const enabled =
      gate === undefined || powerSettingValue(source, values, gate.settingId) === gate.equals;
    if (setting.type === "select") {
      const key = storedSelectValue(setting, values);
      const option = setting.options.find((entry) => entry.key === key);
      return {
        id: setting.id,
        label: setting.label,
        value: option?.label ?? key,
        changed: key !== setting.defaultKey,
        enabled,
        steps: setting.options.length > 1,
        key,
        setting,
      };
    }
    if (setting.type === "number") {
      const n = currentNumber(setting, raw);
      return {
        id: setting.id,
        label: setting.label,
        value: `${n}${setting.unit ? ` ${setting.unit}` : ""}`,
        changed: n !== setting.defaultValue,
        enabled,
        steps: setting.max > setting.min,
        setting,
      };
    }
    const on = currentToggle(setting, raw);
    return {
      id: setting.id,
      label: setting.label,
      value: on ? "On" : "Off",
      changed: on !== setting.defaultOn,
      enabled,
      steps: true,
      setting,
    };
  });
}

/** One select as the card shows it: the option it reads as (legacy ids included) and its options. */
export function powerSettingsSelectModel(
  source: PowerSourceDefinition,
  values: Record<string, string> | undefined,
  settingId: string,
): { current: string; options: PowerSelectOption[] } | undefined {
  const setting = source.settings.find((entry) => entry.id === settingId);
  if (setting?.type !== "select") return undefined;
  return { current: storedSelectValue(setting, values), options: setting.options };
}

/** The strip's chips: the settings pinned to the card and in play, the tier (a header chip) left out. */
export function powerStripRows(
  rows: PowerSettingRow[],
  pins: readonly string[],
): PowerSettingRow[] {
  return rows.filter((row) => row.enabled && pins.includes(row.id) && !isTierSelect(row.setting));
}

export function isTierSelect(setting: PowerSetting): setting is PowerSelectSetting {
  return setting.type === "select" && setting.id === "tier";
}

/** The tier chip: the tier select's value; none when the source has no such select. */
export function powerTierChip(
  source: PowerSourceDefinition,
  values: Record<string, string> | undefined,
): { label: string; fixed: boolean; options: string[] } | undefined {
  const select = source.settings.find(isTierSelect);
  if (select) {
    return {
      label: storedSelectValue(select, values),
      fixed: select.options.length <= 1,
      options: select.options.map((option) => option.key),
    };
  }
  // A generator with no tier select wears no chip: its unlock tier is the picker's, not the card's.
  return undefined;
}

/**
 * The value one step from here, or undefined when there is nowhere to go. A select and a toggle wrap; a number
 * stops at its ends; the tier select is clamped, as every tier ladder on the board is.
 */
export function steppedPowerValue(row: PowerSettingRow, direction: -1 | 1): string | undefined {
  const { setting } = row;
  if (setting.type === "select") {
    const keys = setting.options.map((option) => option.key);
    const index = Math.max(0, keys.indexOf(row.key ?? ""));
    const next = isTierSelect(setting)
      ? Math.min(keys.length - 1, Math.max(0, index + direction))
      : (index + direction + keys.length) % keys.length;
    return keys[next] === row.key ? undefined : keys[next];
  }
  if (setting.type === "toggle") return row.value === "On" ? "0" : "1";
  const now = Number(row.value.split(" ")[0]);
  const next = Math.min(setting.max, Math.max(setting.min, now + direction * setting.step));
  return next === now ? undefined : String(Math.round(next * 1e9) / 1e9);
}
