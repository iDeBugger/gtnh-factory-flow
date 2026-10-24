import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertPublishableNames, findUnpublishableNames } from "./publishable-names.mjs";

const folders = [];
afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function version(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publishable-names-"));
  folders.push(dir);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "");
  }
  return dir;
}

it("accepts the names the pipeline writes", async () => {
  const dir = version([
    "recipes.json.gz",
    "recipe-lookup-index.json.gz",
    "recipes-shards/shard-0000.json.gz",
    "textures/rendered/copper_ingot-a50d21cdeb41.png",
    "oracle/oracle-report.json",
  ]);
  expect(await findUnpublishableNames(dir)).toEqual([]);
  await expect(assertPublishableNames(dir)).resolves.toBeUndefined();
});

it("refuses a name a browser would percent-encode, anywhere under the version", async () => {
  // The site's request gate answers 400 to any encoded dataset path, so such a file would never be served.
  const dir = version([
    "recipes.json.gz",
    "textures/rendered/iron ingot.png",
    "textures/rendered/tier#1.png",
    "textures/rendered/café.png",
    "odd dir/x.png",
  ]);
  // The directory is named, not the fine file inside it; the file system may hand the accent back decomposed.
  expect((await findUnpublishableNames(dir)).map((name) => name.normalize("NFC"))).toEqual([
    "odd dir",
    "textures/rendered/café.png",
    "textures/rendered/iron ingot.png",
    "textures/rendered/tier#1.png",
  ]);
  await expect(assertPublishableNames(dir)).rejects.toThrow(/4 name\(s\) outside \[A-Za-z0-9._-\]/);
});
