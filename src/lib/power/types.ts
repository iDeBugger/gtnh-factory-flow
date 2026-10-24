/**
 * The power sector's card model. A PowerSourceDefinition is one placeable
 * generator family: its settings (the knobs on the card) and a pure compute
 * from settings to flows and EU/t. Math and data are transcribed from the
 * community "GTNH Power Planner 2.9" spreadsheet (by Fox), decoded in
 * docs/power-planner-math.md - that workbook is the source of truth, with
 * the game source as arbiter (src/lib/power/CLAUDE.md).
 */

import type { GameVersion } from "@/lib/model/game-version";

export type PowerGroupId =
  | "other"
  | "burners"
  | "engines"
  | "steam"
  | "turbines"
  | "reactors"
  | "passive"
  | "endgame";

export interface PowerSelectOption {
  key: string;
  label: string;
}

/**
 * A knob that only means something while another knob holds a given value -
 * a custom flow field with the flow mode on Optimal, say - renders grayed
 * out until then.
 */
export interface PowerSettingCondition {
  settingId: string;
  equals: string;
}

export interface PowerSelectSetting {
  type: "select";
  id: string;
  label: string;
  options: PowerSelectOption[];
  defaultKey: string;
  enabledWhen?: PowerSettingCondition;
  /** Retired option key -> the current key it reads as; shipped plans store old option keys. */
  legacyKeys?: Record<string, string>;
  /**
   * Retired setting ids this select reads when its own id is unset, tried in order: a plan
   * saved before two settings became one stores the old ids. A legacy value with no option
   * here gives way to a later one that has, the way a machine skips a fuel it cannot burn.
   */
  legacyIds?: string[];
  /** Legacy-id values that mean "nothing picked" (a boiler's "None"): skipped as if unset. */
  legacyUnsetKeys?: string[];
}

export interface PowerNumberSetting {
  type: "number";
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit?: string;
  enabledWhen?: PowerSettingCondition;
}

export interface PowerToggleSetting {
  type: "toggle";
  id: string;
  label: string;
  defaultOn: boolean;
  enabledWhen?: PowerSettingCondition;
}

export type PowerSetting = PowerSelectSetting | PowerNumberSetting | PowerToggleSetting;

/**
 * One resource stream at the chosen settings, for ONE machine. `name` is the
 * spreadsheet's display name; the recipe synthesis resolves it to a dataset
 * resource where the map knows it, and shows it as a stat line where not.
 */
export interface PowerFlowLine {
  name: string;
  perSecond: number;
  unit: "L" | "item";
}

export interface PowerStatLine {
  label: string;
  value: string;
}

export interface PowerModel {
  /** Net EU/t of one machine at these settings; negative for parasitic-only machines. */
  euPerTick: number;
  inputs: PowerFlowLine[];
  outputs: PowerFlowLine[];
  stats: PowerStatLine[];
  /** Plain sentences shown on the card when a setting combination cannot run. */
  warnings?: string[];
}

/** Settings come off the node as strings; the reader types and defaults them. */
export interface PowerSettingsReader {
  select(id: string): string;
  number(id: string): number;
  on(id: string): boolean;
  /**
   * Stored select values this version has no option for, with the option used instead. On 2.9, whose
   * definitions are the ones plans are saved against, only a value another version offers is named
   * (`PowerReaderContext.others`). A choice another version's card stores under another id
   * (`PowerReaderContext.foreignIds`) is named on any version while this card's own select is unset: a
   * conversion carries the ones this card offers, so what is left is a choice this version lacks.
   */
  missing(): Array<{ settingId: string; stored: string; used: string }>;
  /**
   * Selects that read one of several stored legacy values (2.8.1's one-fuel boiler under 2.9's two
   * fuels): the values stored, in order, and the one used. Empty while the select's own id is set.
   */
  merged(): Array<{ settingId: string; stored: string[]; used: string }>;
  /**
   * Stored setting ids this version's definition does not have. On 2.9 only the ids another version's
   * card declares (`PowerReaderContext.others`), since 2.9 plans may keep retired ids.
   */
  unknownSettings(): string[];
}

export interface PowerSourceDefinition {
  /** Stable id, stored in plans - never rename one that has shipped. */
  id: string;
  name: string;
  group: PowerGroupId;
  /** Voltage tier chip in the picker; a plain label, not enforced anywhere. */
  unlock?: string;
  /** One plain sentence for the picker card. */
  blurb: string;
  settings: PowerSetting[];
  /** The model at these settings, by the plan's game version's rules. */
  compute(read: PowerSettingsReader, gameVersion: GameVersion): PowerModel;
}

/** What a reader knows of the same source in the other game versions. */
export interface PowerReaderContext {
  /** The source as the other versions build it. */
  others?: PowerSourceDefinition[];
  /** This version's select id -> the ids another version's card stores the same choice under. */
  foreignIds?: Record<string, string[]>;
}

/** The option a select setting reads as: the stored key, its legacy mapping, or the default. */
export function selectValue(setting: PowerSelectSetting, raw: string | undefined): string {
  return raw === undefined ? setting.defaultKey : (optionKeyOf(setting, raw) ?? setting.defaultKey);
}

/** A stored value, or undefined when the node never set it (the UI writes "" for unset). */
function storedRaw(values: Record<string, string> | undefined, id: string): string | undefined {
  const raw = values?.[id];
  return raw === undefined || raw === "" ? undefined : raw;
}

/** The option a stored value names here: itself, or the current key its legacy key maps to. */
function optionKeyOf(setting: PowerSelectSetting, raw: string): string | undefined {
  if (setting.options.some((option) => option.key === raw)) {
    return raw;
  }
  const mapped = setting.legacyKeys?.[raw];
  return mapped !== undefined && setting.options.some((option) => option.key === mapped)
    ? mapped
    : undefined;
}

