import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import {
  documentPolicy,
  securityHeaders,
  STRICT_TRANSPORT_SECURITY,
  workerPolicy,
} from "./security-headers";

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
    for (const liveUrl of ["/live", "", "not a url", "https://live.example/live"]) {
      expect(documentPolicy({ ...production, liveUrl })).toBe(documentPolicy(production));
    }
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
