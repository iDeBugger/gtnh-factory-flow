import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { contentAddressedName, stageRenderedIcons } from "./stage-rendered-icons.mjs";

const normalizerPath = fileURLToPath(new URL("./normalize-oracle-export.mjs", import.meta.url));
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-icons-"));
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

const RED = png([200, 20, 20, 255]);
const BLUE = png([20, 20, 200, 255]);

describe("contentAddressedName", () => {
  it("swaps the export's key hash for the bytes' hash and keeps the name's length", () => {
    const name = contentAddressedName("iron_ingot-0123456789ab.png", RED);
    expect(name).toBe(`iron_ingot-${sha12(RED)}.png`);
    expect(name).toHaveLength("iron_ingot-0123456789ab.png".length);
  });

  it("changes the name when the bytes change, and only then", () => {
    const file = "chest-0123456789ab.png";
    expect(contentAddressedName(file, RED)).toBe(contentAddressedName(file, Buffer.from(RED)));
    expect(contentAddressedName(file, RED)).not.toBe(contentAddressedName(file, BLUE));
  });

  it("appends a hash to a name that has none", () => {
    expect(contentAddressedName("plain.png", RED)).toBe(`plain-${sha12(RED)}.png`);
  });
});

describe("stageRenderedIcons", () => {
  it("writes each icon under its content name and one file for identical pixels", async () => {
    const source = tempDir();
    const target = tempDir();
    fs.writeFileSync(path.join(source, "stick-aaaaaaaaaaaa.png"), RED);
    fs.writeFileSync(path.join(source, "stick-bbbbbbbbbbbb.png"), RED);
    fs.writeFileSync(path.join(source, "stick-cccccccccccc.png"), BLUE);
    const files = ["stick-aaaaaaaaaaaa.png", "stick-bbbbbbbbbbbb.png", "stick-cccccccccccc.png"];
    const { names, colors } = await stageRenderedIcons(files, source, target, 2);
    expect(names).toEqual([`stick-${sha12(RED)}.png`, `stick-${sha12(RED)}.png`, `stick-${sha12(BLUE)}.png`]);
    expect(fs.readdirSync(target).sort()).toEqual([...new Set(names)].sort());
    expect(fs.readFileSync(path.join(target, names[2]))).toEqual(BLUE);
    expect(colors).toHaveLength(3);
  });
});

describe("the normalizer's rendered icon paths", () => {
  function normalizeWithIcons(iconBytes) {
    const dir = tempDir();
    const iconDir = path.join(dir, "rendered-icons");
    fs.mkdirSync(iconDir);
    fs.writeFileSync(path.join(iconDir, "sand-0123456789ab.png"), iconBytes);
    fs.writeFileSync(path.join(iconDir, "glass-ba9876543210.png"), BLUE);
    const raw = {
      domains: [
        {
          id: "smelting",
          recipes: [
            {
              id: "smelt",
              input: { kind: "item", id: "minecraft:sand", amount: 1, displayName: "Sand", icon: "sand-0123456789ab.png" },
              output: { kind: "item", id: "minecraft:glass", amount: 1, displayName: "Glass", icon: "glass-ba9876543210.png" },
            },
          ],
        },
      ],
    };
    const input = path.join(dir, "oracle-export.json");
    const out = path.join(dir, "dataset");
    fs.mkdirSync(out);
    fs.writeFileSync(input, JSON.stringify(raw));
    execFileSync(process.execPath, [normalizerPath, input, path.join(out, "recipes.json")], {
      env: {
        ...process.env,
        GTNH_DATASET_VERSION_ID: "test-fixture",
        GTNH_DATASET_VERSION_LABEL: "test",
        GTNH_RENDERED_ICON_DIR: iconDir,
        GTNH_ICON_STAGE_THREADS: "1",
      },
      stdio: "pipe",
    });
    const dataset = JSON.parse(fs.readFileSync(path.join(out, "recipes.json"), "utf8"));
    const iconOf = (id) => dataset.resources.find((resource) => resource.id === id)?.iconPath;
    return { out, sand: iconOf("minecraft:sand"), glass: iconOf("minecraft:glass") };
  }

  it("point at content-addressed files that exist, and move when the pixels change", () => {
    const before = normalizeWithIcons(RED);
    expect(before.sand).toBe(`/datasets/gtnh/test-fixture/textures/rendered/sand-${sha12(RED)}.png`);
    expect(fs.readFileSync(path.join(before.out, "textures", "rendered", path.basename(before.sand)))).toEqual(RED);

    const after = normalizeWithIcons(png([200, 20, 21, 255]));
    expect(after.sand).not.toBe(before.sand);
    expect(after.glass).toBe(before.glass);
  });
});
