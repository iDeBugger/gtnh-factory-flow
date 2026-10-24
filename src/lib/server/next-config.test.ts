import { afterEach, describe, expect, it, vi } from "vitest";

type Header = { key: string; value: string };
type HeaderRule = { source: string; headers: Header[] };
type Rewrite = { source: string; destination: string };
type Rewrites = { beforeFiles: Rewrite[]; afterFiles: Rewrite[] };

async function loadConfig() {
  vi.resetModules();
  const config = (await import("../../../next.config")).default;
  return {
    headers: (await config.headers?.()) as HeaderRule[],
    rewrites: (await config.rewrites?.()) as Rewrites,
  };
}

const cacheControl = (rule: HeaderRule) =>
  rule.headers.find((header) => header.key === "Cache-Control")?.value;

const DATASET_FILE_REWRITES = [
  {
    source: "/datasets/gtnh/:version/recipes.json",
    destination: "/dataset-files/:version/recipes.json",
  },
  {
    source:
      "/datasets/gtnh/:version/:file(recipes\\.json\\.gz|recipe-index\\.json\\.gz|recipe-lookup-index\\.json\\.gz|resource-index\\.json\\.gz)",
    destination: "/dataset-files/:version/:file",
  },
  {
    source: "/datasets/gtnh/:version/recipes-shards/:file",
    destination: "/dataset-files/:version/recipes-shards/:file",
  },
];

describe("how the served dataset files reach a browser", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends the index gzips, the shards and the raw recipes file to the dataset-files route, ahead of the public files", async () => {
    vi.stubEnv("GTNH_DATASET_BACKEND_URL", "");
    const plain = await loadConfig();
    expect(plain.rewrites.beforeFiles).toEqual(DATASET_FILE_REWRITES);
    expect(plain.rewrites.afterFiles.map((rule) => rule.source)).toContain("/umami");

    // Ahead of the dev proxy too, which then never sees them.
    vi.stubEnv("GTNH_DATASET_BACKEND_URL", "https://example.test/");
    const proxied = await loadConfig();
    expect(proxied.rewrites.beforeFiles.slice(0, 3)).toEqual(DATASET_FILE_REWRITES);
    expect(proxied.rewrites.beforeFiles.slice(3)).toEqual([
      { source: "/api/datasets/:path*", destination: "https://example.test/api/datasets/:path*" },
      { source: "/datasets/gtnh/:path*", destination: "https://example.test/datasets/gtnh/:path*" },
    ]);
  });

  it("sets no cache policy by path for dataset data: a header rule cannot tell a miss from a file", async () => {
    const { headers } = await loadConfig();
    const dataset = headers.filter((rule) => rule.source.startsWith("/datasets/"));
    expect(dataset.length).toBeGreaterThan(0);
    for (const rule of dataset) {
      // Only textures, which are content-named, are immutable; nothing else under
      // /datasets/ has a header rule, the dataset-files route answers for itself.
      expect(rule.source).toContain("/textures/");
      expect(cacheControl(rule)).toBe("public, max-age=31536000, immutable");
    }
  });
});
