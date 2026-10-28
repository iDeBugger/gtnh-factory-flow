import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createServer, resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
/** The lightningcss Vite minifies with, as vite.config.ts loads it. */
const { Features, transform } = createRequire(path.join(ROOT, "node_modules/vite/package.json"))(
  "lightningcss",
) as typeof import("lightningcss");
const PROBE = path.join(ROOT, "src/components/flow/clean/minimap/minimap-engine.ts");

/** The dev server and the build read the same config; only the build may inline NODE_ENV as "production". */
describe("vite.config.ts", () => {
  it("keeps NODE_ENV at development in a dev-server transform", async () => {
    // Its own dependency cache: the shared one belongs to any dev server running from this checkout, which
    // would re-optimize and reload when this test wrote there.
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "vite-config-test-"));
    const server = await createServer({
      configFile: path.join(ROOT, "vite.config.ts"),
      mode: "development",
      logLevel: "silent",
      cacheDir,
      appType: "custom",
      server: { middlewareMode: true, hmr: false, ws: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      expect(server.config.define?.["process.env.NODE_ENV"]).toBe('"development"');
      const result = await server.transformRequest(`/@fs${PROBE}`);
      expect(result?.code).toContain('"development" !== "production"');
      expect(result?.code).not.toContain('"production" !== "production"');
    } finally {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("builds the CSS for Firefox 111 and writes media ranges as min-/max- queries", async () => {
    const config = await resolveConfig(
      { configFile: path.join(ROOT, "vite.config.ts"), logLevel: "silent" },
      "build",
      "production",
    );
    // Module workers set the script floor (Firefox 114); the stylesheet keeps Next's list, Firefox 111.
    expect(config.build.target).toEqual(["chrome111", "edge111", "firefox114", "safari16.4"]);
    expect(config.build.cssTarget).toEqual(["chrome111", "edge111", "firefox111", "safari16.4"]);
    const include = config.css.lightningcss?.include ?? 0;
    expect(include & Features.MediaRangeSyntax).toBe(Features.MediaRangeSyntax);
    // What the flag does to the minified CSS: a range query comes out as min-width.
    const { code } = transform({
      filename: "probe.css",
      code: Buffer.from("@media (width >= 600px) { a { color: red } }"),
      minify: true,
      include,
    });
    expect(code.toString()).toContain("(min-width:600px)");
  });
});
