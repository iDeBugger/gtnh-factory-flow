import { describe, expect, it } from "vitest";
import { decideDatasetPath } from "./dataset-path-gate";

const V = "local-2.9.0-rc-2";

describe("the dataset path gate", () => {
  it("sends the index gzips, the shards and the raw recipes file to the dataset-files route", () => {
    for (const file of [
      "recipes.json",
      "recipes.json.gz",
      "recipe-index.json.gz",
      "recipe-lookup-index.json.gz",
      "resource-index.json.gz",
    ]) {
      expect(decideDatasetPath(`/datasets/gtnh/${V}/${file}`)).toEqual({
        kind: "rewrite",
        pathname: `/dataset-files/${V}/${file}`,
      });
    }
    expect(decideDatasetPath(`/datasets/gtnh/${V}/recipes-shards/shard-0000.json.gz`)).toEqual({
      kind: "rewrite",
      pathname: `/dataset-files/${V}/recipes-shards/shard-0000.json.gz`,
    });
  });

  it("refuses any percent-encoding under the data, whatever it spells", () => {
    for (const path of [
      `/datasets/gtnh/${V}/recipes%2Ejson`,
      `/datasets/gtnh/${V}/recipes%2ejson`,
      `/datasets/gtnh/${V}/%72ecipes.json`,
      `/datasets/gtnh/${V}%2Frecipes.json`,
      `/datasets/gtnh/${V}/recipes%252Ejson`,
      `/%64atasets/gtnh/${V}/recipes.json`,
      `/datasets%2Fgtnh/${V}/recipes.json`,
      `/datasets/gtnh/${V}/recipes%2Ejson.gz`,
      `/datasets/gtnh/${V}/recipes-shards%2Fshard-0000.json.gz`,
      `/datasets/gtnh/${V}/textures/rendered/x%2Epng`,
      `/dataset-files/${V}/recipes%2Ejson.gz`,
      `/datasets/gtnh/${V}/%E0%A4%A`,
    ]) {
      expect(decideDatasetPath(path), path).toEqual({ kind: "refuse" });
    }
  });

  it("refuses dot segments and empty segments under the data", () => {
    expect(decideDatasetPath(`/datasets/gtnh/${V}/../${V}/recipes.json`)).toEqual({
      kind: "refuse",
    });
    expect(decideDatasetPath(`/datasets/gtnh/${V}/./recipes.json`)).toEqual({ kind: "refuse" });
    expect(decideDatasetPath(`/datasets/gtnh//${V}/recipes.json`)).toEqual({ kind: "refuse" });
    expect(decideDatasetPath(`/datasets/gtnh/${V}/recipes.json/`)).toEqual({ kind: "refuse" });
  });

  it("lets everything else through: textures, other files, the rest of the site", () => {
    expect(
      decideDatasetPath(`/datasets/gtnh/${V}/textures/rendered/copper-a50d21cdeb41.png`),
    ).toEqual({ kind: "pass" });
    expect(decideDatasetPath(`/datasets/gtnh/${V}/oracle/oracle-report.json`)).toEqual({
      kind: "pass",
    });
    expect(decideDatasetPath(`/datasets/gtnh/datasets.manifest.json`)).toEqual({ kind: "pass" });
    expect(decideDatasetPath(`/dataset-files/${V}/recipes.json.gz`)).toEqual({ kind: "pass" });
    expect(decideDatasetPath("/api/datasets/x/recipes")).toEqual({ kind: "pass" });
    expect(decideDatasetPath("/")).toEqual({ kind: "pass" });
    expect(decideDatasetPath("/plans/some%20name")).toEqual({ kind: "pass" });
  });
});
