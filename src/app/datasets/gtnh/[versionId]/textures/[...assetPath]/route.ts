import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { isSafePathSegment, resolveDatasetChildPath } from "@/lib/server/dataset-static-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const textureRoots = new Set(["rendered", "icons", "atlas", "nei-layouts"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ versionId: string; assetPath: string[] }> },
) {
  const { versionId, assetPath } = await params;
  if (!isSafePathSegment(versionId) || !isSafeAssetPath(assetPath)) {
    return NextResponse.json({ error: "Invalid texture path." }, { status: 400 });
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
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "image/png",
      },
    });
  } catch {
    return NextResponse.json({ error: "Texture not found." }, { status: 404 });
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
