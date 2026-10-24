import { describe, expect, it, vi } from "vitest";
import { readBodyCapped, readFormDataCapped, readJsonCapped, readTextCapped } from "./request-body";

const MIB = 1024 * 1024;

/** A chunked body of `chunks` megabyte chunks that counts its pulls and cancellations (no eager pull). */
function chunked(chunks: number) {
  const chunk = new Uint8Array(MIB).fill(0x20);
  const counts = { pulls: 0, cancelled: false };
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
      cancel() {
        counts.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, counts };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/anything", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

describe("reading a request body under a cap", () => {
  it("refuses a declared length over the cap without reading", async () => {
    const { body, counts } = chunked(64);
    const request = post(body, { "content-length": String(64 * MIB) });
    expect(await readBodyCapped(request, 4 * MIB)).toBeUndefined();
    expect(counts.pulls).toBe(0);
  });

  it("stops a chunked body at the cap", async () => {
    const { body, counts } = chunked(64);
    expect(await readBodyCapped(post(body), 4 * MIB)).toBeUndefined();
    // Four megabytes and the one chunk past them, not the whole 64.
    expect(counts.pulls).toBeLessThan(6);
    expect(counts.cancelled).toBe(true);
  });

  it("returns a body under the cap byte for byte", async () => {
    const bytes = new Uint8Array(3000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 251;
    }
    const read = await readBodyCapped(post(bytes), 4096);
    expect(read).toBeDefined();
    expect(Buffer.from(read!).equals(Buffer.from(bytes))).toBe(true);
    expect(await readBodyCapped(post(null), 4096)).toEqual(new Uint8Array(0));
  });

  it("decodes text and parses JSON, naming the refusal", async () => {
    expect(await readTextCapped(post("héllo"), 64)).toBe("héllo");
    expect(await readJsonCapped(post(JSON.stringify({ a: [1, 2] })), 64)).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
    expect(await readJsonCapped(post("{not json"), 64)).toEqual({ ok: false, status: 400 });
    expect(await readJsonCapped(post("x".repeat(65)), 64)).toEqual({ ok: false, status: 413 });
  });

  it("re-parses multipart under the cap, and refuses it past the cap", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const form = new FormData();
    form.set("image", new Blob([png as BlobPart], { type: "image/png" }), "board.png");
    form.set("deviceId", "device-1");
    const parsed = await readFormDataCapped(post(form), 64 * 1024);
    expect(parsed).toBeDefined();
    const file = parsed!.get("image");
    expect(file).toBeInstanceOf(Blob);
    expect(Buffer.from(await (file as Blob).arrayBuffer()).equals(Buffer.from(png))).toBe(true);
    expect(parsed!.get("deviceId")).toBe("device-1");

    const big = new FormData();
    big.set(
      "image",
      new Blob([new Uint8Array(5 * MIB) as BlobPart], { type: "image/png" }),
      "big.png",
    );
    expect(await readFormDataCapped(post(big), 4 * MIB + 64 * 1024)).toBeUndefined();
  });

  it("throws on a multipart body with no content type, as the uncapped parse does", async () => {
    const request = new Request("http://localhost/api/anything", {
      method: "POST",
      body: "plain text",
    });
    const spy = vi.fn();
    await readFormDataCapped(request, 1024).catch(spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
