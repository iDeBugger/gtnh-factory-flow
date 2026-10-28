import { afterEach, describe, expect, it, vi } from "vitest";
import { pickDatasetVersionFor, pickDefaultDatasetVersion } from "./remote";
import type { DatasetManifest } from "./types";

describe("remote dataset selection", () => {
  it("prefers the latest stable dataset over a daily dataset", () => {
    const manifest: DatasetManifest = {
      schemaVersion: 1,
      latestStableVersion: "stable-2.8.4",
      latestDailyVersion: "daily-523",
      versions: [
        datasetVersion("daily-523", "daily"),
        datasetVersion("stable-2.8.4", "stable"),
      ],
    };

    expect(pickDefaultDatasetVersion(manifest)?.id).toBe("stable-2.8.4");
  });
});

describe("DEFAULT_DATASET_MANIFEST_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // The build leaves an unset NEXT_PUBLIC name undefined (tools/build/define.mjs), never "", so the
  // fallback fires.
  it("falls back to the served manifest path when the build names none", async () => {
    vi.stubEnv("NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL", undefined);
    vi.resetModules();
    const { DEFAULT_DATASET_MANIFEST_URL } = await import("./remote");
    expect(DEFAULT_DATASET_MANIFEST_URL).toBe("/datasets/gtnh/datasets.manifest.json");
  });

  it("takes the manifest URL the build names", async () => {
    const named = "https://data.example.test/datasets.manifest.json";
    vi.stubEnv("NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL", named);
    vi.resetModules();
    const { DEFAULT_DATASET_MANIFEST_URL } = await import("./remote");
    expect(DEFAULT_DATASET_MANIFEST_URL).toBe(named);
  });
});

describe("pickDatasetVersionFor", () => {
  it("pickDatasetVersionFor picks the family and never a hidden version", () => {
    const manifest: DatasetManifest = {
      schemaVersion: 1,
      latestStableVersion: "local-2.9.0-rc-2",
      versions: [
        datasetVersion("local-2.9.0-rc-1", "stable", "2.9.0-RC-1", "2026-10-01T00:00:00.000Z"),
        datasetVersion("local-2.9.0-rc-2", "stable", "2.9.0-RC-2", "2026-09-01T00:00:00.000Z"),
        datasetVersion("local-2.8.1", "stable", "2.8.1"),
        datasetVersion("local-2.8.4", "stable", "2.8.4"),
      ],
    };
    // 2.9: the stable version wins even over a newer 2.9 build.
    expect(pickDatasetVersionFor(manifest, "2.9")?.id).toBe("local-2.9.0-rc-2");
    expect(pickDatasetVersionFor(manifest, "2.8.1")?.id).toBe("local-2.8.1");
    // 2.8.4 is listed but hidden: not served.
    expect(pickDatasetVersionFor(manifest, "2.8.4")).toBeUndefined();
    expect(pickDatasetVersionFor(manifest, "2.10")).toBeUndefined();
  });

  it("takes the newest build of a family when the stable version is another family", () => {
    const manifest: DatasetManifest = {
      schemaVersion: 1,
      latestStableVersion: "local-2.8.1",
      versions: [
        datasetVersion("a-2.9", "daily", "2.9.0-beta-2", "2026-08-01T00:00:00.000Z"),
        datasetVersion("b-2.9", "daily", "2.9.0-RC-2", "2026-09-01T00:00:00.000Z"),
        datasetVersion("local-2.8.1", "stable", "2.8.1"),
      ],
    };
    expect(pickDatasetVersionFor(manifest, "2.9")?.id).toBe("b-2.9");
    expect(pickDatasetVersionFor(manifest, "2.8.1")?.id).toBe("local-2.8.1");
  });
});

function datasetVersion(
  id: string,
  channel: "stable" | "daily",
  gtnhVersion = id,
  publishedAt = "2026-05-20T00:00:00.000Z",
) {
  return {
    id,
    gtnhVersion,
    channel,
    publishedAt,
    manifestPath: "/datasets/gtnh/datasets.manifest.json",
    recipeDatasetPath: `/datasets/gtnh/${id}/recipes.json.gz`,
    sourceInfo: {
      sourceId: "recex" as const,
      generatedAt: "2026-05-20T00:00:00.000Z",
    },
  };
}
