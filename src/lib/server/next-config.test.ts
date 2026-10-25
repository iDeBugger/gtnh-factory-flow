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

describe("the build identity the config bakes in", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("imports nothing from src/, only self-contained files beside it: next start loads the config again at run time", async () => {
    // A site image that ships no src/ crashes on its first request at a
    // config import it lacks, so the config's own files sit beside it (the
    // deploy's Dockerfile copies them) and import nothing themselves.
    const { readFileSync } = await import("node:fs");
    const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    const importsOf = (source: string) =>
      [...source.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1] ?? "");
    const source = read("next.config.ts");
    const local = importsOf(source).filter((specifier) => /^(\.|@\/)/.test(specifier));
    expect(local.sort()).toEqual(["./body-limits.config", "./security-headers.config"]);
    for (const specifier of local) {
      const module = read(`${specifier.slice(2)}.ts`);
      expect(module, specifier).not.toMatch(/^\s*import\s(?!type\b)/m);
      expect(importsOf(module), specifier).toEqual([]);
    }
    expect(source).not.toMatch(/["']\.\/src\/|["']@\//);
    expect(source).not.toMatch(/require\(\s*["'](\.|@\/)/);
  });

  it("is the deploy's GTNH_BUILD_ID when set", async () => {
    vi.stubEnv("GTNH_BUILD_ID", "4.4.1-5efe0a3c");
    vi.resetModules();
    const config = (await import("../../../next.config")).default;
    expect(config.env?.NEXT_PUBLIC_GTNH_BUILD_ID).toBe("4.4.1-5efe0a3c");
  });

  it("is the version and commit of a checkout otherwise", async () => {
    vi.stubEnv("GTNH_BUILD_ID", "");
    vi.resetModules();
    const config = (await import("../../../next.config")).default;
    expect(config.env?.NEXT_PUBLIC_GTNH_BUILD_ID).toMatch(/^\d+\.\d+\.\d+-[0-9a-f]{8}(-dirty)?$/);
  });
});
