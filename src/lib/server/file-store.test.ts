import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FILE_BUCKET_MAX_BYTES,
  FileExistsError,
  FileKeyError,
  FileTooLargeError,
  fileStoreAt,
  type FileStore,
} from "./file-store";

let root: string;
let store: FileStore;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "file-store-"));
  store = fileStoreAt(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe("the file store", () => {
  it("stores, reads and removes a file", async () => {
    await store.put("board-images", "2026-10/abc.png", bytes("one"), { overwrite: false });
    expect((await store.get("board-images", "2026-10/abc.png"))?.toString()).toBe("one");
    expect(await store.get("plan-previews", "2026-10/abc.png")).toBeUndefined();
    expect(await store.get("board-images", "2026-10/missing.png")).toBeUndefined();
    expect(await store.get("board-images", "nowhere/missing.png")).toBeUndefined();
    await store.remove("board-images", ["2026-10/abc.png", "2026-10/never.png"]);
    expect(await store.get("board-images", "2026-10/abc.png")).toBeUndefined();
  });

  it("refuses to overwrite unless asked", async () => {
    await store.put("plan-previews", "plan-1.png", bytes("first"), { overwrite: false });
    await expect(
      store.put("plan-previews", "plan-1.png", bytes("second"), { overwrite: false }),
    ).rejects.toBeInstanceOf(FileExistsError);
    expect((await store.get("plan-previews", "plan-1.png"))?.toString()).toBe("first");
    await store.put("plan-previews", "plan-1.png", bytes("third"), { overwrite: true });
    expect((await store.get("plan-previews", "plan-1.png"))?.toString()).toBe("third");
  });

  it("refuses keys that leave the bucket", async () => {
    for (const key of [
      "../x",
      "a/../../x",
      "/abs",
      "a//b",
      ".hidden",
      "a%2Fb",
      "",
      "a/.tmp-1",
      "a\\b",
      "a/b/c/d",
    ]) {
      await expect(
        store.put("board-images", key, bytes("x"), { overwrite: true }),
        key,
      ).rejects.toBeInstanceOf(FileKeyError);
      await expect(store.get("board-images", key), key).rejects.toBeInstanceOf(FileKeyError);
      await expect(store.remove("board-images", [key]), key).rejects.toBeInstanceOf(FileKeyError);
    }
    await expect(
      store.get("../board-images" as unknown as "board-images", "x.png"),
    ).rejects.toBeInstanceOf(FileKeyError);
  });

  it("refuses a file over its bucket's cap", async () => {
    const big = new Uint8Array(FILE_BUCKET_MAX_BYTES["board-images"] + 1);
    await expect(
      store.put("board-images", "big.png", big, { overwrite: true }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
    expect(await store.get("board-images", "big.png")).toBeUndefined();
  });

  it("writes files only the owner can read", async () => {
    await store.put("plan-previews", "post/preview.png", bytes("p"), { overwrite: true });
    expect(statSync(path.join(root, "plan-previews", "post", "preview.png")).mode & 0o777).toBe(
      0o600,
    );
    expect(statSync(path.join(root, "plan-previews", "post")).mode & 0o777).toBe(0o700);
  });
});
