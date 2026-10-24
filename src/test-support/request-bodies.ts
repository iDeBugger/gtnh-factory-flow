/**
 * Request bodies for the body-cap tests: a stream that counts how often the
 * server pulled from it, so a test can show a refusal happened before a byte
 * was read. `highWaterMark: 0` keeps the stream from pulling on its own.
 */
export function countedBody(
  chunk: Uint8Array,
  chunks: number,
): { body: ReadableStream<Uint8Array>; counts: { pulls: number } } {
  const counts = { pulls: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        counts.pulls += 1;
        if (counts.pulls > chunks) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { body, counts };
}

/** A request that declares `declaredBytes` of body and would stream a megabyte at a time if read. */
export function oversizeRequest(
  url: string,
  method: string,
  declaredBytes: number,
  headers: Record<string, string> = {},
): { request: Request; counts: { pulls: number } } {
  const { body, counts } = countedBody(new Uint8Array(1024 * 1024).fill(0x20), 64);
  const request = new Request(url, {
    method,
    headers: {
      "content-length": String(declaredBytes),
      "content-type": "application/json",
      ...headers,
    },
    body,
    duplex: "half",
  } as RequestInit);
  return { request, counts };
}
