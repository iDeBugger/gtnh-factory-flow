/**
 * Every placeable power source, grouped for the picker. Source ids are
 * stored in plans (Recipe.power.sourceId); never rename a shipped id.
 */
import type { GameVersion } from "@/lib/model/game-version";
import { ABSENT_POWER_SOURCES_2_8_1 } from "./overrides-2.8.1/absent";
import { powerTablesFor, type PowerTables } from "./planner-data";
import { buildEndgameSources } from "./sources/endgame";
import { buildEngineSources } from "./sources/engines";
import { buildRailcraftOtherSources } from "./sources/railcraft";
import { buildPassiveSources, buildReactorSources } from "./sources/reactors";
import { buildSingleblockSources } from "./sources/singleblocks";
import { buildSofcSources } from "./sources/sofc";
import { buildSteamMakerSources } from "./sources/steam-makers";
import { buildTurbineSources } from "./sources/turbines";
import type { PowerGroupId, PowerSourceDefinition } from "./types";

export const POWER_GROUPS: Array<{ id: PowerGroupId; name: string; blurb: string }> = [
  // The planning cards: the custom rate card, the fluid tank and the crop farm are special models
  // (src/lib/model), listed by the picker itself; the Railcraft Water Tank is a source.
  { id: "other", name: "Other", blurb: "Planning cards, and water from the sky." },
  { id: "burners", name: "Generators", blurb: "Singleblocks: one amp of their tier from fuel." },
  { id: "engines", name: "Engines", blurb: "The big fuel burners: engines and fuel cells." },
  { id: "steam", name: "Boilers and exchangers", blurb: "Everything that makes steam." },
  { id: "turbines", name: "Turbines", blurb: "Steam, gas and plasma through a rotor." },
  { id: "reactors", name: "Reactors", blurb: "Nuclear heat, pebbles and salts." },
  { id: "passive", name: "Solar", blurb: "Power from the sky." },
  { id: "endgame", name: "Endgame", blurb: "Naquadah, fusion, antimatter." },
];

/** Source ids a version does not have: they are left out of its list, picker and search. */
export const ABSENT_POWER_SOURCES: Partial<Record<GameVersion, string[]>> = {
  "2.8.1": ABSENT_POWER_SOURCES_2_8_1,
};

/** Every source built from one version's tables, in picker order, less the absent ids. */
export function buildAllSources(
  tables: PowerTables,
  gameVersion: GameVersion,
  absent: string[] = [],
): PowerSourceDefinition[] {
  const all = [
    ...buildSingleblockSources(tables, gameVersion),
    ...buildEngineSources(tables, gameVersion),
    ...buildSofcSources(tables, gameVersion),
    ...buildSteamMakerSources(tables, gameVersion),
    ...buildTurbineSources(tables, gameVersion),
    ...buildReactorSources(tables, gameVersion),
    ...buildPassiveSources(tables, gameVersion),
    ...buildEndgameSources(tables, gameVersion),
    ...buildRailcraftOtherSources(tables, gameVersion),
  ];
  return absent.length === 0 ? all : all.filter((source) => !absent.includes(source.id));
}

interface VersionSources {
  list: PowerSourceDefinition[];
  byId: Map<string, PowerSourceDefinition>;
}

const sourcesByVersion = new Map<GameVersion, VersionSources>();

function versionSources(gameVersion: GameVersion): VersionSources {
  let entry = sourcesByVersion.get(gameVersion);
  if (!entry) {
    const list = buildAllSources(
      powerTablesFor(gameVersion),
      gameVersion,
      ABSENT_POWER_SOURCES[gameVersion],
    );
    entry = { list, byId: new Map(list.map((source) => [source.id, source])) };
    sourcesByVersion.set(gameVersion, entry);
  }
  return entry;
}

/** One version's power sources, built once per version. */
export function powerSourcesFor(gameVersion: GameVersion): PowerSourceDefinition[] {
  return versionSources(gameVersion).list;
}

export function getPowerSource(
  sourceId: string,
  gameVersion: GameVersion,
): PowerSourceDefinition | undefined {
  return versionSources(gameVersion).byId.get(sourceId);
}
