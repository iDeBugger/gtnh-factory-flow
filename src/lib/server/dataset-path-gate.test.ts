import { describe, expect, it } from "vitest";
import { extraGateCases, harnessGateCases } from "@/test-support/dataset-gate-cases";
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

  it("sends the server's content-addressed answers to the dataset-files route, encoded spellings refused", () => {
    expect(
      decideDatasetPath(`/datasets/gtnh/${V}/client/catalog.0123456789abcdef0123.json`),
    ).toEqual({
      kind: "rewrite",
      pathname: `/dataset-files/${V}/client/catalog.0123456789abcdef0123.json`,
    });
    // The stored encodings go to the route too, which serves only the logical name.
    expect(
      decideDatasetPath(`/datasets/gtnh/${V}/client/catalog.0123456789abcdef0123.json.br`),
    ).toEqual({
      kind: "rewrite",
      pathname: `/dataset-files/${V}/client/catalog.0123456789abcdef0123.json.br`,
    });
    expect(decideDatasetPath(`/datasets/gtnh/${V}/client%2Fcatalog.json`)).toEqual({
      kind: "refuse",
    });
    expect(decideDatasetPath(`/datasets/gtnh/${V}/client/../recipes.json`)).toEqual({
      kind: "refuse",
    });
  });

  it("sends the content-named textures to the dataset-files route, the other textures not", () => {
    for (const root of ["rendered", "icons"]) {
      expect(
        decideDatasetPath(`/datasets/gtnh/${V}/textures/${root}/copper-a50d21cdeb41.png`),
      ).toEqual({
        kind: "rewrite",
        pathname: `/dataset-files/${V}/textures/${root}/copper-a50d21cdeb41.png`,
      });
    }
    for (const other of [
      `/datasets/gtnh/${V}/textures/atlas/atlas-0000.png`,
      `/datasets/gtnh/${V}/textures/icon-report.json`,
      `/datasets/gtnh/${V}/textures/rendered/deeper/x.png`,
    ]) {
      expect(decideDatasetPath(other), other).toEqual({ kind: "pass" });
    }
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

  it("lets everything else through: other files, the rest of the site", () => {
    expect(decideDatasetPath(`/datasets/gtnh/${V}/oracle/oracle-report.json`)).toEqual({
      kind: "pass",
    });
    expect(decideDatasetPath(`/datasets/gtnh/datasets.manifest.json`)).toEqual({ kind: "pass" });
    expect(decideDatasetPath(`/dataset-files/${V}/recipes.json.gz`)).toEqual({ kind: "pass" });
    expect(decideDatasetPath("/api/datasets/x/recipes")).toEqual({ kind: "pass" });
    expect(decideDatasetPath("/")).toEqual({ kind: "pass" });
    expect(decideDatasetPath("/plans/some%20name")).toEqual({ kind: "pass" });
  });

  it("decides every shared spelling of a dataset path as the cases say, read as a pathname", () => {
    for (const { target, decision } of [...harnessGateCases(V), ...extraGateCases(V)]) {
      expect(decideDatasetPath(target).kind, target).toBe(decision);
    }
  });
});
