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

    vi.stubEnv("GTNH_DATASET_BACKEND_URL", "https://example.test/");
    const proxied = await loadConfig();
    expect(proxied.rewrites.beforeFiles).toEqual([
      {
        source: "/api/datasets/:version([A-Za-z0-9_-][A-Za-z0-9._-]*)/:rest([^/.%][^/]*)*",
        destination: "https://example.test/api/datasets/:version/:rest*",
      },
      {
        source:
          "/datasets/gtnh/:version([A-Za-z0-9_-][A-Za-z0-9._-]*)/:rest([A-Za-z0-9_-][A-Za-z0-9._-]*)*",
        destination: "https://example.test/datasets/gtnh/:version/:rest*",
      },
      {
        source:
          "/dataset-files/:version([A-Za-z0-9_-][A-Za-z0-9._-]*)/textures/:root(rendered|icons)/:file([A-Za-z0-9_-][A-Za-z0-9._-]*)",
        destination: "https://example.test/datasets/gtnh/:version/textures/:root/:file",
      },
    ]);
    // No dot segment, plain or encoded, is ever forwarded; a recipe id with `:` is.
    // Next's own matcher for custom routes (no type declarations ship with it).
    const { pathToRegexp } = (await import(
      // @ts-expect-error untyped compiled module
      "next/dist/compiled/path-to-regexp"
    )) as { pathToRegexp: (source: string, keys: unknown[]) => RegExp };
    const [api, files, textures] = proxied.rewrites.beforeFiles.map((rule) =>
      pathToRegexp(rule.source, []),
    );
    // The proxy's rewrite of a content-named texture still reaches the backend; the data files do not.
    expect(textures!.test("/dataset-files/local-2.8.1/textures/rendered/x-0123456789ab.png")).toBe(true);
    expect(textures!.test("/dataset-files/local-2.8.1/recipes.json.gz")).toBe(false);
    expect(textures!.test("/dataset-files/local-2.8.1/textures/rendered/..")).toBe(false);
    for (const forwarded of [
      "/api/datasets/local-2.9.0-rc-2/catalog",
      "/api/datasets/local-2.9.0-rc-2/recipes/oracle%3Agregtech%3Abw-fuels%3A4f56",
      "/api/datasets/local-2.9.0-rc-2/recipes/oracle:gregtech:x",
    ]) {
      expect(api!.test(forwarded), forwarded).toBe(true);
    }
    for (const kept of [
      "/api/datasets/../x",
      "/api/datasets/v/../x",
      "/api/datasets/v/%2e%2e/x",
      "/api/datasets/./x",
    ]) {
      expect(api!.test(kept), kept).toBe(false);
    }
    expect(files!.test("/datasets/gtnh/local-2.8.1/textures/rendered/x-0123456789ab.png")).toBe(
      true,
    );
    for (const kept of [
      "/datasets/gtnh/../x",
      "/datasets/gtnh/v/../x",
      "/datasets/gtnh/v/%2e%2e",
      "/datasets/gtnh/v/.hidden",
    ]) {
      expect(files!.test(kept), kept).toBe(false);
    }
  });

  it("sets no cache policy by path under the datasets: a header rule cannot tell a miss from a file", async () => {
    // A next.config rule beats the answer's own Cache-Control, so a texture asked for before its
    // publish lands would be a 404 kept a year. The dataset-files route answers for itself.
    const { headers } = await loadConfig();
    const dataset = headers.filter(
      (rule) => rule.source.startsWith("/datasets/") || rule.source.startsWith("/dataset-files/"),
    );
    expect(dataset).toEqual([]);
    for (const rule of headers) {
      expect(cacheControl(rule), rule.source).toBeUndefined();
    }
  });
});

describe("the build identity the config bakes in", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("imports nothing from src/, only self-contained files beside it: next start loads the config again at run time", async () => {
    // `next start` and the tests load the config outside a build, where an
    // import of app code would pull the app into it; the config's own files
    // sit beside it and import nothing themselves.
    const { readFileSync } = await import("node:fs");
    const read = (file: string) =>
      readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    const importsOf = (source: string) =>
      [...source.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)].map(
        (match) => match[1] ?? "",
      );
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

describe("the site's rewrites", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("has no analytics rewrites", async () => {
    for (const backend of ["", "https://example.test/"]) {
      vi.stubEnv("GTNH_DATASET_BACKEND_URL", backend);
      const { rewrites } = await loadConfig();
      for (const rule of [...rewrites.beforeFiles, ...rewrites.afterFiles]) {
        expect(`${rule.source} ${rule.destination}`).not.toMatch(/umami|8582/i);
      }
      expect(rewrites.afterFiles).toEqual([]);
    }
  });

  it("keeps revalidated pages in memory: the site image's .next is read-only", async () => {
    vi.resetModules();
    const config = (await import("../../../next.config")).default;
    expect(config.experimental?.isrFlushToDisk).toBe(false);
  });

  it("builds the standalone server the site image runs", async () => {
    // The Dockerfile copies .next/standalone and runs its server.js.
    vi.resetModules();
    const config = (await import("../../../next.config")).default;
    expect(config.output).toBe("standalone");
  });
});
