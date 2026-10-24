import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { BLUEPRINT_BODY_MAX_BYTES } from "@/lib/blueprints/types";
import {
  BOARD_IMAGE_MAX_BYTES,
  COMMUNITY_UPLOAD_BODY_MAX_BYTES,
  UPLOAD_FORM_OVERHEAD_BYTES,
} from "@/lib/community/types";
import { RESOLVE_RECIPES_MAX_BYTES } from "@/lib/datasets/resolve-recipes-limits";
import { FEEDBACK_MAX_BYTES } from "@/lib/server/feedback";
import {
  COMMENT_BODY_MAX_BYTES,
  PROXY_BODY_MAX_BYTES,
  SMALL_JSON_MAX_BYTES,
} from "@/lib/server/request-body";
import { config, proxy } from "./proxy";

/** A request as Caddy hands it on: the site's Host, whatever the browser sent as Origin. */
function request(method: string, headers: Record<string, string>): NextRequest {
  return new NextRequest("https://gtnhplanner.com/api/community/auth/logout", {
    method,
    headers: { host: "gtnhplanner.com", ...headers },
  });
}

describe("the API proxy", () => {
  it("refuses a write from another site, and says so", async () => {
    const answer = proxy(request("POST", { origin: "https://evil.example" }));
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ error: "Cross-site request refused." });
    expect(proxy(request("PUT", { origin: "https://evil.example" })).status).toBe(403);
    expect(proxy(request("DELETE", { origin: "https://evil.example" })).status).toBe(403);
    expect(proxy(request("POST", { origin: "https://gtnhplanner.com.evil.example" })).status).toBe(
      403,
    );
    expect(proxy(request("POST", { origin: "https://new.gtnhplanner.com" })).status).toBe(403);
  });

  it("refuses a write the browser marks cross-site, and an Origin that does not parse", () => {
    expect(proxy(request("POST", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(proxy(request("POST", { origin: "not a url" })).status).toBe(403);
    expect(proxy(request("POST", { origin: "null" })).status).toBe(403);
  });

  it("passes a write from the site itself, and one with no Origin", () => {
    const sameSite = proxy(
      request("POST", { origin: "https://gtnhplanner.com", "sec-fetch-site": "same-origin" }),
    );
    expect(sameSite.status).toBe(200);
    expect(sameSite.headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("POST", { origin: "HTTPS://GTNHPLANNER.COM" })).status).toBe(200);
    expect(proxy(request("POST", {})).status).toBe(200);
    expect(
      proxy(
        new NextRequest("http://localhost:3000/api/feedback", {
          method: "POST",
          headers: { host: "localhost:3000", origin: "http://localhost:3000" },
        }),
      ).status,
    ).toBe(200);
  });

  it("lets reads through whatever their Origin", () => {
    expect(proxy(request("GET", { origin: "https://evil.example" })).status).toBe(200);
    expect(proxy(request("HEAD", { origin: "https://evil.example" })).status).toBe(200);
    expect(
      proxy(request("OPTIONS", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(200);
  });

  it("checks cross-site writes on the API only, and runs on every path but the framework's", () => {
    expect(config.matcher).toEqual(["/((?!_next/).*)"]);
    const page = new NextRequest("https://gtnhplanner.com/plans", {
      method: "POST",
      headers: { host: "gtnhplanner.com", origin: "https://evil.example" },
    });
    expect(proxy(page).status).toBe(200);
  });
});

describe("the dataset gate in the proxy", () => {
  const V = "local-2.9.0-rc-2";
  const get = (pathname: string) =>
    proxy(
      new NextRequest(`https://gtnhplanner.com${pathname}`, {
        headers: { host: "gtnhplanner.com" },
      }),
    );

  it("refuses an encoded dataset path before any file is looked up", async () => {
    for (const pathname of [
      `/datasets/gtnh/${V}/recipes%2Ejson`,
      `/datasets/gtnh/${V}/%72ecipes.json`,
      `/datasets/gtnh/${V}%2Frecipes.json`,
      `/datasets/gtnh/${V}/recipes%252Ejson`,
      `/%64atasets/gtnh/${V}/recipes.json.gz`,
      `/datasets/gtnh/${V}/recipes-shards%2Fshard-0000.json.gz`,
    ]) {
      const answer = get(pathname);
      expect(answer.status, pathname).toBe(400);
      expect(answer.headers.get("Cache-Control")).toBe("no-store");
      expect(await answer.json()).toEqual({ error: "Invalid dataset path." });
    }
  });

  it("rewrites the index gzips, the shards, the client files and the raw recipes file to the dataset-files route", () => {
    const gz = get(`/datasets/gtnh/${V}/recipes.json.gz`);
    expect(gz.headers.get("x-middleware-rewrite")).toBe(
      `https://gtnhplanner.com/dataset-files/${V}/recipes.json.gz`,
    );
    const shard = get(`/datasets/gtnh/${V}/recipes-shards/shard-0001.json.gz`);
    expect(shard.headers.get("x-middleware-rewrite")).toBe(
      `https://gtnhplanner.com/dataset-files/${V}/recipes-shards/shard-0001.json.gz`,
    );
    const client = get(`/datasets/gtnh/${V}/client/crops.0123456789abcdef0123.json`);
    expect(client.headers.get("x-middleware-rewrite")).toBe(
      `https://gtnhplanner.com/dataset-files/${V}/client/crops.0123456789abcdef0123.json`,
    );
    const raw = get(`/datasets/gtnh/${V}/recipes.json`);
    expect(raw.headers.get("x-middleware-rewrite")).toBe(
      `https://gtnhplanner.com/dataset-files/${V}/recipes.json`,
    );
  });

  it("passes textures, the manifest and the rest of the site", () => {
    for (const pathname of [
      `/datasets/gtnh/${V}/textures/rendered/copper-a50d21cdeb41.png`,
      "/datasets/gtnh/datasets.manifest.json",
      "/",
      "/plans",
    ]) {
      const answer = get(pathname);
      expect(answer.status, pathname).toBe(200);
      expect(answer.headers.get("x-middleware-next")).toBe("1");
    }
  });
});

describe("what Next holds of a write body while the proxy runs", () => {
  it("sits above every route's cap, so a body Next cut at it still answers 413", () => {
    for (const cap of [
      FEEDBACK_MAX_BYTES,
      COMMUNITY_UPLOAD_BODY_MAX_BYTES,
      BOARD_IMAGE_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES,
      BLUEPRINT_BODY_MAX_BYTES,
      RESOLVE_RECIPES_MAX_BYTES,
      COMMENT_BODY_MAX_BYTES,
      SMALL_JSON_MAX_BYTES,
    ]) {
      expect(PROXY_BODY_MAX_BYTES).toBeGreaterThan(cap);
    }
    expect(PROXY_BODY_MAX_BYTES).toBeLessThan(10 * 1024 * 1024);
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(PROXY_BODY_MAX_BYTES);
  });
});
