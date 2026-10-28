import { BOARD_IMAGE_NAME, BOARD_IMAGE_MONTH, BOARD_IMAGE_TYPES } from "@/lib/server/board-images";
import { datasetBudgetRefusal } from "@/lib/server/limits/dataset-rate";
import { getFileStore, isFileStoreConfigured } from "@/lib/server/file-store";

function notFound(): Response {
  return Response.json(
    { error: "Not found." },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * A board image, by the exact name its upload answered. Only names the upload
 * route makes are servable (a month, 18 hex characters, one of four image
 * extensions), so no request reaches another bucket or a path outside the
 * board images. A stored image never changes: cached for a year. The type
 * comes from the extension the upload chose after sniffing the bytes, and
 * nosniff keeps a browser from reading it as anything else.
 *
 * Each read spends one unit of the address's dataset budget (dataset-rate.ts)
 * before touching the disk: a board shows a handful of pictures, the same
 * address loads dataset files by the hundred, and an image read is a disk read
 * of up to 4 MB.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ month: string; name: string }> },
) {
  const { month, name } = await params;
  if (!BOARD_IMAGE_MONTH.test(month) || !BOARD_IMAGE_NAME.test(name) || !isFileStoreConfigured()) {
    return notFound();
  }
  const extension = name.slice(name.lastIndexOf(".") + 1);
  const contentType = Object.hasOwn(BOARD_IMAGE_TYPES, extension)
    ? BOARD_IMAGE_TYPES[extension]
    : undefined;
  if (!contentType) {
    return notFound();
  }
  const refusal = datasetBudgetRefusal(request, 1);
  if (refusal) {
    return refusal;
  }
  const bytes = await getFileStore()
    .get("board-images", `${month}/${name}`)
    .catch(() => undefined);
  if (!bytes) {
    return notFound();
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
