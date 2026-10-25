import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDatasetBudget } from "@/lib/server/limits/dataset-rate";
import { getFileStore } from "@/lib/server/file-store";
import { GET } from "./route";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let root: string;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "board-images-"));
  vi.stubEnv("FILE_STORE_DIR", root);
  await getFileStore().put("board-images", "2026-10/0123456789abcdef01.png", PNG, {
    overwrite: false,
  });
  await getFileStore().put("plan-previews", "x.png", PNG, { overwrite: true });
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const get = (month: string, name: string, address?: string) =>
  GET(
    new Request(`http://localhost/api/community/images/${month}/${name}`, {
      headers: address ? { "x-client-ip": address } : {},
    }),
    { params: Promise.resolve({ month, name }) },
  );

describe("serving board images", () => {
  it("serves only board images by their exact name", async () => {
    const served = await get("2026-10", "0123456789abcdef01.png");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(served.headers.get("content-disposition")).toBe("inline");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);

    for (const [month, name] of [
      ["..", "plan-previews/x.png"],
      ["2026-10", "../plan-previews/x.png"],
      ["2026-10", "..%2Fplan-previews%2Fx.png"],
      ["..%2Fplan-previews", "x.png"],
      ["2026-10", "abc.png"],
      ["2026-10", "0123456789abcdef01.svg"],
      ["2026-10", "0123456789ABCDEF01.png"],
      ["2026-1", "0123456789abcdef01.png"],
      ["2026-10", "fedcba9876543210ff.png"],
      ["2026-11", "0123456789abcdef01.png"],
    ]) {
      const refused = await get(month!, name!);
      expect(refused.status, `${month}/${name}`).toBe(404);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(await refused.json()).toEqual({ error: "Not found." });
    }
  });

  it("spends the address's dataset budget, one unit a read", async () => {
    vi.stubEnv("GTNH_DATASET_BUDGET_PER_MINUTE", "25");
    resetDatasetBudget();
    try {
      for (let i = 0; i < 25; i++) {
        expect((await get("2026-10", "0123456789abcdef01.png", "203.0.113.40")).status).toBe(200);
      }
      const refused = await get("2026-10", "0123456789abcdef01.png", "203.0.113.40");
      expect(refused.status).toBe(429);
      expect((await get("2026-10", "0123456789abcdef01.png", "203.0.113.41")).status).toBe(200);
    } finally {
      vi.stubEnv("GTNH_DATASET_BUDGET_PER_MINUTE", "");
      resetDatasetBudget();
    }
  });
});
