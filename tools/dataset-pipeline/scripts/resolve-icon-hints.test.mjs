import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { writeDatasetJson } from "./dataset-json-writer.mjs";
import { hintFileName, parseIconHint, resolveIconHints } from "./resolve-icon-hints.mjs";

const applyTextureIconsPath = fileURLToPath(new URL("./apply-texture-icons.mjs", import.meta.url));
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-hints-"));
  dirs.push(dir);
  return dir;
}

function png(rgba) {
  const image = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < 4; i += 1) image.data.set(rgba, i * 4);
  return PNG.sync.write(image);
}

function sha12(bytes) {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 12);
}

/** A jar (a zip with stored entries) holding `files`, `{ name: bytes }`. */
function writeJar(file, files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...locals, directory, end]));
}

const RADIO = png([192, 255, 192, 255]);
const SUPERBIA = png([150, 20, 150, 255]);
const RADIO_HINT = "asset:gregtech:textures/aspects/RADIO.png";
const SUPERBIA_HINT = "asset:forbidden:textures/aspects/superbia.png";
const TEMPUS_HINT = "asset:magicbees:textures/aspects/tempus.png";

function aspect(tag, iconPath) {
  return { id: `thaumcraft:aspect:${tag}`, kind: "aspect", displayName: tag, iconPath, dominantColor: "#c0ffc0" };
}

async function buildFixture({ jars = true } = {}) {
  const root = tempDir();
  const instance = path.join(root, "instance");
  fs.mkdirSync(path.join(instance, "mods"), { recursive: true });
  if (jars) {
    writeJar(path.join(instance, "mods", "gregtech-5.09.54.205.jar"), {
      "assets/gregtech/textures/aspects/RADIO.png": RADIO,
    });
    // Its case differs from the hint's: the lowercase name still finds it.
    writeJar(path.join(instance, "mods", "1.7.10", "Forbidden.Magic-0.9.17-GTNH.jar"), {
      "assets/forbidden/textures/aspects/Superbia.png": SUPERBIA,
    });
  }
  const outDir = path.join(root, "local-test");
  fs.mkdirSync(outDir, { recursive: true });
  const datasetPath = path.join(outDir, "recipes.json");
  await writeDatasetJson(datasetPath, {
    schemaVersion: 1,
    datasetVersionId: "local-test",
    gtnhVersion: "2.9.0",
    resources: [
      aspect("aer", "/nei/thaumcraft/aspects/aer.png"),
      aspect("radio", RADIO_HINT),
      aspect("superbia", SUPERBIA_HINT),
      aspect("tempus", TEMPUS_HINT),
    ],
    recipes: [
      {
        id: "oracle:thaumcraft:crucible:1",
        inputs: [{ kind: "item", id: "minecraft:stone", amount: 1 }],
        outputs: [{ ...aspect("radio", RADIO_HINT), amount: 4 }],
        nei: { slots: [{ resource: { ...aspect("tempus", TEMPUS_HINT), amount: 1 } }] },
      },
      { id: "oracle:gt:2", inputs: [], outputs: [{ kind: "item", id: "minecraft:glass", amount: 1 }] },
    ],
  });
  return { root, instance, outDir, datasetPath };
}

describe("parseIconHint and hintFileName", () => {
  it("read a hint as its jar entry and name the PNG by mod, file and bytes", () => {
    const hint = parseIconHint(RADIO_HINT);
    expect(hint).toEqual({
      namespace: "gregtech",
      resourcePath: "textures/aspects/RADIO.png",
      entry: "assets/gregtech/textures/aspects/RADIO.png",
    });
    expect(hintFileName(hint, RADIO)).toBe(`gregtech_radio-${sha12(RADIO)}.png`);
    expect(hintFileName(parseIconHint("asset:avaritia:textures/misc/terminus.png"), RADIO)).toMatch(
      /^avaritia_terminus-[0-9a-f]{12}\.png$/,
    );
  });

  it("refuse what is not an asset texture", () => {
    expect(parseIconHint("/nei/thaumcraft/aspects/aer.png")).toBeUndefined();
    expect(parseIconHint("asset:gregtech")).toBeUndefined();
    expect(parseIconHint("asset:gregtech:textures/../../x.png")).toBeUndefined();
    expect(parseIconHint("asset:gregtech:textures/aspects/RADIO.txt")).toBeUndefined();
  });
});

