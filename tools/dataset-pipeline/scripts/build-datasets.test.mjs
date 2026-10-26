import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { PACKS, buildProblems, ensurePackZip, hasNeiOrder, installBuilt, main, neiListStatus, parseArgs } from "./build-datasets.mjs";
import { createHash } from "node:crypto";

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
    expect(parseArgs(["2.9", "--fresh-icons"]).error).toMatch(/needs --export/);
    expect(parseArgs(["2.9", "--export", "--fresh-icons"]).freshIcons).toBe(true);
    expect(parseArgs(["both"]).error).toMatch(/Unknown version both/);
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

  it("keeps the rendered textures the replaced copy has and the build lacks, as a publish does", async () => {
    const root = tempDir();
    const out = path.join(root, "out");
    const old = writeVersion(path.join(out, "local-2.8.1"), { marker: "old" });
    fs.mkdirSync(path.join(old, "textures", "rendered"));
    fs.writeFileSync(path.join(old, "textures", "rendered", "hammer-aaaaaaaaaaaa.png"), "old hammer");
    fs.writeFileSync(path.join(old, "textures", "rendered", "stone-bbbbbbbbbbbb.png"), "stone");
    const built = writeVersion(path.join(root, "dataset"));
    fs.mkdirSync(path.join(built, "textures", "rendered"));
    fs.writeFileSync(path.join(built, "textures", "rendered", "hammer-cccccccccccc.png"), "new hammer");
    fs.writeFileSync(path.join(built, "textures", "rendered", "stone-bbbbbbbbbbbb.png"), "stone");
    const problems = await installBuilt({ builtDir: built, outDir: out, id: "local-2.8.1", replacedDir: path.join(root, "replaced") });
    expect(problems).toEqual([]);
    expect(fs.readdirSync(path.join(out, "local-2.8.1", "textures", "rendered")).sort()).toEqual([
      "hammer-aaaaaaaaaaaa.png",
      "hammer-cccccccccccc.png",
      "stone-bbbbbbbbbbbb.png",
    ]);
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

/**
 * A stand-in for Docker and node: the export writes a raw export (or fails, per pack), the build
 * writes a dataset that passes the checks, and every call is recorded.
 */
function fakeRun(workDir, { failExport = [], neiStatus = {} } = {}) {
  const calls = [];
  const env = (args, key) => args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
  const host = (containerPath) => path.join(workDir, containerPath.replace(/^\/work\/?/, ""));
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command !== "docker" || args[0] !== "run") return;
    const id = env(args, "GTNH_DATASET_VERSION_ID");
    if (args.includes("tools/dataset-pipeline/scripts/run-gtnh-oracle-export.sh")) {
      if (failExport.includes(id)) throw new Error(`docker run exited with 1 (${id})`);
      const raw = host(env(args, "GTNH_RAW_EXPORT_DIR"));
      fs.mkdirSync(raw, { recursive: true });
      fs.writeFileSync(
        path.join(raw, "oracle-export.json"),
        JSON.stringify({ marker: "new", neiItemList: { status: neiStatus[id] ?? "exported", stacks: [] } }),
      );
      fs.mkdirSync(host(env(args, "GTNH_DATASET_OUT_DIR")), { recursive: true });
    } else if (args.includes("tools/dataset-pipeline/scripts/rebuild-dataset.sh")) {
      writeVersion(path.join(host(env(args, "GTNH_BUILD_DIR")), "dataset"));
    }
  };
  run.ensurePackZip = async (pack) => path.join(workDir, "cache", "pack", `${pack.id}-client.zip`);
  return { run, calls };
}

function rawMarker(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).marker;
}

