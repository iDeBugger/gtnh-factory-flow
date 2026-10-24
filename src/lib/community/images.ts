"use client";

import { BOARD_IMAGE_MAX_BYTES } from "./types";

/**
 * Uploading a picture for the board. The file goes to /api/community/images,
 * which sniffs, caps and stores it in a public bucket; what comes back is the
 * hosted URL an image annotation carries. All the friendly refusals (too big,
 * not an image, too many) surface here as thrown Errors with player-readable
 * messages. Nothing but the file is sent: the server limits by address.
 */
export async function uploadBoardImage(file: File | Blob): Promise<string> {
  if (file.size > BOARD_IMAGE_MAX_BYTES) {
    throw new Error("That image is too big: the limit is 4 MB.");
  }

  const form = new FormData();
  form.set("image", file);

  const response = await fetch("/api/community/images", { method: "POST", body: form });
  const body = (await response.json().catch(() => undefined)) as
    | { url?: string; error?: string }
    | undefined;
  if (!response.ok || !body?.url) {
    throw new Error(body?.error ?? "Image upload failed.");
  }
  return body.url;
}

/** The picture's natural pixel size, read locally before it is placed. */
export function readImageSize(file: File | Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("That file does not look like an image."));
    };
    image.src = objectUrl;
  });
}
