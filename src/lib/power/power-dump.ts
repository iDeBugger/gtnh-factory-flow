/**
 * A test helper: every power source as plain data, so a whole source list can be compared
 * against a golden or against another version's list. A source's model is computed at its
 * defaults and at every option of every select setting, one setting at a time with the rest
 * at their defaults.
 */
import type { GameVersion } from "@/lib/model/game-version";
import {
  buildPowerSettingsReader,
  type PowerModel,
  type PowerSetting,
  type PowerSourceDefinition,
} from "./types";

export interface PowerSourceDump {
  id: string;
  name: string;
  group: string;
  unlock?: string;
  blurb: string;
  settings: PowerSetting[];
  model: {
    defaults: PowerModel;
    /** settingId -> option key -> the model with that one option picked. */
    options: Record<string, Record<string, PowerModel>>;
  };
}

/** JSON's view of a model: a golden file cannot hold Infinity, NaN or undefined. */
function plain(model: PowerModel): PowerModel {
  return JSON.parse(JSON.stringify(model)) as PowerModel;
}

export function dumpSources(
  sources: PowerSourceDefinition[],
  gameVersion: GameVersion,
): PowerSourceDump[] {
  return sources.map((source) => {
    const compute = (values: Record<string, string> | undefined) =>
      plain(source.compute(buildPowerSettingsReader(source, values, gameVersion), gameVersion));
    const options: Record<string, Record<string, PowerModel>> = {};
    for (const setting of source.settings) {
      if (setting.type !== "select") {
        continue;
      }
      options[setting.id] = Object.fromEntries(
        setting.options.map((option) => [option.key, compute({ [setting.id]: option.key })]),
      );
    }
    return JSON.parse(
      JSON.stringify({
        id: source.id,
        name: source.name,
        group: source.group,
        unlock: source.unlock,
        blurb: source.blurb,
        settings: source.settings,
        model: { defaults: compute(undefined), options },
      }),
    ) as PowerSourceDump;
  });
}
