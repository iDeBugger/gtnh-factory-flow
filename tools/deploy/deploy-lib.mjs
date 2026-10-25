#!/usr/bin/env node
// The deploy's checks that are easier in JavaScript than in bash, as functions
// (tested in deploy-lib.test.mjs) and as a CLI for deploy.sh and
// publish-datasets.sh:
//
//   node deploy-lib.mjs build-id                       <version>-<sha8> of HEAD
//   node deploy-lib.mjs wait <url> <version> <build> [timeout s]
//   node deploy-lib.mjs same <file a> <file b>         exit 0 when the bytes match
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
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
  console.error(
    "Usage: deploy-lib.mjs build-id | wait <url> <version> <build> [seconds] | same <a> <b>",
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main(process.argv.slice(2)));
}
