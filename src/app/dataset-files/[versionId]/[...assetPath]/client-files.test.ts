import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = vi.hoisted(() => ({ dir: "" }));

vi.mock("@/lib/server/dataset-static-file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/dataset-static-file")>();
  return {
    ...actual,
    resolveDatasetChildPath: (versionId: string, ...segments: string[]) =>
      path.join(root.dir, versionId, ...segments),
  };
});

const { GET } = await import("./route");

const V = "local-2.9.0-rc-2";
const NAME = "crops.0123456789abcdef0123.json";
const IDS = "recipe-ids.0123456789abcdef0123.json";
const body = JSON.stringify({ crops: [{ id: "c1" }] });

function get(name: string, acceptEncoding?: string) {
  return GET(
    new Request(`http://localhost/dataset-files/${V}/client/${name}`, {
      headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
    }),
    { params: Promise.resolve({ versionId: V, assetPath: ["client", name] }) },
  );
}

beforeAll(async () => {
  root.dir = await fs.mkdtemp(path.join(os.tmpdir(), "client-route-"));
  const dir = path.join(root.dir, V, "client");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${NAME}.gz`), gzipSync(body));
  await fs.writeFile(path.join(dir, `${NAME}.br`), brotliCompressSync(body));
  await fs.writeFile(path.join(dir, `${IDS}.gz`), gzipSync("{}"));
});

afterAll(async () => {
  await fs.rm(root.dir, { recursive: true, force: true });
});

describe("a content-addressed client file", () => {
  it("is served immutable, as brotli when the browser takes it, else gzip", async () => {
    const br = await get(NAME, "gzip, deflate, br, zstd");
    expect(br.status).toBe(200);
    expect(br.headers.get("Content-Encoding")).toBe("br");
    expect(br.headers.get("Content-Type")).toBe("application/json");
    expect(br.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(br.headers.get("Vary")).toBe("Accept-Encoding");
    expect(br.headers.get("ETag")).toBe('"0123456789abcdef0123-br"');

    const gz = await get(NAME, "gzip;q=1, br;q=0");
    expect(gz.headers.get("Content-Encoding")).toBe("gzip");
    expect(gz.headers.get("ETag")).toBe('"0123456789abcdef0123-gz"');

    // The id list has no brotli copy: a brotli browser still gets its gzip.
    expect((await get(IDS, "br, gzip")).headers.get("Content-Encoding")).toBe("gzip");
  });

  it("is unpacked for a client that takes no encoding", async () => {
    const plain = await get(NAME);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    expect(await plain.text()).toBe(body);
  });

  it("answers 304 to its own tag", async () => {
    const response = await GET(
      new Request(`http://localhost/dataset-files/${V}/client/${NAME}`, {
        headers: { "accept-encoding": "br", "if-none-match": '"0123456789abcdef0123-br"' },
      }),
      { params: Promise.resolve({ versionId: V, assetPath: ["client", NAME] }) },
    );
    expect(response.status).toBe(304);
  });

  it("is missing uncached, and any other name under client/ is refused", async () => {
    const missing = await get("mobs.0123456789abcdef0123.json", "br, gzip");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    for (const name of [
      `${NAME}.gz`,
      `${NAME}.br`,
      "crops.json",
      "evil.0123456789abcdef0123.json",
    ]) {
      const refused = await get(name, "br");
      expect(refused.status, name).toBe(400);
      expect(refused.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
