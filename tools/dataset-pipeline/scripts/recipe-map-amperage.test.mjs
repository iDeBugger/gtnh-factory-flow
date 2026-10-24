import { describe, expect, it } from "vitest";
import { recipeMapAmperageTable } from "./recipe-map-amperage.mjs";
import { recipeMapAmperageTable as appTable } from "../../../src/lib/machines/recipe-map-amperage.ts";

describe("the pipeline's map amperage table", () => {
  it("matches the app's for every pack", () => {
    expect(recipeMapAmperageTable("2.8.1")).toEqual(appTable("2.8.1"));
    expect(recipeMapAmperageTable("2.9.0-RC-2")).toEqual(appTable("2.9"));
    expect(recipeMapAmperageTable("2.9.0")).toEqual(appTable("2.9"));
  });
});
