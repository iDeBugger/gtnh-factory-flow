import path from "node:path";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const PROBE = path.join(ROOT, "src/components/flow/clean/minimap/minimap-engine.ts");

/** The dev server and the build read the same config; only the build may inline NODE_ENV as "production". */
describe("vite.config.ts", () => {
  it("keeps NODE_ENV at development in a dev-server transform", async () => {
    const server = await createServer({
      configFile: path.join(ROOT, "vite.config.ts"),
      mode: "development",
      logLevel: "silent",
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
    }
  }, 30_000);
});
