import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
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
    expect(proxy(request("POST", { origin: "https://gtnhplanner.com.evil.example" })).status).toBe(403);
    expect(proxy(request("POST", { origin: "https://new.gtnhplanner.com" })).status).toBe(403);
  });

  it("refuses a write the browser marks cross-site, and an Origin that does not parse", () => {
    expect(proxy(request("POST", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(proxy(request("POST", { origin: "not a url" })).status).toBe(403);
    expect(proxy(request("POST", { origin: "null" })).status).toBe(403);
  });

  it("passes a write from the site itself, and one with no Origin", () => {
    const sameSite = proxy(request("POST", { origin: "https://gtnhplanner.com", "sec-fetch-site": "same-origin" }));
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
    expect(proxy(request("OPTIONS", { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(
      200,
    );
  });

  it("guards the API routes only", () => {
    expect(config.matcher).toEqual(["/api/:path*"]);
  });
});
