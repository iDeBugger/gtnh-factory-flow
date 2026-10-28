import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { datasetBackendPath } from "./middleware/dataset-backend";
import { call, listen, type Listening } from "./test-support/serve";

/**
 * The development server's dataset backend: which paths it forwards and which it refuses, as Next's three
 * `beforeFiles` rewrites decided, and the forwarding itself against a stub backend.
 */

describe("which paths go to the dataset backend", () => {
  it("forwards the API, the public dataset files and the content-named textures, as Next's rewrites did", () => {
    const forwarded: [string, string][] = [
      ["/api/datasets/local-2.9.0-rc-2/catalog", "/api/datasets/local-2.9.0-rc-2/catalog"],
      [
        "/api/datasets/local-2.9.0-rc-2/recipes/oracle%3Agregtech%3Abw-fuels%3A4f56",
        "/api/datasets/local-2.9.0-rc-2/recipes/oracle%3Agregtech%3Abw-fuels%3A4f56",
      ],
      [
        "/api/datasets/local-2.9.0-rc-2/recipes/oracle:gregtech:x",
        "/api/datasets/local-2.9.0-rc-2/recipes/oracle:gregtech:x",
      ],
      ["/api/datasets/local-2.9.0-rc-2", "/api/datasets/local-2.9.0-rc-2"],
      [
        "/datasets/gtnh/local-2.8.1/textures/rendered/x-0123456789ab.png",
        "/datasets/gtnh/local-2.8.1/textures/rendered/x-0123456789ab.png",
      ],
      [
        "/dataset-files/local-2.8.1/textures/rendered/x-0123456789ab.png",
        "/datasets/gtnh/local-2.8.1/textures/rendered/x-0123456789ab.png",
      ],
      [
        "/dataset-files/local-2.8.1/textures/icons/x-0123456789ab.png",
        "/datasets/gtnh/local-2.8.1/textures/icons/x-0123456789ab.png",
      ],
      // Next's rewrite rules match their fixed words in any case; the destination is written in its own.
      ["/API/Datasets/v/catalog", "/api/datasets/v/catalog"],
      ["/DATASETS/gtnh/v/oracle", "/datasets/gtnh/v/oracle"],
    ];
    for (const [from, to] of forwarded) expect(datasetBackendPath(from), from).toBe(to);
  });

  it("keeps every dot segment, plain or encoded, and the data files local", () => {
    for (const kept of [
      "/api/datasets/../x",
      "/api/datasets/v/../x",
      "/api/datasets/v/%2e%2e/x",
      "/api/datasets/./x",
      "/api/datasets",
      "/datasets/gtnh/../x",
      "/datasets/gtnh/v/../x",
      "/datasets/gtnh/v/%2e%2e",
      "/datasets/gtnh/v/.hidden",
      "/datasets/gtnh",
      "/dataset-files/local-2.8.1/recipes.json.gz",
      "/dataset-files/local-2.8.1/textures/rendered/..",
      "/dataset-files/local-2.8.1/textures/atlas/x.png",
      "/dataset-files/local-2.8.1/textures/rendered/deeper/x.png",
      "/api/version",
      "/",
    ]) {
      expect(datasetBackendPath(kept), kept).toBeUndefined();
    }
  });
});

describe("forwarding to the dataset backend", () => {
  const SITE = "http://127.0.0.1:3770";
  let backend: http.Server;
  let backendPort: number;
  let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] =
    [];
  let app: Listening;

  beforeAll(async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
    vi.spyOn(console, "error").mockImplementation(() => {});
    backend = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        if (req.url?.includes("fail")) {
          req.socket.destroy();
          return;
        }
        res.writeHead(201, {
          "content-type": "application/json",
          "x-backend": "yes",
          "set-cookie": ["a=1", "b=2"],
          connection: "keep-alive, x-private",
          "x-private": "hop",
        });
        res.end('{"from":"backend"}');
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    backendPort = (backend.address() as AddressInfo).port;
    app = await listen(
      createApp({
        env: { production: true, siteUrl: SITE },
        publicDir: "/nonexistent",
        datasetsDir: "/nonexistent",
        datasetBackendUrl: `http://127.0.0.1:${backendPort}//`,
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("forwards the method, path, query, headers and body, and streams the answer back", async () => {
    seen = [];
    const answer = await call(
      app.port,
      "POST",
      "/api/datasets/v/resolve-recipes?x=1&y",
      { host: "site.example", "content-type": "application/json", "x-client": "c" },
      '{"recipes":[]}',
    );
    expect(answer.status).toBe(201);
    expect(answer.body.toString()).toBe('{"from":"backend"}');
    const names = answer.headers.map(([name]) => name);
    expect(answer.headers).toContainEqual(["x-backend", "yes"]);
    expect(answer.headers.filter(([name]) => name === "set-cookie")).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    expect(names).not.toContain("x-private");
    const [request] = seen;
    expect(request).toMatchObject({
      method: "POST",
      url: "/api/datasets/v/resolve-recipes?x=1&y",
      body: '{"recipes":[]}',
    });
    expect(request!.headers.host).toBe(`127.0.0.1:${backendPort}`);
    expect(request!.headers["x-forwarded-host"]).toBe("site.example");
    expect(request!.headers["x-client"]).toBe("c");
  });

  it("forwards a content-named texture after the gate has sent it to the dataset-files path", async () => {
    seen = [];
    await call(app.port, "GET", "/datasets/gtnh/v/textures/rendered/x-0123456789ab.png");
    expect(seen.map((request) => request.url)).toEqual([
      "/datasets/gtnh/v/textures/rendered/x-0123456789ab.png",
    ]);
  });

  it("keeps the data files and every other path local", async () => {
    seen = [];
    expect((await call(app.port, "GET", "/datasets/gtnh/v/recipes.json")).status).toBe(400);
    expect((await call(app.port, "GET", "/api/version")).status).toBe(200);
    expect(seen).toEqual([]);
  });

  it("answers Next's proxy error when the backend fails", async () => {
    const answer = await call(app.port, "GET", "/api/datasets/v/fail");
    expect(answer.status).toBe(500);
    expect(answer.body.toString()).toBe("Internal Server Error");
  });
});
