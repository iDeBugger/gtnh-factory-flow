import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { evaluate, isEntryScript } from "./audit-gate.mjs";

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

  test("a report it does not know fails rather than passing", () => {
    for (const unknown of [
      { auditReportVersion: 2, metadata: {} },
      { auditReportVersion: 2, vulnerabilities: [] },
      { auditReportVersion: 3, vulnerabilities: {} },
      { vulnerabilities: {} },
    ]) {
      const verdict = evaluate({
        report: unknown,
        allowlist: noAllowlist,
        threshold: "high",
        today,
      });
      expect(verdict.outcome).toBe("fail");
      expect(verdict.reason).toMatch(/unrecognised/);
    }
    expect(
      evaluate({ report: report({}), allowlist: noAllowlist, threshold: "high", today }).outcome,
    ).toBe("pass");
  });

  test("an advisory without a known severity fails every threshold", () => {
    for (const severity of [undefined, "", "severe"]) {
      const verdict = evaluate({
        report: report({ next: { severity: "high", via: [advisory({ severity })] } }),
        allowlist: noAllowlist,
        threshold: "critical",
        today,
      });
      expect(verdict.outcome).toBe("fail");
    }
  });
});

describe("the gate's entry check", () => {
  const gate = fileURLToPath(new URL("./audit-gate.mjs", import.meta.url));
  const gateUrl = pathToFileURL(gate).href;

  test("matches through a link and from a path holding # % ? or a space", () => {
    // Node's import.meta.url is the resolved path, percent-encoded; tmpdir may itself be a link.
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "audit-gate-")));
    try {
      const odd = path.join(dir, "a #b %20c ?d");
      mkdirSync(odd);
      const script = path.join(odd, "gate.mjs");
      writeFileSync(script, "");
      const scriptUrl = pathToFileURL(script).href;
      expect(scriptUrl).toContain("%23");
      expect(isEntryScript(script, scriptUrl)).toBe(true);
      const link = path.join(dir, "linked.mjs");
      symlinkSync(script, link);
      expect(isEntryScript(link, scriptUrl)).toBe(true);
      expect(isEntryScript(gate, gateUrl)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not run it for another script or none", () => {
    expect(isEntryScript(undefined, gateUrl)).toBe(false);
    expect(isEntryScript(fileURLToPath(import.meta.url), gateUrl)).toBe(false);
    expect(isEntryScript("/no/such/file.mjs", gateUrl)).toBe(false);
  });
});
