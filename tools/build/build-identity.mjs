import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The build's identity, baked into the server and browser bundles alike: the
 * dataset answers' cache key (`src/lib/datasets/answer-version.ts`), so two
 * builds that share an APP_VERSION never share a cached answer. The deploy
 * passes `GTNH_BUILD_ID` (`<version>-<sha8>`, the same value its image labels
 * and `/api/version` report; a build from `git archive` has no git to ask); a
 * checkout builds `<version>-<sha8>`, with `-dirty` for uncommitted changes.
 * A deploy must do one of the two: with neither, the id falls back to the
 * bare APP_VERSION, and two deploys under one version share year-immutable
 * answer URLs.
 *
 * The version is read as text from `<cwd>/src/lib/version.ts`, never imported,
 * and this module imports only Node built-ins: the build scripts load it
 * outside a bundle, where an import of app code would pull the
 * app in with it.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [cwd]
 * @returns {string}
 */
export function buildIdentity(env = process.env, cwd = process.cwd()) {
  const configured = env.GTNH_BUILD_ID?.trim();
  if (configured) {
    return configured;
  }
  const version = readAppVersion(cwd);
  const sha = git(["rev-parse", "--short=8", "HEAD"], cwd);
  if (!sha) {
    return version;
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], cwd) ? "-dirty" : "";
  return `${version}-${sha}${dirty}`;
}

/** @param {string} cwd */
function readAppVersion(cwd) {
  try {
    const source = readFileSync(path.join(cwd, "src", "lib", "version.ts"), "utf8");
    return /APP_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1] ?? "";
  } catch {
    return "";
  }
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