describe("build-datasets main", () => {
  const quiet = () => {
    const saved = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = () => {};
    return () => ([console.log, console.error, console.warn] = saved);
  };

  it("exits 2 on bad arguments and runs nothing", async () => {
    const restore = quiet();
    const { run, calls } = fakeRun(tempDir());
    try {
      expect(await main(["2.7"], { run })).toBe(2);
    } finally {
      restore();
    }
    expect(calls).toEqual([]);
  });

  it("goes on past a failed export, installs the other pack and rebuilds the manifest", async () => {
    const root = tempDir();
    const work = path.join(root, "work");
    const out = path.join(root, "out");
    const raw29 = path.join(work, "local-2.9.0-rc-2", "raw-export");
    fs.mkdirSync(raw29, { recursive: true });
    fs.writeFileSync(path.join(raw29, "oracle-export.json"), JSON.stringify({ marker: "last good" }));
    const { run, calls } = fakeRun(work, { failExport: ["local-2.9.0-rc-2"] });
    const restore = quiet();
    let code;
    try {
      code = await main(["all", "--export", "--out", out, "--work", work], { run });
    } finally {
      restore();
    }
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(out, "local-2.8.1", "recipe-lookup-index.json.gz"))).toBe(true);
    expect(fs.existsSync(path.join(out, "local-2.9.0-rc-2"))).toBe(false);
    // The failed export left the last good one where it was.
    expect(rawMarker(path.join(raw29, "oracle-export.json"))).toBe("last good");
    expect(calls.filter((call) => call.includes("rebuild-manifest.mjs"))).toHaveLength(1);
    expect(calls.filter((call) => call.includes("refresh-power-maps.mjs"))).toEqual([
      `node tools/dataset-pipeline/scripts/refresh-power-maps.mjs ${path.join(out, "local-2.8.1")}`,
    ]);
  });

  it("keeps the last good export as raw-export.previous after a good one", async () => {
    const root = tempDir();
    const work = path.join(root, "work");
    const raw = path.join(work, "local-2.8.1", "raw-export");
    fs.mkdirSync(raw, { recursive: true });
    fs.writeFileSync(path.join(raw, "oracle-export.json"), JSON.stringify({ marker: "old" }));
    const { run } = fakeRun(work);
    const restore = quiet();
    try {
      expect(await main(["2.8.1", "--export", "--out", path.join(root, "out"), "--work", work], { run })).toBe(0);
    } finally {
      restore();
    }
    expect(rawMarker(path.join(raw, "oracle-export.json"))).toBe("new");
    expect(rawMarker(path.join(`${raw}.previous`, "oracle-export.json"))).toBe("old");
    expect(fs.existsSync(`${raw}.new`)).toBe(false);
  });

  it("refuses an export whose NEI list failed unless told to carry the order, and then rebuilds no manifest", async () => {
    const root = tempDir();
    const work = path.join(root, "work");
    const out = path.join(root, "out");
    const restore = quiet();
    try {
      const refused = fakeRun(work, { neiStatus: { "local-2.8.1": "failed" } });
      expect(await main(["2.8.1", "--export", "--out", out, "--work", work], { run: refused.run })).toBe(1);
      expect(fs.existsSync(path.join(out, "local-2.8.1"))).toBe(false);
      expect(refused.calls.some((call) => call.includes("rebuild-manifest.mjs"))).toBe(false);
      const carried = fakeRun(work, { neiStatus: { "local-2.8.1": "failed" } });
      expect(
        await main(["2.8.1", "--export", "--carry-nei-order", "--out", out, "--work", work], { run: carried.run }),
      ).toBe(0);
      expect(fs.existsSync(path.join(out, "local-2.8.1"))).toBe(true);
    } finally {
      restore();
    }
  });

  it("rebuilds without an export only from a raw export it has", async () => {
    const root = tempDir();
    const { run } = fakeRun(path.join(root, "work"));
    const restore = quiet();
    try {
      expect(await main(["2.9", "--out", path.join(root, "out"), "--work", path.join(root, "work")], { run })).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("build-datasets pack zips and export checks", () => {
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const pack = (text) => ({ id: "local-test", clientZipUrl: "https://example.invalid/pack.zip", sha256: sha(text) });
  const fetchOf = (text, counter) => async () => {
    counter.calls += 1;
    return new Response(text);
  };

  it("downloads from the table's URL and keeps the zip only when it hashes to the pin", async () => {
    const work = tempDir();
    const counter = { calls: 0 };
    const zip = await ensurePackZip(pack("the pack"), work, { fetchImpl: fetchOf("the pack", counter) });
    expect(fs.readFileSync(zip, "utf8")).toBe("the pack");
    // A cached zip with the pinned bytes is used as it is.
    await ensurePackZip(pack("the pack"), work, { fetchImpl: fetchOf("the pack", counter) });
    expect(counter.calls).toBe(1);
  });

  it("refuses a download whose bytes are not the pinned ones, and replaces a cached zip that changed", async () => {
    const work = tempDir();
    const counter = { calls: 0 };
    await expect(ensurePackZip(pack("the pack"), work, { fetchImpl: fetchOf("another pack", counter) })).rejects.toThrow(
      /not the pinned/,
    );
    expect(fs.existsSync(path.join(work, "cache", "pack", "local-test-client.zip"))).toBe(false);
    fs.mkdirSync(path.join(work, "cache", "pack"), { recursive: true });
    fs.writeFileSync(path.join(work, "cache", "pack", "local-test-client.zip"), "tampered");
    const zip = await ensurePackZip(pack("the pack"), work, { fetchImpl: fetchOf("the pack", counter) });
    expect(fs.readFileSync(zip, "utf8")).toBe("the pack");
  });

  it("pins a SHA-256 for every pack", () => {
    for (const entry of PACKS) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads the NEI list's status from the end of a raw export", async () => {
    const dir = tempDir();
    const file = path.join(dir, "oracle-export.json");
    fs.writeFileSync(file, `{"domains":[${"0,".repeat(1000)}0],"neiItemList":{"status":"failed","error":"x"}}`);
    expect(await neiListStatus(file)).toBe("failed");
    fs.writeFileSync(file, `{"domains":[]}`);
    expect(await neiListStatus(file)).toBe("absent");
  });
});
