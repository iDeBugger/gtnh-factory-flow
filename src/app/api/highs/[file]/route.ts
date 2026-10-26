import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-static";

const FILES: Record<string, string> = {
  "highs.js": "text/javascript; charset=utf-8",
  "highs.wasm": "application/wasm",
};

/**
 * The solver worker's HiGHS glue and wasm, read straight from the package. The same two files are copied into
 * public/ by `tools/copy-highs-wasm.mjs` (predev, prebuild), but a server started any other way (`next dev` run
 * directly, a build that skipped the copy) has no public/highs.js, and the worker would 404 on it. This route is
 * the worker's first choice; public/ stays its fallback.
 */
export function generateStaticParams() {
  return Object.keys(FILES).map((file) => ({ file }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  // Own keys only: `constructor` would find the prototype's function.
  const type = Object.hasOwn(FILES, file) ? FILES[file] : undefined;
  if (!type) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(path.join(process.cwd(), "node_modules", "highs", "build", file));
    return new Response(new Uint8Array(body), {
      headers: { "content-type": type, "cache-control": "public, max-age=3600" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
