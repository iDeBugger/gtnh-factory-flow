import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { PACKS, buildProblems, hasNeiOrder, installBuilt, parseArgs } from "./build-datasets.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-datasets-"));
  dirs.push(dir);
  return dir;
}

/** A built version directory: the files the checks read, nothing else. */
function writeVersion(dir, { order = true, report = { textureHints: { hints: 0 } }, hint = false, marker = "new" } = {}) {
  fs.mkdirSync(path.join(dir, "textures"), { recursive: true });
  fs.writeFileSync(path.join(dir, "recipe-lookup-index.json.gz"), gzipSync("{}"));
  const index = { resourceIndex: [{ id: "a", iconPath: hint ? "asset:gregtech:textures/x.png" : "/x.png" }] };
  if (order) index.resourceOrder = [0];
  fs.writeFileSync(path.join(dir, "resource-index.json.gz"), gzipSync(JSON.stringify(index)));
  if (report) fs.writeFileSync(path.join(dir, "textures", "icon-report.json"), JSON.stringify(report));
  fs.writeFileSync(path.join(dir, "marker.txt"), marker);
  return dir;
}

describe("build-datasets arguments", () => {
  it("takes versions by alias or id, all for both, without repeats", () => {
    expect(parseArgs(["2.8.1"]).packs.map((pack) => pack.id)).toEqual(["local-2.8.1"]);
    expect(parseArgs(["local-2.9.0-rc-2", "2.9"]).packs.map((pack) => pack.id)).toEqual(["local-2.9.0-rc-2"]);
    expect(parseArgs(["all"]).packs).toEqual(PACKS);
    expect(parseArgs(["2.8.1", "all"]).packs.map((pack) => pack.id)).toEqual(["local-2.8.1", "local-2.9.0-rc-2"]);
  });

  it("exports only when asked, and installs into public/datasets/gtnh by default", () => {
    const plain = parseArgs(["2.9"]);
    expect(plain.exportFirst).toBe(false);
    expect(plain.outDir.endsWith(path.join("public", "datasets", "gtnh"))).toBe(true);
    expect(plain.workDir.endsWith(path.join(".pipeline", "datasets"))).toBe(true);
    expect(parseArgs(["--export", "2.9"]).exportFirst).toBe(true);
  });

  it("resolves --out and --work against the working directory", () => {
    const parsed = parseArgs(["all", "--out", "out", "--work", "/tmp/w"], "/home/me");
    expect(parsed.outDir).toBe(path.resolve("/home/me/out"));
    expect(parsed.workDir).toBe(path.resolve("/tmp/w"));
  });

  it("refuses no version, an unknown version or option, a missing directory and one directory for both", () => {
    expect(parseArgs([]).error).toMatch(/Name a version/);
    expect(parseArgs(["2.7"]).error).toMatch(/Unknown version 2.7/);
    expect(parseArgs(["2.9", "--publish"]).error).toMatch(/Unknown option --publish/);
    expect(parseArgs(["2.9", "--out"]).error).toMatch(/--out needs a directory/);
    expect(parseArgs(["2.9", "--work", "--export"]).error).toMatch(/--work needs a directory/);
    expect(parseArgs(["2.9", "--out", "x", "--work", "x"]).error).toMatch(/must differ/);
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

describe("build-datasets install", () => {
  it("installs a build that passes, setting the copy it replaces aside", async () => {
    const root = tempDir();
    const out = path.join(root, "out");
    writeVersion(path.join(out, "local-2.8.1"), { marker: "old" });
    const built = writeVersion(path.join(root, "work", "dataset"));
    const replaced = path.join(root, "work", "replaced");
    const problems = await installBuilt({ builtDir: built, outDir: out, id: "local-2.8.1", replacedDir: replaced });
    expect(problems).toEqual([]);
    expect(fs.readFileSync(path.join(out, "local-2.8.1", "marker.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(replaced, "marker.txt"), "utf8")).toBe("old");
    expect(fs.existsSync(built)).toBe(false);
  });

  it("refuses a build whose icon hints are unresolved and leaves the installed copy alone", async () => {
    const root = tempDir();
    const out = path.join(root, "out");
    writeVersion(path.join(out, "local-2.8.1"), { marker: "old" });
    const built = writeVersion(path.join(root, "dataset"), { hint: true });
    const problems = await installBuilt({
      builtDir: built,
      outDir: out,
      id: "local-2.8.1",
      replacedDir: path.join(root, "replaced"),
    });
    expect(problems.join("\n")).toMatch(/still hold "asset: icon hints: resource-index.json.gz/);
    expect(fs.readFileSync(path.join(out, "local-2.8.1", "marker.txt"), "utf8")).toBe("old");
    expect(fs.existsSync(built)).toBe(true);
  });

  it("refuses a build with no icon report, or one that skipped", async () => {
    const root = tempDir();
    const installed = path.join(root, "out", "local-2.8.1");
    expect((await buildProblems(writeVersion(path.join(root, "a"), { report: null }), installed)).join()).toMatch(
      /icon-report.json is missing/,
    );
    expect(
      (await buildProblems(writeVersion(path.join(root, "b"), { report: { skipped: true, reason: "big" } }), installed)).join(),
    ).toMatch(/says skipped: big/);
  });

  it("refuses a build that would lose the installed copy's NEI order, unless allowed", async () => {
    const root = tempDir();
    const installed = writeVersion(path.join(root, "out", "local-2.9.0-rc-2"));
    const built = writeVersion(path.join(root, "dataset"), { order: false });
    expect(hasNeiOrder(installed)).toBe(true);
    expect(hasNeiOrder(built)).toBe(false);
    expect((await buildProblems(built, installed)).join()).toMatch(/has no NEI order, but the served/);
    expect(await buildProblems(built, installed, { allowLoss: true })).toEqual([]);
  });

  it("installs a build with no NEI order where the installed copy had none either", async () => {
    const root = tempDir();
    const installed = writeVersion(path.join(root, "out", "local-2.8.1"), { order: false });
    const built = writeVersion(path.join(root, "dataset"), { order: false });
    expect(await buildProblems(built, installed)).toEqual([]);
  });

  it("refuses a directory that is not a built dataset", async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "dataset"));
    expect((await buildProblems(path.join(root, "dataset"), path.join(root, "out", "x"))).join()).toMatch(
      /no recipe-lookup-index/,
    );
  });
});
