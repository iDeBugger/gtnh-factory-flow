import { describe, expect, it } from "vitest";
import { isCrossSiteWrite } from "./cross-site";

/** A request as Caddy hands it on: the site's Host, whatever the browser sent. */
function request(method: string, headers: Record<string, string>, host = "gtnhplanner.com") {
  const all = new Headers({ host, ...headers });
  return { method, headers: all };
}

describe("a cross-site write", () => {
  it("is a write from another site, a subdomain or a look-alike host", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(isCrossSiteWrite(request(method, { origin: "https://evil.example" })), method).toBe(
        true,
      );
    }
    expect(
      isCrossSiteWrite(request("POST", { origin: "https://gtnhplanner.com.evil.example" })),
    ).toBe(true);
    expect(isCrossSiteWrite(request("POST", { origin: "https://new.gtnhplanner.com" }))).toBe(true);
  });

  it("is a write the browser marks cross-site, and one whose Origin does not parse", () => {
    expect(isCrossSiteWrite(request("POST", { "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossSiteWrite(request("POST", { origin: "not a url" }))).toBe(true);
    expect(isCrossSiteWrite(request("POST", { origin: "null" }))).toBe(true);
  });

  it("is not a write from the site itself, in any case, nor one with no Origin", () => {
    expect(
      isCrossSiteWrite(
        request("POST", { origin: "https://gtnhplanner.com", "sec-fetch-site": "same-origin" }),
      ),
    ).toBe(false);
    expect(isCrossSiteWrite(request("POST", { origin: "HTTPS://GTNHPLANNER.COM" }))).toBe(false);
    expect(isCrossSiteWrite(request("POST", {}))).toBe(false);
    expect(
      isCrossSiteWrite(request("POST", { origin: "http://localhost:3000" }, "localhost:3000")),
    ).toBe(false);
  });

  it("is never a read, whatever its Origin", () => {
    expect(isCrossSiteWrite(request("GET", { origin: "https://evil.example" }))).toBe(false);
    expect(isCrossSiteWrite(request("HEAD", { origin: "https://evil.example" }))).toBe(false);
    expect(
      isCrossSiteWrite(
        request("OPTIONS", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
  });
});
