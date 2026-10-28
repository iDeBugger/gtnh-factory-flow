import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIdentity } from "./build-identity.mjs";

const made = [];

/** A folder holding `src/lib/version.ts` at `version`, optionally a git checkout with one commit. */
function checkout(version, { git = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "build-identity-"));
  made.push(dir);
  mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  writeFileSync(
    path.join(dir, "src", "lib", "version.ts"),
    `export const APP_VERSION = "${version}";\n`,
  );
  if (git) {
    const run = (...args) =>
      execFileSync("git", args, {
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
    run("init", "-q");
    run("add", ".");
    run(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "x",
    );
    return { dir, sha: run("rev-parse", "--short=8", "HEAD") };
  }
  return { dir, sha: "" };
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildIdentity", () => {
  it("is the deploy's GTNH_BUILD_ID when set, trimmed", () => {
    const { dir } = checkout("9.9.9", { git: true });
    expect(buildIdentity({ GTNH_BUILD_ID: " 4.4.1-5efe0a3c " }, dir)).toBe("4.4.1-5efe0a3c");
  });

  it("is the version and commit of a clean checkout, with -dirty for an uncommitted change", () => {
    const { dir, sha } = checkout("9.9.9", { git: true });
    expect(sha).toMatch(/^[0-9a-f]{8}$/);
    expect(buildIdentity({ GTNH_BUILD_ID: "" }, dir)).toBe(`9.9.9-${sha}`);
    writeFileSync(
      path.join(dir, "src", "lib", "version.ts"),
      'export const APP_VERSION = "9.9.10";\n',
    );
    expect(buildIdentity({}, dir)).toBe(`9.9.10-${sha}-dirty`);
  });

  it("is the bare version where there is no git", () => {
    const { dir } = checkout("9.9.9");
    expect(buildIdentity({}, dir)).toBe("9.9.9");
  });

  it("is empty with neither a version file nor git", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "build-identity-"));
    made.push(dir);
    expect(buildIdentity({}, dir)).toBe("");
  });
});

describe("the module", () => {
  it("imports Node built-ins only, so the build scripts load it outside a bundle without pulling app code in", () => {
    const source = readFileSync(new URL("./build-identity.mjs", import.meta.url), "utf8");
    const imports = [
      ...source.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm),
    ].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((name) => !name.startsWith("node:"))).toEqual([]);
    expect(source).not.toMatch(/\bimport\(|\brequire\(/);
  });
});
