import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { MOD_PORTS } from "./mod-link/mod-link";
import {
  documentPolicy,
  MOD_LOOPBACK_ORIGINS,
  securityHeaders,
  STRICT_TRANSPORT_SECURITY,
  workerPolicy,
} from "../../security-headers.config";

const production = { production: true };

const directive = (policy: string, name: string) =>
  policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));

describe("the document policy", () => {
  it("is the one string in production", () => {
    expect(documentPolicy(production)).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; media-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
    );
  });

  it("allows eval outside production, in script-src only", () => {
    const dev = documentPolicy({ production: false });
    expect(directive(dev, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval'",
    );
    expect(dev.replace("'unsafe-eval'", "").replace("  ", " ").replace(" ;", ";")).toBe(
      documentPolicy(production),
    );
    expect(documentPolicy(production)).not.toContain("'unsafe-eval'");
  });

  it("adds an absolute live socket origin to connect-src and nothing for a path", () => {
    expect(directive(documentPolicy({ ...production, liveUrl: "ws://localhost:3001/live" }), "connect-src")).toBe(
      "connect-src 'self' ws://localhost:3001",
    );
    expect(directive(documentPolicy({ ...production, liveUrl: "wss://live.example/live" }), "connect-src")).toBe(
      "connect-src 'self' wss://live.example",
    );
    // The site's own socket origin, named for WebKit before CSP3; once only.
    expect(directive(documentPolicy({ ...production, siteUrl: "https://gtnhplanner.com" }), "connect-src")).toBe(
      "connect-src 'self' wss://gtnhplanner.com",
    );
    expect(
      directive(
        documentPolicy({ ...production, siteUrl: "http://localhost:3000/", liveUrl: "ws://localhost:3000/live" }),
        "connect-src",
      ),
    ).toBe("connect-src 'self' ws://localhost:3000");
    for (const siteUrl of ["", "/", "not a url", "ftp://gtnhplanner.com"]) {
      expect(documentPolicy({ ...production, siteUrl })).toBe(documentPolicy(production));
    }
    for (const liveUrl of ["/live", "", "not a url", "https://live.example/live"]) {
      expect(documentPolicy({ ...production, liveUrl })).toBe(documentPolicy(production));
    }
  });
});

describe("the mod's loopback origins", () => {
  it("are in connect-src only when the mod and community switch is on at build", () => {
    const on = directive(documentPolicy({ ...production, modAndCommunity: "on" }), "connect-src");
    expect(on).toBe(
      "connect-src 'self' http://127.0.0.1:25640 http://127.0.0.1:25641 http://127.0.0.1:25642 http://127.0.0.1:25643 http://127.0.0.1:25644 http://127.0.0.1:25645 http://127.0.0.1:25646 http://127.0.0.1:25647 http://127.0.0.1:25648 http://127.0.0.1:25649",
    );
    expect(documentPolicy({ ...production, modAndCommunity: " ON " })).toBe(
      documentPolicy({ ...production, modAndCommunity: "on" }),
    );
    for (const modAndCommunity of [undefined, "", "off", "true", "1"]) {
      expect(documentPolicy({ ...production, modAndCommunity })).toBe(documentPolicy(production));
    }
    expect(documentPolicy(production)).not.toContain("127.0.0.1");
  });

  it("follow the live origins and match the ports the mod link tries", () => {
    expect(
      directive(
        documentPolicy({ ...production, siteUrl: "https://gtnhplanner.com", modAndCommunity: "on" }),
        "connect-src",
      ),
    ).toBe(`connect-src 'self' wss://gtnhplanner.com ${MOD_LOOPBACK_ORIGINS.join(" ")}`);
    expect(MOD_LOOPBACK_ORIGINS).toEqual(MOD_PORTS.map((port) => `http://127.0.0.1:${port}`));
    expect(workerPolicy).not.toContain("127.0.0.1");
  });
});

describe("the header rules", () => {
  it("put the five headers on every path and the worker policy last on the static chunks", () => {
    const rules = securityHeaders(production);
    expect(rules[0]).toEqual({
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: documentPolicy(production) },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY },
      ],
    });
    const policies = rules.filter((rule) => rule.headers.some((h) => h.key === "Content-Security-Policy"));
    expect(policies.at(-1)?.source).toBe("/_next/static/:path*");
    expect(policies.at(-1)?.headers).toEqual([{ key: "Content-Security-Policy", value: workerPolicy }]);
    expect(workerPolicy).toContain("'unsafe-eval'");
    expect(documentPolicy(production)).not.toContain("'unsafe-eval'");
  });

  it("are what next.config.ts serves, ahead of the texture cache rules, with X-Powered-By off", async () => {
    const rules = await nextConfig.headers!();
    const expected = securityHeaders({
      production: process.env.NODE_ENV === "production",
      liveUrl: process.env.NEXT_PUBLIC_LIVE_URL,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
      modAndCommunity: process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY,
    });
    expect(rules.slice(0, 2)).toEqual(expected);
    const textures = rules
      .filter((rule) => rule.source.includes("/textures/"))
      .map((rule) => rule.headers.find((h) => h.key === "Cache-Control")?.value);
    expect(textures).toEqual([
      "public, max-age=31536000, immutable",
      "public, max-age=31536000, immutable",
    ]);
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
