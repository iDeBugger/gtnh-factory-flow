import fs from "node:fs/promises";
import path from "node:path";

// The export's pack zip. build-datasets.mjs downloads it from its pack table's URL and checks
// its pinned SHA-256 before the export starts, then passes it here as GTNH_PACK_LOCAL_ZIP; this
// only puts it where run-gtnh-oracle-export.sh unzips from. Nothing here reaches the network.
const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("Usage: download-gtnh-pack.mjs <output.zip>");
}
const localZip = process.env.GTNH_PACK_LOCAL_ZIP;
if (!localZip) {
  throw new Error("GTNH_PACK_LOCAL_ZIP is required: build-datasets.mjs fetches and checks the pack zip.");
}

const source = path.resolve(localZip);
const stats = await fs.stat(source);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
if (path.resolve(outputPath) === source) {
  console.log(`Using the checked GTNH pack: ${source} (${stats.size} bytes).`);
} else {
  console.log(`Copying the checked GTNH pack: ${source} (${stats.size} bytes).`);
  await fs.copyFile(source, outputPath);
}
