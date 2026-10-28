import fs from "node:fs/promises";
import path from "node:path";

/**
 * The characters a published dataset file or directory name may use. The
 * site's request gate (src/server/middleware/dataset-gate.ts) refuses any dataset path a browser would
 * percent-encode, so a name holding a space, "#", "%", "?" or a character
 * outside ASCII would be unreachable once published. Every name the pipeline
 * writes today (data, shards, 170k textures) fits this set; a version that
 * does not is refused before the manifest lists it.
 */
export const PUBLISHABLE_NAME = /^[A-Za-z0-9._-]+$/;

/** Every path under `dir` (relative, "/"-joined) whose name is not publishable. */
export async function findUnpublishableNames(dir) {
  const offending = [];
  const walk = async (current, prefix) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!PUBLISHABLE_NAME.test(entry.name)) {
        offending.push(relative);
      }
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relative);
      }
    }
  };
  await walk(dir, "");
  return offending.sort();
}

/** Throws, naming the first few offenders, when `dir` holds a name the site would refuse. */
export async function assertPublishableNames(dir) {
  const offending = await findUnpublishableNames(dir);
  if (offending.length > 0) {
    const shown = offending.slice(0, 5).join(", ");
    throw new Error(
      `${dir} holds ${offending.length} name(s) outside [A-Za-z0-9._-], which the site refuses to serve: ${shown}${
        offending.length > 5 ? ", ..." : ""
      }`,
    );
  }
}
