// The CI dependency audit gate: `npm audit` with an allowlist and a severity threshold.
//
// Two passes. The production tree (`--omit=dev`) must be clean at moderate: everything in it
// ships to the droplet and the browser. The whole tree is held to high: test, lint and build
// tooling never ships, but a hostile dependency can still act during `npm ci` or a build.
// `npm audit` has no allowlist of its own, and a third-party gate would run an unlocked package
// on every pull request, so this script has no dependencies.
//
// An allowlisted advisory needs a reason and an expiry at most 90 days out. An expired entry
// stops counting, so a deferral that ran out turns the gate red by itself.
//
// A registry outage (no JSON, or an `error` key such as ENOAUDIT) skips the pass with a warning
// rather than failing it: the audit endpoint being down must not block unrelated pull requests;
// the weekly scheduled run repeats the check.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];
const ALLOWLIST_MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const severityRank = (severity) => {
  const rank = SEVERITY_ORDER.indexOf(severity);
  return rank === -1 ? 0 : rank;
};

const toDate = (value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Checks the allowlist's shape. Every entry needs a reason and an expiry no more than 90 days after
 * today; an expiry already in the past is allowed (it is reported as expired by `evaluate`).
 * Throws with the offending GHSA id.
 */
export function validateAllowlist(allowlist, today) {
  const entries = allowlist?.advisories ?? {};
  const todayDate = toDate(today);
  for (const [id, entry] of Object.entries(entries)) {
    const reason = typeof entry?.reason === "string" ? entry.reason.trim() : "";
    const expires = typeof entry?.expires === "string" ? toDate(entry.expires) : null;
    const withinWindow =
      expires && expires.getTime() - todayDate.getTime() <= ALLOWLIST_MAX_DAYS * DAY_MS;
    if (!reason || !expires || !withinWindow) {
      throw new Error(
        `allowlist entry ${id} needs a reason and an expiry within ${ALLOWLIST_MAX_DAYS} days`,
      );
    }
  }
  return entries;
}

/**
 * Turns one `npm audit --json` report into a verdict.
 *
 * @param {object} options
 * @param {object} options.report      parsed `npm audit --json` output
 * @param {object} options.allowlist   parsed tools/audit-allowlist.json
 * @param {string} options.threshold   lowest severity that fails the pass
 * @param {string} options.today       ISO date (YYYY-MM-DD)
 * @returns {{ outcome: "pass" | "fail" | "skipped", advisories: object[], reason?: string }}
 */
export function evaluate({ report, allowlist, threshold, today }) {
  if (!report || typeof report !== "object" || report.error) {
    return { outcome: "skipped", advisories: [], reason: report?.error?.code ?? "no report" };
  }
  const entries = validateAllowlist(allowlist, today);
  const todayDate = toDate(today);
  const thresholdRank = severityRank(threshold);
  const advisories = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // A string entry points at another vulnerable package; that package reports its own advisories.
      if (typeof via !== "object" || via === null) continue;
      const ghsa =
        typeof via.url === "string" ? via.url.split("/").pop() : String(via.source ?? "");
      const entry = entries[ghsa];
      const matches = entry && (!entry.package || entry.package === name);
      const expired = Boolean(matches && toDate(entry.expires).getTime() < todayDate.getTime());
      advisories.push({
        ghsa,
        severity: via.severity,
        package: name,
        title: via.title,
        range: via.range,
        allowlisted: Boolean(matches && !expired),
        expired,
      });
    }
  }
  const failing = advisories.filter(
    (a) => !a.allowlisted && severityRank(a.severity) >= thresholdRank,
  );
  return { outcome: failing.length ? "fail" : "pass", advisories };
}

function runAudit(args) {
  const result = spawnSync("npm", ["audit", "--json", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function printPass(label, verdict) {
  console.log(`\n${label}`);
  if (verdict.outcome === "skipped") {
    console.log(
      `::warning::npm audit could not reach the registry; audit gate skipped (${verdict.reason})`,
    );
    return;
  }
  for (const a of verdict.advisories) {
    const mark = a.allowlisted ? " [allowlisted]" : a.expired ? " [allowlist entry expired]" : "";
    console.log(`  [${a.severity}] ${a.ghsa} ${a.package}: ${a.title} (${a.range})${mark}`);
  }
  console.log(verdict.advisories.length ? `  ${verdict.outcome.toUpperCase()}` : "  no advisories");
}

function main() {
  const allowlistPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "audit-allowlist.json",
  );
  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const passes = [
    {
      label: "Production dependencies (threshold: moderate)",
      args: ["--omit=dev"],
      threshold: "moderate",
    },
    { label: "All dependencies (threshold: high)", args: [], threshold: "high" },
  ];
  let failed = false;
  for (const pass of passes) {
    let verdict;
    try {
      verdict = evaluate({
        report: runAudit(pass.args),
        allowlist,
        threshold: pass.threshold,
        today,
      });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    printPass(pass.label, verdict);
    if (verdict.outcome === "fail") failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  main();
}
