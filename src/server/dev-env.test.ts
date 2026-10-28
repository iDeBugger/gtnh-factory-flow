import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer, isFileLoadingAllowed, type ResolvedConfig, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devListenHost, setDevBuildEnv } from "./dev-env";

const ROOT = path.resolve(__dirname, "../..");

describe("the dev server's environment and exposure", () => {
  it("listens on loopback unless HOSTNAME names an address", () => {
    expect(devListenHost({})).toBe("127.0.0.1");
    expect(devListenHost({ HOSTNAME: "" })).toBe("127.0.0.1");
    expect(devListenHost({ HOSTNAME: "0.0.0.0" })).toBe("0.0.0.0");
  });

  describe("Vite's /@fs/ under vite.config.ts", () => {
    let vite: ViteDevServer;
    let server: http.Server;
    let base: string;
    let cacheDir: string;

    beforeAll(async () => {
      // Its own dependency cache, so a dev server running from this checkout is left alone.
      cacheDir = await mkdtemp(path.join(os.tmpdir(), "dev-exposure-test-"));
      vite = await createServer({
        configFile: path.join(ROOT, "vite.config.ts"),
        mode: "development",
        logLevel: "silent",
        cacheDir,
        appType: "custom",
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      server = http.createServer(vite.middlewares);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }, 30_000);

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    });

    /** The resolved config with its allow list widened to the checkout, so only the deny list refuses. */
    const wholeCheckout = (): ResolvedConfig => ({
      ...vite.config,
      server: { ...vite.config.server, fs: { ...vite.config.server.fs, allow: [ROOT] } },
    });

    const status = async (file: string) => {
      const res = await fetch(`${base}/@fs${path.join(ROOT, file)}`);
      await res.arrayBuffer();
      return res.status;
    };

    it("gives the server the build id and switch that Vite inlines into the browser code", () => {
      const env: NodeJS.ProcessEnv = {};
      setDevBuildEnv(env, vite.config.define);
      const inlined = vite.config.define!;
      expect(env.NEXT_PUBLIC_GTNH_BUILD_ID).toMatch(/\S/);
      expect(JSON.stringify(env.NEXT_PUBLIC_GTNH_BUILD_ID)).toBe(
        inlined["process.env.NEXT_PUBLIC_GTNH_BUILD_ID"],
      );
      expect(JSON.stringify(env.NEXT_PUBLIC_MOD_AND_COMMUNITY)).toBe(
        inlined["process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY"],
      );
      expect(() => setDevBuildEnv({}, {})).toThrow(/defines no NEXT_PUBLIC_GTNH_BUILD_ID/);
    });

    it("serves the browser code", async () => {
      expect(await status("src/client/fonts.css")).toBe(200);
    });

    it.each([
      "package.json",
      "tools/deploy/targets/stage.env.example",
      "db/grants.sql",
      "vite.config.ts",
    ])("refuses %s, outside the browser code", async (file) => {
      expect(await status(file)).toBe(403);
    });

    it.each([
      "tools/deploy/targets/stage.env",
      "scratch/probe.mjs",
      ".superpowers/manager/brief.md",
      "db/migrations/0001.sql",
      ".env.local",
    ])("denies %s by name, even with the whole checkout allowed", (file) => {
      expect(isFileLoadingAllowed(wholeCheckout(), path.join(ROOT, file))).toBe(false);
    });

    it("leaves src/ and node_modules/ outside the deny list", () => {
      expect(
        isFileLoadingAllowed(wholeCheckout(), path.join(ROOT, "src/lib/server/db/index.ts")),
      ).toBe(true);
      expect(
        isFileLoadingAllowed(wholeCheckout(), path.join(ROOT, "node_modules/react/index.js")),
      ).toBe(true);
    });
  });
});
