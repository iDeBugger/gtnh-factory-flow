import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/error-response";
import { BOARD_IMAGE_MAX_BYTES, UPLOAD_FORM_OVERHEAD_BYTES } from "@/lib/community/types";
import { isCommunityConfigured } from "@/lib/server/community";
import { getFileStore, isFileStoreConfigured } from "@/lib/server/file-store";
import { claimImageUpload } from "@/lib/server/image-upload-guard";
import { readFormDataCapped } from "@/lib/server/request-body";
import { siteUrl } from "@/lib/site-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Board image uploads. Anyone can put a picture on their board, so this is
 * anonymous like voting: limited per address and for the whole site
 * (`image-upload-guard.ts`), size-capped, and the bytes are sniffed rather
 * than trusting the client's content type. Junk is refused before it is
 * counted, so it never spends anyone's share. Files land in the file store's
 * `board-images` bucket and come back as an absolute URL on this site (the
 * annotation schema takes only `http(s)://` or `data:image/`), served by
 * `./[month]/[name]`; the plan itself stays small.
 */

/** Magic-byte sniffing: the four image formats browsers render everywhere. */
function sniffImageType(bytes: Uint8Array): { contentType: string; ext: string } | undefined {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return { contentType: "image/png", ext: "png" };
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", ext: "jpg" };
  }
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { contentType: "image/gif", ext: "gif" };
  }
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { contentType: "image/webp", ext: "webp" };
  }
  return undefined;
}

export async function POST(request: Request) {
  if (!isCommunityConfigured() || !isFileStoreConfigured()) {
    return NextResponse.json({ error: "Image hosting is not configured." }, { status: 503 });
  }

  try {
    // The whole body is held to the picture's cap plus the form's overhead
    // before it is buffered, so an oversize upload costs no memory.
    const form = await readFormDataCapped(
      request,
      BOARD_IMAGE_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES,
    );
    if (!form) {
      return NextResponse.json(
        { error: "That image is too big: the limit is 4 MB." },
        { status: 413 },
      );
    }
    const file = form.get("image");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "No image in the upload." }, { status: 400 });
    }
    if (file.size > BOARD_IMAGE_MAX_BYTES) {
      return NextResponse.json(
        { error: "That image is too big: the limit is 4 MB." },
        { status: 413 },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sniffed = sniffImageType(bytes);
    if (!sniffed) {
      return NextResponse.json(
        { error: "Only PNG, JPEG, GIF and WebP images can go on the board." },
        { status: 415 },
      );
    }

    const refusal = await claimImageUpload(request);
    if (refusal) {
      return NextResponse.json({ error: refusal.error }, { status: refusal.status });
    }

    const month = new Date().toISOString().slice(0, 7);
    const name = `${randomBytes(9).toString("hex")}.${sniffed.ext}`;
    try {
      await getFileStore().put("board-images", `${month}/${name}`, bytes, { overwrite: false });
    } catch (error) {
      console.error("Image upload failed.", error);
      return NextResponse.json({ error: "Image upload failed." }, { status: 500 });
    }
    return NextResponse.json({ url: `${siteUrl()}/api/community/images/${month}/${name}` });
  } catch (error) {
    return serverErrorResponse(error, "Image upload failed.");
  }
}
