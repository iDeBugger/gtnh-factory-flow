import { describe, expect, test } from "vitest";
import { evaluate } from "./audit-gate.mjs";

const today = "2026-06-15";
const daysFromToday = (days) => new Date(Date.UTC(2026, 5, 15 + days)).toISOString().slice(0, 10);

const advisory = (overrides = {}) => ({
  source: 1,
  name: "next",
  dependency: "next",
  title: "Something bad",
  url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  severity: "high",
  range: ">=16.0.0 <16.4.1",
  ...overrides,
});

const report = (vulnerabilities) => ({ auditReportVersion: 2, vulnerabilities, metadata: {} });
const noAllowlist = { advisories: {} };

describe("audit gate", () => {
  test("fails on a high advisory above the threshold", () => {
    const verdict = evaluate({
      report: report({ next: { severity: "high", via: [advisory()] } }),
      allowlist: noAllowlist,
      threshold: "moderate",
      today,
    });
    expect(verdict.outcome).toBe("fail");
    expect(verdict.advisories).toHaveLength(1);
    expect(verdict.advisories[0]).toMatchObject({
      ghsa: "GHSA-aaaa-bbbb-cccc",
      package: "next",
      allowlisted: false,
    });
  });

  test("passes when the advisory is allowlisted and not expired", () => {
    const verdict = evaluate({
      report: report({ next: { severity: "high", via: [advisory()] } }),
      allowlist: {
        advisories: {
          "GHSA-aaaa-bbbb-cccc": { reason: "Not reachable.", expires: daysFromToday(30) },
        },
      },
      threshold: "moderate",
      today,
    });
    expect(verdict.outcome).toBe("pass");
    expect(verdict.advisories[0].allowlisted).toBe(true);
  });

  test("an expired allowlist entry no longer counts", () => {
    const verdict = evaluate({
      report: report({ next: { severity: "high", via: [advisory()] } }),
      allowlist: {
        advisories: {
          "GHSA-aaaa-bbbb-cccc": { reason: "Not reachable.", expires: daysFromToday(-1) },
        },
      },
      threshold: "moderate",
      today,
    });
    expect(verdict.outcome).toBe("fail");
    expect(verdict.advisories[0]).toMatchObject({ allowlisted: false, expired: true });
  });

  test("rejects an allowlist entry without a reason or with an expiry over 90 days out", () => {
    const run = (entry) =>
      evaluate({
        report: report({}),
        allowlist: { advisories: { "GHSA-aaaa-bbbb-cccc": entry } },
        threshold: "moderate",
        today,
      });
    expect(() => run({ expires: daysFromToday(30) })).toThrow(/GHSA-aaaa-bbbb-cccc/);
    expect(() => run({ reason: "x", expires: daysFromToday(91) })).toThrow(/GHSA-aaaa-bbbb-cccc/);
    expect(() => run({ reason: "x" })).toThrow(/GHSA-aaaa-bbbb-cccc/);
    expect(run({ reason: "x", expires: daysFromToday(90) }).outcome).toBe("pass");
  });

  test("ignores advisories below the threshold", () => {
    const verdict = evaluate({
      report: report({ next: { severity: "moderate", via: [advisory({ severity: "moderate" })] } }),
      allowlist: noAllowlist,
      threshold: "high",
      today,
    });
    expect(verdict.outcome).toBe("pass");
    expect(verdict.advisories).toHaveLength(1);
  });

  test('skips "via another package" strings', () => {
    const verdict = evaluate({
      report: report({ next: { severity: "high", via: ["postcss"] } }),
      allowlist: noAllowlist,
      threshold: "moderate",
      today,
    });
    expect(verdict.outcome).toBe("pass");
    expect(verdict.advisories).toHaveLength(0);
  });

  test("a package-scoped entry only covers that package", () => {
    const verdict = evaluate({
      report: report({
        next: { severity: "high", via: [advisory()] },
        sharp: { severity: "high", via: [advisory({ name: "sharp", dependency: "sharp" })] },
      }),
      allowlist: {
        advisories: {
          "GHSA-aaaa-bbbb-cccc": {
            package: "next",
            reason: "Not reachable.",
            expires: daysFromToday(30),
          },
        },
      },
      threshold: "moderate",
      today,
    });
    expect(verdict.outcome).toBe("fail");
    expect(verdict.advisories.find((a) => a.package === "next").allowlisted).toBe(true);
    expect(verdict.advisories.find((a) => a.package === "sharp").allowlisted).toBe(false);
  });

  test("registry errors skip the pass", () => {
    const verdict = evaluate({
      report: {
        error: {
          code: "ENOAUDIT",
          summary: "Your configured registry does not support audit requests.",
        },
      },
      allowlist: noAllowlist,
      threshold: "moderate",
      today,
    });
    expect(verdict.outcome).toBe("skipped");
    expect(
      evaluate({ report: null, allowlist: noAllowlist, threshold: "moderate", today }).outcome,
    ).toBe("skipped");
  });
});
