/**
 * A power card's settings across game versions. A converted card keeps its stored settings, and a setting left
 * at its default means that version's default: the same unset fuel burns Ether on a 2.9 superheated boiler and
 * Solid Super Fuel on 2.8.1's. So a conversion writes every select the source card read into the card
 * (`convertPowerSettings`), and the target card either reads the same choice or names it with what it uses
 * instead (`powerReaderContext`, read by `buildPowerRecipe`'s warnings). Never silent.
 */
import type { GameVersion } from "@/lib/model/game-version";
import { POWER_DATA_OVERRIDES } from "./planner-data";
import { getPowerSource } from "./registry";
import { storedSelectValue, type PowerReaderContext, type PowerSelectSetting } from "./types";

const LARGE_BOILERS = [
  "large-bronze-boiler",
  "large-steel-boiler",
  "large-titanium-boiler",
  "large-tungstensteel-boiler",
];

/**
 * A choice one version's card stores under ids another version's card does not read, by source id, then the
 * reading version, then its select id -> the other card's ids. A conversion moves the choice onto the select
 * that offers it (`sameChoice` says which option is the same choice, by key when unset); a choice no select
 * offers is named on the card.
 */
interface ForeignSettings {
  sameChoice?: (stored: string, option: string) => boolean;
  byVersion: Partial<Record<GameVersion, Record<string, string[]>>>;
}

/** A TRISO material by its element: bartworks names the fuel "Uranium", kubatech its pebble "Uranium-235". */
function sameMaterial(stored: string, option: string): boolean {
  const element = (name: string) => name.split("-")[0]!.trim().toLowerCase();
  return element(stored) === element(option);
}

export const FOREIGN_POWER_SETTINGS: Record<string, ForeignSettings> = {
  // 2.8.1's one Fuel is a liquid or a solid, which 2.9's two selects keep apart.
  ...Object.fromEntries(
    LARGE_BOILERS.map((id) => [
      id,
      { byVersion: { "2.9": { liquidFuel: ["fuel"], solidFuel: ["fuel"] } } },
    ]),
  ),
  // 2.9 runs kubatech's HTGR on TRISO pebbles, 2.8.1 bartworks' on its three fuels: the same material carries
  // over (Thorium, Uranium-235 as Uranium, Plutonium-239 as Plutonium); one the other reactor lacks is named.
  htgr: { sameChoice: sameMaterial, byVersion: { "2.9": { pebble: ["fuel"] }, "2.8.1": { fuel: ["pebble"] } } },
};

/** The versions whose power cards are built from their own tables. */
const POWER_VERSIONS = Object.keys(POWER_DATA_OVERRIDES);

const NO_FUEL = "None";

/** What the reader of `sourceId` on `gameVersion` knows of the other versions' cards. */
export function powerReaderContext(sourceId: string, gameVersion: GameVersion): PowerReaderContext {
  const others = POWER_VERSIONS.filter((version) => version !== gameVersion)
    .map((version) => getPowerSource(sourceId, version))
    .filter((source) => source !== undefined);
  const foreignIds = FOREIGN_POWER_SETTINGS[sourceId]?.byVersion[gameVersion];
  return foreignIds ? { others, foreignIds } : { others };
}

function stored(values: Record<string, string>, id: string): boolean {
  return values[id] !== undefined && values[id] !== "";
}

function offers(setting: PowerSelectSetting, key: string): boolean {
  return setting.options.some((option) => option.key === key);
}

/**
 * The settings of a power card converted from `from` to `to`. Every select the source card has is written with
 * the value it read there (its default too), so the target reads the source's meaning, not its own default: a
 * select of the same id or a legacy id reads it, and a value the target does not offer is named on the card. A
 * select id the target reads that the source card has no select of is a leftover of an earlier conversion and is
 * dropped, so it never overrules what the source card used. A choice the other card keeps under another id (a
 * 2.8.1 boiler's one fuel, the HTGR's fuel or pebble) is put on the target select that offers it, the others of its
 * group set to None, and its old id dropped.
 */
export function convertPowerSettings(
  sourceId: string,
  values: Record<string, string> | undefined,
  from: GameVersion,
  to: GameVersion,
): Record<string, string> | undefined {
  const source = getPowerSource(sourceId, from);
  const target = getPowerSource(sourceId, to);
  if (!source || !target || from === to) return values;
  const out: Record<string, string> = { ...values };

  // A select id the target reads that is not one of the source card's own selects is a leftover: the source card
  // read its choice into its own select (below), which is the one carried over.
  const sourceIds = new Set(source.settings.map((setting) => setting.id));
  for (const setting of target.settings) {
    if (setting.type !== "select") continue;
    for (const id of [setting.id, ...(setting.legacyIds ?? [])]) if (!sourceIds.has(id)) delete out[id];
  }

  for (const setting of source.settings) {
    if (setting.type !== "select" || stored(out, setting.id)) continue;
    out[setting.id] = storedSelectValue(setting, values);
  }

  const foreign = FOREIGN_POWER_SETTINGS[sourceId];
  const groups = foreign?.byVersion[to];
  const same = foreign?.sameChoice ?? ((a: string, b: string) => a === b);
  if (groups) {
    const byForeignId = new Map<string, PowerSelectSetting[]>();
    for (const [ownId, foreignIds] of Object.entries(groups)) {
      const setting = target.settings.find((entry) => entry.id === ownId);
      if (setting?.type !== "select") continue;
      for (const id of foreignIds) byForeignId.set(id, [...(byForeignId.get(id) ?? []), setting]);
    }
    for (const [foreignId, selects] of byForeignId) {
      const value = out[foreignId];
      if (value === undefined || selects.some((setting) => stored(out, setting.id))) continue;
      const home = selects
        .map((setting) => ({ setting, key: setting.options.find((option) => same(value, option.key))?.key }))
        .find((entry) => entry.key !== undefined);
      // Kept when nothing offers it: the target card names it with what it uses instead.
      if (!home) continue;
      for (const setting of selects) {
        if (setting === home.setting) out[setting.id] = home.key!;
        else if (offers(setting, NO_FUEL)) out[setting.id] = NO_FUEL;
      }
      delete out[foreignId];
    }
  }
  return out;
}
