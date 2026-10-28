import { readFile } from "node:fs/promises";
import { isSafePathSegment, resolveDatasetChildPath } from "@/lib/server/dataset-static-file";

// The other texture roots, when the public handler misses (a file published after the start).
// The content-named ones, rendered/ and icons/, never reach here: the dataset gate
// (src/server/middleware/dataset-gate.ts) sends them to the dataset-files route. A miss or a refusal says no-store, so it is not kept like a file.
const textureRoots = new Set(["atlas", "nei-layouts"]);
const IMMUTABLE = "public, max-age=31536000, immutable";
const uncached = { "Cache-Control": "no-store" };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ versionId: string; assetPath: string[] }> },
) {
  const { versionId, assetPath } = await params;
  if (!isSafePathSegment(versionId) || !isSafeAssetPath(assetPath)) {
    return Response.json({ error: "Invalid texture path." }, { status: 400, headers: uncached });
  }

  // Undefined is a texture that is not there or a link out of the version's directory: both a miss.
  const resolvedFile = await resolveDatasetChildPath(versionId, "textures", ...assetPath);
  try {
    if (!resolvedFile) {
      throw new Error("Not a texture file.");
    }
    const data = await readFile(resolvedFile);
    return new Response(data, {
      headers: {
        "Cache-Control": IMMUTABLE,
        "Content-Type": "image/png",
      },
    });
  } catch {
    return Response.json({ error: "Texture not found." }, { status: 404, headers: uncached });
  }
}

function isSafeAssetPath(assetPath: string[]) {
  return (
    assetPath.length >= 2 &&
    textureRoots.has(assetPath[0] ?? "") &&
    assetPath.every(isSafePathSegment) &&
    assetPath.at(-1)?.endsWith(".png")
  );
}
