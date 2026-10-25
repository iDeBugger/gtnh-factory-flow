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

describe("how the served dataset files reach a browser", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rewrites nothing of the datasets itself: the gate is the proxy, the dev backend proxy stays", async () => {
    // A rewrite matches the path as sent and is bypassed by percent-encoding;
    // src/proxy.ts gates the data files on the decoded path instead.
    vi.stubEnv("GTNH_DATASET_BACKEND_URL", "");
    const plain = await loadConfig();
    expect(plain.rewrites.beforeFiles).toEqual([]);
    expect(plain.rewrites.afterFiles.map((rule) => rule.source)).toContain("/umami");

    vi.stubEnv("GTNH_DATASET_BACKEND_URL", "https://example.test/");
    const proxied = await loadConfig();
    expect(proxied.rewrites.beforeFiles).toEqual([
      // The version segment is a published name's characters, so an encoded `..%2f` there is never forwarded.
      {
        source: "/api/datasets/:version([A-Za-z0-9._-]+)/:rest*",
        destination: "https://example.test/api/datasets/:version/:rest*",
      },
      {
        source: "/datasets/gtnh/:version([A-Za-z0-9._-]+)/:rest*",
        destination: "https://example.test/datasets/gtnh/:version/:rest*",
      },
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