describe("resolveIconHints", () => {
  it("copies each hinted PNG under textures/rendered by content, rewrites every copy and clears what no jar holds", async () => {
    const { instance, outDir, datasetPath } = await buildFixture();
    const before = fs.readFileSync(datasetPath, "utf8").split("\n");

    const report = await resolveIconHints({ modsRoot: instance, datasetPath, outDir, log: () => {} });

    const radioFile = `gregtech_radio-${sha12(RADIO)}.png`;
    const superbiaFile = `forbidden_superbia-${sha12(SUPERBIA)}.png`;
    const rendered = path.join(outDir, "textures", "rendered");
    expect(fs.readdirSync(rendered).sort()).toEqual([superbiaFile, radioFile].sort());
    expect(fs.readFileSync(path.join(rendered, radioFile)).equals(RADIO)).toBe(true);
    expect(fs.existsSync(path.join(outDir, "textures", "aspect"))).toBe(false);

    const text = fs.readFileSync(datasetPath, "utf8");
    expect(text).not.toContain('"asset:');
    const dataset = JSON.parse(text);
    const radioUrl = `/datasets/gtnh/local-test/textures/rendered/${radioFile}`;
    expect(dataset.resources.map((resource) => resource.iconPath)).toEqual([
      "/nei/thaumcraft/aspects/aer.png",
      radioUrl,
      `/datasets/gtnh/local-test/textures/rendered/${superbiaFile}`,
      undefined,
    ]);
    expect(dataset.recipes[0].outputs[0].iconPath).toBe(radioUrl);
    expect("iconPath" in dataset.recipes[0].nei.slots[0].resource).toBe(false);
    expect(dataset.recipes[0].nei.slots[0].resource.dominantColor).toBe("#c0ffc0");

    // Lines without a hint keep their bytes; the layout stays one value per line.
    const after = text.split("\n");
    expect(after).toHaveLength(before.length);
    after.forEach((line, index) => {
      if (!before[index].includes('"asset:')) expect(line).toBe(before[index]);
    });

    expect(report.textureHints).toMatchObject({
      jarCount: 2,
      hints: 3,
      slotsResolved: 3,
      slotsCleared: 2,
      unresolved: [
        {
          hint: TEMPUS_HINT,
          reason: "no jar holds assets/magicbees/ (the mod's jar is missing)",
        },
      ],
    });
    const written = JSON.parse(fs.readFileSync(path.join(outDir, "textures", "icon-report.json"), "utf8"));
    expect(written.skipped).toBeUndefined();
    expect(written.textureHints.resolved.map((entry) => entry.file).sort()).toEqual(
      [radioFile, superbiaFile].sort(),
    );
  });

  it("gives the same names and bytes when run again on the same jars", async () => {
    const first = await buildFixture();
    const second = await buildFixture();
    await resolveIconHints({ modsRoot: first.instance, datasetPath: first.datasetPath, outDir: first.outDir, log: () => {} });
    await resolveIconHints({ modsRoot: second.instance, datasetPath: second.datasetPath, outDir: second.outDir, log: () => {} });
    expect(fs.readFileSync(first.datasetPath, "utf8")).toBe(fs.readFileSync(second.datasetPath, "utf8"));
    // A second pass over a resolved dataset finds nothing left to do.
    const again = await resolveIconHints({ modsRoot: first.instance, datasetPath: first.datasetPath, outDir: first.outDir, log: () => {} });
    expect(again.textureHints.hints).toBe(0);
  });

  it("refuses to clear every hint for want of the mods directory", async () => {
    const { instance, outDir, datasetPath } = await buildFixture({ jars: false });
    const before = fs.readFileSync(datasetPath, "utf8");
    await expect(
      resolveIconHints({ modsRoot: instance, datasetPath, outDir, log: () => {} }),
    ).rejects.toThrow(/No mod jars under/);
    expect(fs.readFileSync(datasetPath, "utf8")).toBe(before);
  });

  it("keeps its report when apply-texture-icons skips a dataset over its size limit", async () => {
    const { instance, outDir, datasetPath } = await buildFixture();
    await resolveIconHints({ modsRoot: instance, datasetPath, outDir, log: () => {} });
    execFileSync("node", [applyTextureIconsPath, instance, datasetPath, outDir], {
      env: { ...process.env, GTNH_TEXTURE_ICON_MAX_DATASET_BYTES: "1" },
      stdio: "pipe",
    });
    const report = JSON.parse(fs.readFileSync(path.join(outDir, "textures", "icon-report.json"), "utf8"));
    expect(report.skipped).toBeUndefined();
    expect(report.textureHints.slotsResolved).toBe(3);
    expect(report.textureMatching.skipped).toBe(true);
  });
});