/**
 * The raw value a select reads. Its own id wins whenever set. Otherwise the legacy ids are
 * tried in order: an unset key is skipped, and the first value with an option here wins. With
 * none, the first stored legacy value is read, so it falls to the default and is named; with
 * only unset keys stored, the first of them is read when it is an option.
 */
function storedSelectRaw(
  setting: PowerSelectSetting,
  values: Record<string, string> | undefined,
): string | undefined {
  const own = storedRaw(values, setting.id);
  if (own !== undefined) {
    return own;
  }
  let first: string | undefined;
  let unset: string | undefined;
  for (const id of setting.legacyIds ?? []) {
    const raw = storedRaw(values, id);
    if (raw === undefined) {
      continue;
    }
    if (setting.legacyUnsetKeys?.includes(raw)) {
      unset ??= raw;
      continue;
    }
    if (optionKeyOf(setting, raw) !== undefined) {
      return raw;
    }
    first ??= raw;
  }
  // Only "nothing picked" stored is still a choice: read it when it is an option here, not the
  // default, so a boiler saved with no fuel burns none.
  if (first === undefined && unset !== undefined && optionKeyOf(setting, unset) !== undefined) {
    return unset;
  }
  return first;
}

/**
 * The option a select reads as from a node's stored values, legacy ids included. The one
 * place a stored select is read, so the card shows the option its model computes.
 */
export function storedSelectValue(
  setting: PowerSelectSetting,
  values: Record<string, string> | undefined,
): string {
  return selectValue(setting, storedSelectRaw(setting, values));
}

export function buildPowerSettingsReader(
  definition: PowerSourceDefinition,
  values: Record<string, string> | undefined,
  gameVersion: GameVersion,
  context: PowerReaderContext = {},
): PowerSettingsReader {
  const byId = new Map(definition.settings.map((setting) => [setting.id, setting]));
  // Only another version than 2.9 is checked in full: plans from before versions were saved on 2.9's definitions,
  // so on 2.9 a stored value is named only when another version offers it (it came from that version's card).
  const checks = gameVersion !== "2.9";
  const offeredElsewhere = (settingId: string, raw: string) =>
    (context.others ?? []).some((other) =>
      other.settings.some(
        (setting) => setting.type === "select" && setting.id === settingId && optionKeyOf(setting, raw) !== undefined,
      ),
    );
  return {
    select(id) {
      const setting = byId.get(id);
      if (setting?.type !== "select") {
        return "";
      }
      return storedSelectValue(setting, values);
    },
    number(id) {
      const setting = byId.get(id);
      if (setting?.type !== "number") {
        return 0;
      }
      const raw = Number(values?.[id]);
      if (!Number.isFinite(raw)) {
        return setting.defaultValue;
      }
      return Math.min(setting.max, Math.max(setting.min, raw));
    },
    on(id) {
      const setting = byId.get(id);
      if (setting?.type !== "toggle") {
        return false;
      }
      const raw = values?.[id];
      return raw === undefined ? setting.defaultOn : raw === "1" || raw === "true";
    },
    missing() {
      const found: Array<{ settingId: string; stored: string; used: string }> = [];
      // A foreign choice two selects could hold (a 2.8.1 boiler fuel, liquid or solid on 2.9) is named once.
      const named = new Set<string>();
      for (const setting of definition.settings) {
        if (setting.type !== "select") {
          continue;
        }
        const stored = storedSelectRaw(setting, values);
        if (stored === undefined) {
          // Nothing of this card's own: another version's choice under its own id, never read, only named.
          for (const id of context.foreignIds?.[setting.id] ?? []) {
            const raw = storedRaw(values, id);
            if (raw === undefined || named.has(id)) continue;
            named.add(id);
            found.push({ settingId: setting.id, stored: raw, used: setting.defaultKey });
            break;
          }
          continue;
        }
        // An option first, then a legacy key whose option is here too, as selectValue reads them.
        if (optionKeyOf(setting, stored) !== undefined) {
          continue;
        }
        if (!checks && !offeredElsewhere(setting.id, stored)) {
          continue;
        }
        found.push({ settingId: setting.id, stored, used: selectValue(setting, stored) });
      }
      return found;
    },
    merged() {
      const found: Array<{ settingId: string; stored: string[]; used: string }> = [];
      for (const setting of definition.settings) {
        if (setting.type !== "select" || !setting.legacyIds || storedRaw(values, setting.id) !== undefined) {
          continue;
        }
        const read = storedSelectRaw(setting, values);
        if (read === undefined || optionKeyOf(setting, read) === undefined) {
          continue;
        }
        const stored = setting.legacyIds
          .map((id) => storedRaw(values, id))
          .filter((raw): raw is string => raw !== undefined && !setting.legacyUnsetKeys?.includes(raw));
        if (stored.length > 1) {
          found.push({ settingId: setting.id, stored, used: selectValue(setting, read) });
        }
      }
      return found;
    },
    unknownSettings() {
      if (!values) {
        return [];
      }
      const elsewhere = new Set((context.others ?? []).flatMap((other) => other.settings.map((setting) => setting.id)));
      const known = new Set<string>();
      for (const setting of definition.settings) {
        known.add(setting.id);
        if (setting.type === "select") {
          for (const id of setting.legacyIds ?? []) known.add(id);
          // Named by missing() with the value and what is used instead.
          for (const id of context.foreignIds?.[setting.id] ?? []) known.add(id);
        }
      }
      return Object.keys(values).filter(
        (id) => storedRaw(values, id) !== undefined && !known.has(id) && (checks || elsewhere.has(id)),
      );
    },
  };
}
