import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
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
});
