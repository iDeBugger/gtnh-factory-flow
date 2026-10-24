/**
 * Reading a request body under a byte cap. Next.js route handlers have no
 * body limit of their own, so `request.json()`, `request.text()` and
 * `request.formData()` buffer whatever arrives before any check can run: a
 * handful of 100 MB posts is hundreds of MB of the one heap that also holds
 * the datasets. Every route that reads a body reads it through here, with a
 * cap sized to what the client legitimately sends, and refuses the rest as
 * 413 before a byte past the cap is kept.
 */

/** Sign-in, votes, folder names, a publish flag: a few hundred bytes, never kilobytes. */
export const SMALL_JSON_MAX_BYTES = 16 * 1024;

/** A 2,000-character comment is at most 24 KiB of escaped JSON. */
export const COMMENT_BODY_MAX_BYTES = 64 * 1024;

/** The 413 sentence for a body no player-facing limit describes better. */
export const REQUEST_TOO_BIG_MESSAGE = "The request is too big.";

/**
 * The body's bytes, or undefined once it passes `max`: a declared length over
 * the cap is refused unread, and a body with no length (chunked) stops being
 * read at the cap rather than buffered whole. No body reads as empty.
 */
export async function readBodyCapped(
  request: Request,
  max: number,
): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > max) {
    return undefined;
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** The capped body as text (UTF-8), or undefined past the cap. */
export async function readTextCapped(request: Request, max: number): Promise<string | undefined> {
  const bytes = await readBodyCapped(request, max);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/** `JSON.parse` of the capped text: 413 past the cap, 400 when the text is not JSON. */
export async function readJsonCapped(
  request: Request,
  max: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 413 | 400 }> {
  const text = await readTextCapped(request, max);
  if (text === undefined) {
    return { ok: false, status: 413 };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

/**
 * Multipart through the same cap: the capped bytes re-parsed with the
 * request's content type (its boundary), so the files and fields come back
 * as `request.formData()` would give them. A missing or wrong content type
 * throws, as the uncapped parse does.
 */
export async function readFormDataCapped(
  request: Request,
  max: number,
): Promise<FormData | undefined> {
  const bytes = await readBodyCapped(request, max);
  if (bytes === undefined) {
    return undefined;
  }
  return new Response(new Blob([bytes as BlobPart]), {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  }).formData();
}
