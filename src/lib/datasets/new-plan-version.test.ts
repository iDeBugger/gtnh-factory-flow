// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEW_PLAN_VERSION_STORAGE_KEY,
  readNewPlanVersion,
  resetNewPlanVersionForTests,
  recipesNotOnSiteText,
  servedGameVersions,
  unservedPlanText,
  writeNewPlanVersion,
} from "./new-plan-version";
import type { DatasetManifest } from "./types";

function datasetVersion(id: string, gtnhVersion: string) {
  return {
    id,
    gtnhVersion,
    channel: "stable" as const,
    publishedAt: "2026-10-20T00:00:00.000Z",
    manifestPath: "/datasets/gtnh/datasets.manifest.json",
    recipeDatasetPath: `/datasets/gtnh/${id}/recipes.json.gz`,
    sourceInfo: { sourceId: "recex" as const, generatedAt: "2026-10-20T00:00:00.000Z" },
  };
}

const both: DatasetManifest = {
  schemaVersion: 1,
  latestStableVersion: "local-2.9.0-rc-2",
  versions: [
    datasetVersion("local-2.8.1", "2.8.1"),
    datasetVersion("local-2.9.0-rc-2", "2.9.0-RC-2"),
    datasetVersion("local-2.8.4", "2.8.4"),
  ],
};
const only29: DatasetManifest = {
  schemaVersion: 1,
  latestStableVersion: "local-2.9.0-rc-2",
  versions: [datasetVersion("local-2.9.0-rc-2", "2.9.0-RC-2")],
};

beforeEach(() => {
  window.localStorage.clear();
  resetNewPlanVersionForTests();
});
afterEach(() => vi.restoreAllMocks());

describe("the version new plans are made for", () => {
  it("is 2.9 with nothing remembered, and the choice once written", () => {
    expect(readNewPlanVersion(both)).toBe("2.9");
    writeNewPlanVersion("2.8.1");
    expect(window.localStorage.getItem(NEW_PLAN_VERSION_STORAGE_KEY)).toBe("2.8.1");
    expect(readNewPlanVersion(both)).toBe("2.8.1");
  });

  it("remembered choice no longer served falls back to the default", () => {
    writeNewPlanVersion("2.8.1");
    expect(readNewPlanVersion(only29)).toBe("2.9");
    // A hidden dataset serves nothing, and neither does a version never served.
    window.localStorage.setItem(NEW_PLAN_VERSION_STORAGE_KEY, "2.8.4");
    expect(readNewPlanVersion(both)).toBe("2.9");
    window.localStorage.setItem(NEW_PLAN_VERSION_STORAGE_KEY, "2.10");
    expect(readNewPlanVersion(both)).toBe("2.9");
    // No manifest yet: nothing is known to be served.
    window.localStorage.setItem(NEW_PLAN_VERSION_STORAGE_KEY, "2.8.1");
    expect(readNewPlanVersion(undefined)).toBe("2.9");
  });

  it("storage that throws reads the default", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readNewPlanVersion(both)).toBe("2.9");
    expect(() => writeNewPlanVersion("2.8.1")).not.toThrow();
  });

  it("a pick storage refuses holds for this page, and still only while served", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    writeNewPlanVersion("2.8.1");
    expect(window.localStorage.getItem(NEW_PLAN_VERSION_STORAGE_KEY)).toBeNull();
    expect(readNewPlanVersion(both)).toBe("2.8.1");
    expect(readNewPlanVersion(only29)).toBe("2.9");
  });
});

describe("the versions this site serves", () => {
  it("lists each family once, the default first, and no hidden one", () => {
    expect(servedGameVersions(both)).toEqual(["2.9", "2.8.1"]);
    expect(servedGameVersions(only29)).toEqual(["2.9"]);
    expect(servedGameVersions(undefined)).toEqual([]);
  });

  it("says what a plan for another version gets", () => {
    expect(unservedPlanText("2.10", servedGameVersions(both))).toBe(
      "This plan is for GTNH 2.10. This site has recipes for GTNH 2.9 and GTNH 2.8.1.",
    );
    expect(recipesNotOnSiteText("2.10")).toBe("Recipes for GTNH 2.10 are not on this site.");
  });
});
