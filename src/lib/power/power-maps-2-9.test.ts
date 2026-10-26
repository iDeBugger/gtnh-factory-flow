import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { getPowerMachineIcon, resolvePowerResource } from "./planner-data";

// The 2.9 maps name the 2.9 dataset this site serves (the default in the local manifest). A map
// made against a retired dataset names icon files no server has, and every 2.9 power card then
// draws placeholders. Icon names carry a content hash, so only the path's shape is pinned here.
const DATASET_2_9 = "local-2.9.0-rc-2";
const RENDERED_2_9 = /^\/datasets\/gtnh\/local-2\.9\.0-rc-2\/textures\/rendered\/[^/]+\.png$/;

type IconEntry = { iconPath?: string };
const read = (file: string) => JSON.parse(readFileSync(path.join(__dirname, "data", file), "utf8"));

describe("2.9 power maps", () => {
  test("both 2.9 maps are made against the served 2.9 dataset", () => {
    expect(read("machine-icons.json").datasetVersionId).toBe(DATASET_2_9);
    expect(read("resource-map.json").datasetVersionId).toBe(DATASET_2_9);
    expect(resolvePowerResource("Steam", "2.9")?.iconPath).toMatch(RENDERED_2_9);
    expect(getPowerMachineIcon("steam-turbine", "2.9")?.iconPath).toMatch(RENDERED_2_9);
  });

  test("every 2.9 icon path, faces and fuels, is a file in the 2.9 dataset when it is on disk", () => {
    const entries: Array<[string, IconEntry]> = [
      ...Object.entries((read("machine-icons.json") as { machines: Record<string, IconEntry> }).machines),
      ...Object.entries((read("resource-map.json") as { resources: Record<string, IconEntry> }).resources),
    ];
    for (const [name, entry] of entries) {
      expect(entry.iconPath, name).toMatch(RENDERED_2_9);
    }
    // The dataset is not checked in; where it is present, a stale map (icons re-rendered under
    // new hashes since it was made) fails here. Run this before a 2.9 publish.
    const root = path.join(process.cwd(), "public");
    const manifest = path.join(root, "datasets", "gtnh", "datasets.manifest.json");
    if (existsSync(manifest)) {
      const ids = (JSON.parse(readFileSync(manifest, "utf8")) as { versions: Array<{ id: string }> }).versions.map(
        (version) => version.id,
      );
      expect(ids).toContain(DATASET_2_9);
    }
    if (existsSync(path.join(root, "datasets", "gtnh", DATASET_2_9, "textures", "rendered"))) {
      const missing = entries.filter(([, entry]) => !existsSync(path.join(root, entry.iconPath!))).map(([name]) => name);
      expect(missing).toEqual([]);
    }
    // A kept texture from an earlier install is still a file: the map must name the icon this build draws for its id.
    const index = path.join(root, "datasets", "gtnh", DATASET_2_9, "resource-index.json.gz");
    if (existsSync(index)) {
      const catalog = JSON.parse(gunzipSync(readFileSync(index)).toString("utf8")) as {
        resourceIndex: Array<{ kind: string; id: string; iconPath?: string }>;
      };
      const drawn = new Map(catalog.resourceIndex.map((record) => [`${record.kind}:${record.id}`, record.iconPath]));
      const stale = entries
        .filter(([, entry]) => drawn.get(`${(entry as { kind?: string }).kind ?? "item"}:${(entry as { id?: string }).id}`) !== entry.iconPath)
        .map(([name]) => name);
      expect(stale).toEqual([]);
    }
  });
});
