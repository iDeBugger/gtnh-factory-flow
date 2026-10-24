/**
 * Prints one version's power tables and every flow name its power sources produce, at their
 * defaults and at every option of every select setting, as the `--data` input of
 * tools/power-resource-map.mjs. A flow's kind follows its unit: litres are fluids, the rest items.
 *
 *   npx tsx tools/power-tables-dump.ts <version> > scratch/power-tables-<version>.json
 */
import type { GameVersion } from "@/lib/model/game-version";
import { dumpSources } from "@/lib/power/power-dump";
import { powerTablesFor } from "@/lib/power/planner-data";
import { powerSourcesFor } from "@/lib/power/registry";
import type { PowerModel } from "@/lib/power/types";

const version: GameVersion | undefined = process.argv[2];
if (!version) {
  console.error("Usage: npx tsx tools/power-tables-dump.ts <version, e.g. 2.9 or 2.8.1>");
  process.exit(1);
}

const flows = new Map<string, "fluid" | "item">();
const collect = (model: PowerModel) => {
  for (const flow of [...model.inputs, ...model.outputs]) {
    if (!flows.has(flow.name)) {
      flows.set(flow.name, flow.unit === "L" ? "fluid" : "item");
    }
  }
};
for (const dump of dumpSources(powerSourcesFor(version), version)) {
  collect(dump.model.defaults);
  for (const options of Object.values(dump.model.options)) {
    Object.values(options).forEach(collect);
  }
}

process.stdout.write(
  JSON.stringify(
    {
      gameVersion: version,
      tables: powerTablesFor(version),
      flows: [...flows.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, kind]) => ({ name, kind })),
    },
    null,
    1,
  ) + "\n",
);
