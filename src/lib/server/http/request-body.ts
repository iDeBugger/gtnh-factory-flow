/**
 * Reading a request body under a byte cap. A route handler's web `Request`
 * has no body limit of its own past the adapter's hard cap, so
 * `request.json()`, `request.text()` and `request.formData()` parse whatever
 * arrives. Every route that reads a body reads it through here, with a cap
 * sized to what the client legitimately sends, and refuses the rest as 413.
 */

/** Sign-in, votes, folder names, a publish flag: a few hundred bytes, never kilobytes. */
export const SMALL_JSON_MAX_BYTES = 16 * 1024;

/** A 2,000-character comment is at most 24 KiB of escaped JSON. */
export const COMMENT_BODY_MAX_BYTES = 64 * 1024;

/**
 * The most of any request body the adapter (src/server/http/adapter.ts) hands a route: past it the route's body
 * stream errors and the answer is a 413. It sits just above the largest route cap (an image or preview upload,
 * 4 MiB plus the form's 64 KiB), never below one, so a body cut here is still over every cap and still answers
 * 413, not a 400 for a truncated JSON or form.
 */
export const BODY_HARD_CAP_BYTES = 4.5 * 1024 * 1024;

/** The 413 sentence for a body no player-facing limit describes better. */
export const REQUEST_TOO_BIG_MESSAGE = "The request is too big.";

/**
 * The body's bytes, or undefined once it passes `max`: a declared length over
 * the cap is refused without reading the body, and a body with no length
 * (chunked) stops being read at the cap. No body reads as empty.
 */
export async function readBodyCapped(
  request: Request,
  max: number,
): Promise<Uint8Array | undefined> {
  const read = await readChunksCapped(request, max);
  if (!read) {
    return undefined;
  }
  const body = new Uint8Array(read.size);
  let at = 0;
  for (const chunk of read.chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** The capped body as it arrived, chunk by chunk, so a caller that needs no one buffer copies nothing. */
async function readChunksCapped(
  request: Request,
  max: number,
): Promise<{ chunks: Uint8Array[]; size: number } | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > max) {
    return undefined;
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return { chunks: [], size: 0 };
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
  return { chunks, size };
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
  // The chunks go into the Blob as they are: no joined copy of the body first.
  const read = await readChunksCapped(request, max);
  if (!read) {
    return undefined;
  }
  return new Response(new Blob(read.chunks as BlobPart[]), {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  }).formData();
}
