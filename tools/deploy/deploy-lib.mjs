#!/usr/bin/env node
// The deploy's checks that are easier in JavaScript than in bash, as functions
// (tested in deploy-lib.test.mjs) and as a CLI for deploy.sh and
// publish-datasets.sh:
//
//   node deploy-lib.mjs build-id                       <version>-<sha8> of HEAD
//   node deploy-lib.mjs wait <url> <version> <build> [timeout s]
//   node deploy-lib.mjs same <file a> <file b>         exit 0 when the bytes match
//   node deploy-lib.mjs icons <version dir>            exit 0 when its icon hints were resolved
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

/** APP_VERSION as `src/lib/version.ts` writes it. */
export function readAppVersion(source) {
  const match = /APP_VERSION\s*=\s*"([^"]+)"/.exec(source);
  if (!match) {
    throw new Error("No APP_VERSION in version.ts.");
  }
  return match[1];
}

/** The build's identity, as next.config.ts and the image labels carry it. */
export function buildId(version, sha) {
  if (!/^[0-9a-f]{8,40}$/.test(sha)) {
    throw new Error("Not a commit id.");
  }
  return `${version}-${sha.slice(0, 8)}`;
}

/**
 * Resolves once `url` (a site's /api/version) answers this version AND this
 * build; rejects after the timeout with the last answer or error seen. Only
 * the build tells two deploys of one APP_VERSION apart, so a matching version
 * alone never passes.
 */
export async function waitForBuild(url, expected, options) {
  const send = options.fetch ?? fetch;
  const until = Date.now() + options.timeoutMs;
  let last = "no answer";
  for (;;) {
    try {
      const response = await send(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.version === expected.version && body?.build === expected.build) {
          return;
        }
        last = `version ${body?.version ?? "?"}, build ${body?.build || "?"}`;
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= until) {
      throw new Error(
        `${url} never named build ${expected.build} (version ${expected.version}); last answer: ${last}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}

/** True when the two texts are the same bytes. */
export function sameFile(a, b) {
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  return digest(a) === digest(b);
}

const ASSET_HINT = Buffer.from('"asset:');

/** True when the stream's bytes hold `"asset:`, across chunk boundaries too. */
async function streamHoldsHint(stream) {
  let tail = Buffer.alloc(0);
  for await (const chunk of stream) {
    const window = Buffer.concat([tail, chunk]);
    if (window.includes(ASSET_HINT)) {
      stream.destroy();
      return true;
    }
    tail = window.subarray(Math.max(0, window.length - (ASSET_HINT.length - 1)));
  }
  return false;
}

function publishedDataFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full);
    if (entry.isDirectory()) {
      // Textures are pictures; the icon report among them is read on its own.
      if (relative !== "textures") files.push(...publishedDataFiles(full, base));
    } else if (entry.isFile() && relative !== "recipes.json" && /\.(json|gz)$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files.sort();
}

/**
 * Why a built dataset version must not be published for its icons, or [] when it may. The
 * export's `asset:<mod>:textures/...` hints are resolved from the mod jars by
 * resolve-icon-hints.mjs, which writes textures/icon-report.json; a version with no report,
 * a report that says `skipped`, or a published file still holding `"asset:` shipped the hints,
 * and the app draws `?` for each one. The raw recipes.json is never published, so not read.
 */
export async function datasetIconProblems(versionDir) {
  const problems = [];
  let report;
  try {
    report = JSON.parse(readFileSync(path.join(versionDir, "textures", "icon-report.json"), "utf8"));
  } catch {
    problems.push("textures/icon-report.json is missing or unreadable: resolve-icon-hints.mjs did not run.");
  }
  if (report?.skipped === true) {
    problems.push(`textures/icon-report.json says skipped: ${report.reason ?? "no reason given"}`);
  } else if (report && !report.textureHints) {
    problems.push("textures/icon-report.json has no textureHints: resolve-icon-hints.mjs did not run.");
  }
  const holding = [];
  for (const file of publishedDataFiles(versionDir)) {
    const raw = createReadStream(path.join(versionDir, file));
    if (await streamHoldsHint(file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw)) {
      raw.destroy();
      holding.push(file);
    }
  }
  if (holding.length > 0) {
    const shown = holding.slice(0, 5).join(", ");
    problems.push(
      `${holding.length} file(s) still hold "asset: icon hints: ${shown}${holding.length > 5 ? ", ..." : ""}`,
    );
  }
  return problems;
}

/**
 * The publish check on NEI's item order (`resourceOrder` in resource-index.json.gz): a version
 * that would lose the order the server already serves is refused, since its item list would
 * silently fall back to the approximation (GTNH_ALLOW_NO_NEI_ORDER=1 publishes it anyway); one
 * that never had it is published with a loud warning.
 */
export function neiOrderVerdict(id, { local, served, allowLoss = false }) {
  if (local) {
    return { ok: true, message: `${id}: NEI order present` };
  }
  if (served && !allowLoss) {
    return {
      ok: false,
      message: `${id} has no NEI order, but the served ${id} has one: the rebuild lost it (export the client phase again, or GTNH_ALLOW_NO_NEI_ORDER=1).`,
    };
  }
  return {
    ok: true,
    message: `WARNING: ${id} has NO NEI order: its item list sorts As in NEI by the approximation.`,
  };
}

async function main([command, ...args]) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (command === "build-id") {
    const version = readAppVersion(
      execFileSync("git", ["-C", root, "show", "HEAD:src/lib/version.ts"], { encoding: "utf8" }),
    );
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    console.log(buildId(version, sha));
    return 0;
  }
  if (command === "wait") {
    const [url, version, build, seconds = "300"] = args;
    try {
      await waitForBuild(
        url,
        { version, build },
        { timeoutMs: Number(seconds) * 1000, intervalMs: 3000 },
      );
      console.log(`${url}: version ${version}, build ${build}`);
      return 0;
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }
  if (command === "same") {
    const [a, b] = args;
    return sameFile(readFileSync(a), readFileSync(b)) ? 0 : 1;
  }
  if (command === "icons") {
    const [versionDir] = args;
    const problems = await datasetIconProblems(versionDir);
    for (const problem of problems) {
      console.error(`${path.basename(versionDir)}: ${problem}`);
    }
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "nei-order") {
    const [id, local, served] = args;
    const verdict = neiOrderVerdict(id, {
      local: local === "1",
      served: served === "1",
      allowLoss: process.env.GTNH_ALLOW_NO_NEI_ORDER === "1",
    });
    (verdict.ok ? console.log : console.error)(verdict.message);
    return verdict.ok ? 0 : 1;
  }
  console.error(
    "Usage: deploy-lib.mjs build-id | wait <url> <version> <build> [seconds] | same <a> <b> | icons <dir> | nei-order <id> <local 0|1> <served 0|1>",
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main(process.argv.slice(2)));
}
