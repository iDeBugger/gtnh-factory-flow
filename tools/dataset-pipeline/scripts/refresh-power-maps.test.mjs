import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { refreshPowerMap, refreshPowerMaps } from "./refresh-power-maps.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "power-maps-"));
  dirs.push(dir);
  return dir;
}

describe("refresh-power-maps", () => {
  const records = new Map([
    ["item:gt:turbine", { kind: "item", id: "gt:turbine", displayName: "Turbine", iconPath: "/t-new.png", dominantColor: "#111111" }],
    ["fluid:steam", { kind: "fluid", id: "steam", displayName: "Steam", iconPath: "/s-new.png" }],
  ]);

  it("points each entry at the build's record for its id", () => {
    const { map, changed, missing } = refreshPowerMap(
      { datasetVersionId: "v", resources: { Steam: { kind: "fluid", id: "steam", displayName: "Steam", iconPath: "/s-old.png", dominantColor: "#222222" } } },
      records,
    );
    expect(map.resources.Steam).toEqual({ kind: "fluid", id: "steam", displayName: "Steam", iconPath: "/s-new.png" });
    expect(changed).toBe(1);
    expect(missing).toEqual([]);
  });

  it("names the entries whose id the build lacks", () => {
    const { missing } = refreshPowerMap({ machines: { gone: { id: "gt:gone", iconPath: "/x.png" } } }, records);
    expect(missing).toEqual(["gone"]);
  });

  it("rewrites only the maps made for that version", () => {
    const root = tempDir();
    const version = path.join(root, "local-x");
    fs.mkdirSync(version);
    fs.writeFileSync(
      path.join(version, "resource-index.json.gz"),
      gzipSync(JSON.stringify({ resourceIndex: [...records.values()] })),
    );
    const data = path.join(root, "data");
    fs.mkdirSync(path.join(data, "2.8.1"), { recursive: true });
    const mine = { datasetVersionId: "local-x", machines: { turbine: { id: "gt:turbine", displayName: "Turbine", iconPath: "/t-old.png" } } };
    const other = { datasetVersionId: "local-y", machines: { turbine: { id: "gt:turbine", iconPath: "/t-old.png" } } };
    fs.writeFileSync(path.join(data, "machine-icons.json"), JSON.stringify(mine));
    fs.writeFileSync(path.join(data, "2.8.1", "machine-icons.json"), JSON.stringify(other));
    refreshPowerMaps(version, data);
    expect(JSON.parse(fs.readFileSync(path.join(data, "machine-icons.json"), "utf8")).machines.turbine.iconPath).toBe("/t-new.png");
    expect(JSON.parse(fs.readFileSync(path.join(data, "2.8.1", "machine-icons.json"), "utf8"))).toEqual(other);
  });

  it("writes nothing when a map names an id the build lacks, and checks without writing", () => {
    const root = tempDir();
    const version = path.join(root, "build");
    fs.mkdirSync(version);
    fs.writeFileSync(path.join(version, "resource-index.json.gz"), gzipSync(JSON.stringify({ resourceIndex: [...records.values()] })));
    const data = path.join(root, "data");
    fs.mkdirSync(data);
    const machines = { datasetVersionId: "local-x", machines: { turbine: { id: "gt:turbine", iconPath: "/t-old.png" } } };
    const resources = { datasetVersionId: "local-x", resources: { Gone: { kind: "item", id: "gt:gone", iconPath: "/g.png" } } };
    fs.writeFileSync(path.join(data, "machine-icons.json"), JSON.stringify(machines));
    fs.writeFileSync(path.join(data, "resource-map.json"), JSON.stringify(resources));
    const report = refreshPowerMaps(version, data, { id: "local-x" });
    expect(report.find((entry) => entry.file === "resource-map.json").missing).toEqual(["Gone"]);
    expect(JSON.parse(fs.readFileSync(path.join(data, "machine-icons.json"), "utf8"))).toEqual(machines);
    fs.writeFileSync(path.join(data, "resource-map.json"), JSON.stringify({ ...resources, resources: {} }));
    const checked = refreshPowerMaps(version, data, { id: "local-x", write: false });
    expect(checked.find((entry) => entry.file === "machine-icons.json").changed).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(data, "machine-icons.json"), "utf8"))).toEqual(machines);
  });
});
