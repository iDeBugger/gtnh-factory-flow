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
// the weekly scheduled run repeats the check. Anything the gate cannot read never passes: npm
// that did not run, a report in a shape it does not know, an advisory without a known severity.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];
const ALLOWLIST_MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// An unknown severity ranks as the worst, so a renamed or missing field fails every threshold.
const severityRank = (severity) => {
  const rank = SEVERITY_ORDER.indexOf(severity);
  return rank === -1 ? SEVERITY_ORDER.length - 1 : rank;
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
  // Version 2 is the report npm 7 and later write; without its `vulnerabilities` map nothing was checked.
  const vulnerabilities = report.vulnerabilities;
  if (
    report.auditReportVersion !== 2 ||
    !vulnerabilities ||
    typeof vulnerabilities !== "object" ||
    Array.isArray(vulnerabilities)
  ) {
    return {
      outcome: "fail",
      advisories: [],
      reason: `unrecognised npm audit report (auditReportVersion ${String(report.auditReportVersion)})`,
    };
  }
  const todayDate = toDate(today);
  const thresholdRank = severityRank(threshold);
  const advisories = [];
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
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

/**
 * Runs one `npm audit --json`. `spawnError` names why npm did not run or finish (its spawn error
 * code, such as ENOENT or ENOBUFS, or the signal that ended it); the report is then not trusted.
 */
function runAudit(args) {
  const result = spawnSync("npm", ["audit", "--json", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const spawnError =
    result.error?.code ??
    result.error?.message ??
    (result.status === null ? `signal ${result.signal}` : undefined);
  if (spawnError) {
    return { report: null, spawnError };
  }
  try {
    return { report: JSON.parse(result.stdout) };
  } catch {
    return { report: null };
  }
}

/**
 * Whether `argv1` (the script node was asked to run) is `moduleUrl`: resolved through links and
 * percent-encoded the way Node builds `import.meta.url`, so a path holding `#`, `%` or a link
 * still runs the gate rather than exiting 0 with nothing checked.
 */
export function isEntryScript(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    return false;
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
  if (verdict.reason) {
    console.log(`  ${verdict.reason}`);
  }
  for (const a of verdict.advisories) {
    const mark = a.allowlisted ? " [allowlisted]" : a.expired ? " [allowlist entry expired]" : "";
    console.log(`  [${a.severity}] ${a.ghsa} ${a.package}: ${a.title} (${a.range})${mark}`);
  }
  console.log(
    verdict.advisories.length || verdict.outcome === "fail"
      ? `  ${verdict.outcome.toUpperCase()}`
      : "  no advisories",
  );
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
    const audit = runAudit(pass.args);
    if (audit.spawnError) {
      verdict = {
        outcome: "fail",
        advisories: [],
        reason: `npm audit did not run (${audit.spawnError})`,
      };
    } else {
      try {
        verdict = evaluate({ report: audit.report, allowlist, threshold: pass.threshold, today });
      } catch (error) {
        console.error(error.message);
        process.exit(2);
      }
    }
    printPass(pass.label, verdict);
    if (verdict.outcome === "fail") failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (isEntryScript(process.argv[1], import.meta.url)) {
  main();
}
