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

const RAW_RECIPES_BLOCK = {
  source: "/datasets/gtnh/:version/recipes.json",
  destination: "/datasets/gtnh/:version/recipes.json.raw",
};

describe("how the served dataset files are cached", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps shards and the index gzips a day, never immutable: they are replaced in place", async () => {
    const { headers } = await loadConfig();
    const shards = headers.find(
      (rule) => rule.source === "/datasets/gtnh/:version/recipes-shards/:file",
    );
    expect(shards && cacheControl(shards)).toBe("public, max-age=86400");

    const gzips = headers.find((rule) => /recipes\\\.json\\\.gz/.test(rule.source));
    expect(gzips?.source).toContain("recipe-lookup-index\\.json\\.gz");
    expect(gzips?.source).toContain("resource-index\\.json\\.gz");
    expect(gzips && cacheControl(gzips)).toBe("public, max-age=86400");

    for (const rule of headers) {
      if (rule.source.startsWith("/datasets/") && !rule.source.includes("/textures/")) {
        expect(cacheControl(rule)).not.toContain("immutable");
      }
    }
  });

  it("blocks the raw recipes file before public files", async () => {
    vi.stubEnv("GTNH_DATASET_BACKEND_URL", "");
    const plain = await loadConfig();
    expect(plain.rewrites.beforeFiles[0]).toEqual(RAW_RECIPES_BLOCK);
    expect(plain.rewrites.afterFiles.map((rule) => rule.source)).toContain("/umami");

    // Ahead of the dev proxy too, or the proxy would forward the download.
    vi.stubEnv("GTNH_DATASET_BACKEND_URL", "https://example.test/");
    const proxied = await loadConfig();
    expect(proxied.rewrites.beforeFiles[0]).toEqual(RAW_RECIPES_BLOCK);
    expect(proxied.rewrites.beforeFiles.slice(1)).toEqual([
      { source: "/api/datasets/:path*", destination: "https://example.test/api/datasets/:path*" },
      { source: "/datasets/gtnh/:path*", destination: "https://example.test/datasets/gtnh/:path*" },
    ]);
  });
});
