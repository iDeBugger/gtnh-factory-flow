// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  NEW_PLAN_VERSION_STORAGE_KEY,
  OPEN_PLAN_VERSION_STORAGE_KEY,
  bootWaitsForPlans,
  newPlanVersionNeedsManifest,
  readNewPlanVersion,
  readOpenPlanVersion,
  resetNewPlanVersionForTests,
  recipesNotOnSiteText,
  servedGameVersions,
  unservedPlanText,
  writeNewPlanVersion,
  useOpenPlanVersionHint,
  writeOpenPlanVersion,
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
// A refused write leaves the page's own choice in module state: clear it after each test as well as before, so
// no test hands its pick to the next one.
afterEach(() => {
  vi.restoreAllMocks();
  resetNewPlanVersionForTests();
  window.localStorage.clear();
});

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

  it("only a remembered choice other than 2.9 waits on the manifest (the first-run seed)", () => {
    expect(newPlanVersionNeedsManifest()).toBe(false);
    writeNewPlanVersion("2.9");
    expect(newPlanVersionNeedsManifest()).toBe(false);
    writeNewPlanVersion("2.8.1");
    expect(newPlanVersionNeedsManifest()).toBe(true);
  });

  it("boot waits for the stored plans only when the last open plan, or else the new-plan choice, is not 2.9", () => {
    expect(bootWaitsForPlans()).toBe(false);
    writeNewPlanVersion("2.8.1");
    expect(bootWaitsForPlans()).toBe(true);
    // The plan open last decides once known: a 2.9 plan open with a 2.8.1 choice loads 2.9 at once.
    writeOpenPlanVersion("2.9");
    expect(bootWaitsForPlans()).toBe(false);
    writeOpenPlanVersion("2.8.1");
    expect(bootWaitsForPlans()).toBe(true);
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

  it("a refused pick wins over an older stored choice", () => {
    window.localStorage.setItem(NEW_PLAN_VERSION_STORAGE_KEY, "2.8.1");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    writeNewPlanVersion("2.9");
    expect(window.localStorage.getItem(NEW_PLAN_VERSION_STORAGE_KEY)).toBe("2.8.1");
    expect(readNewPlanVersion(both)).toBe("2.9");
  });
});

describe("the open plan's version, the next boot's hint", () => {
  const stored = () => window.localStorage.getItem(OPEN_PLAN_VERSION_STORAGE_KEY);

  it("is written once the stored plans are in and a stored plan is open, with that plan's version", () => {
    const { rerender } = renderHook(
      ({ hydrated, active, version }: { hydrated: boolean; active: string | undefined; version: string }) =>
        useOpenPlanVersionHint(hydrated, active, version),
      { initialProps: { hydrated: false, active: "plan-a" as string | undefined, version: "2.8.1" } },
    );
    expect(stored()).toBeNull();
    // Hydrated with no stored plan open (the empty starting one): still nothing.
    rerender({ hydrated: true, active: undefined, version: "2.8.1" });
    expect(stored()).toBeNull();
    rerender({ hydrated: true, active: "plan-a", version: "2.8.1" });
    expect(stored()).toBe("2.8.1");
  });

  it("is rewritten when the open plan changes version, and left alone when it does not", () => {
    const { rerender } = renderHook(
      ({ active, version }: { active: string; version: string }) => useOpenPlanVersionHint(true, active, version),
      { initialProps: { active: "plan-a", version: "2.8.1" } },
    );
    expect(stored()).toBe("2.8.1");
    // Another tab on the other version.
    rerender({ active: "plan-b", version: "2.9" });
    expect(stored()).toBe("2.9");
    // The open plan's version changes.
    rerender({ active: "plan-b", version: "2.8.1" });
    expect(stored()).toBe("2.8.1");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    rerender({ active: "plan-c", version: "2.8.1" });
    expect(setItem).not.toHaveBeenCalled();
    expect(stored()).toBe("2.8.1");
  });

  it("reads a missing, blank or garbage value as no hint, so the new-plan choice decides", () => {
    expect(readOpenPlanVersion()).toBeUndefined();
    writeNewPlanVersion("2.8.1");
    for (const garbage of ["", "   ", "banana", "{\"v\":1}", "2.9; drop", "undefined"]) {
      window.localStorage.setItem(OPEN_PLAN_VERSION_STORAGE_KEY, garbage);
      expect(readOpenPlanVersion()).toBeUndefined();
      expect(bootWaitsForPlans()).toBe(true);
    }
    writeNewPlanVersion("2.9");
    window.localStorage.setItem(OPEN_PLAN_VERSION_STORAGE_KEY, "banana");
    expect(bootWaitsForPlans()).toBe(false);
    window.localStorage.setItem(OPEN_PLAN_VERSION_STORAGE_KEY, " 2.8.1 ");
    expect(readOpenPlanVersion()).toBe("2.8.1");
    expect(bootWaitsForPlans()).toBe(true);
  });

  it("a write storage refuses does not throw, and storage that cannot be read gives no hint", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => writeOpenPlanVersion("2.8.1")).not.toThrow();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readOpenPlanVersion()).toBeUndefined();
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
