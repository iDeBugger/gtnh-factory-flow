import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BOARD_IMAGE_MAX_BYTES } from "@/lib/community/types";

/**
 * Uploaded files, kept in a directory on the server (`FILE_STORE_DIR`, a
 * mounted volume in production) and served only by the site's own routes:
 * board images by `/api/community/images/<month>/<name>`, previews by the
 * post's preview route after its access check, feedback files by
 * `/api/feedback/files/<report>/<file>`. Nothing in the directory is served
 * as a static file, so a private bucket stays private.
 */
export type FileBucket = "board-images" | "plan-previews" | "feedback-files";

export interface FileStore {
  put(
    bucket: FileBucket,
    key: string,
    bytes: Uint8Array,
    options: { overwrite: boolean },
  ): Promise<void>;
  get(bucket: FileBucket, key: string): Promise<Buffer | undefined>;
  remove(bucket: FileBucket, keys: string[]): Promise<void>;
}

/**
 * A key is one to three path segments of plain characters, none starting
 * with a dot: no `..`, no hidden file, no empty segment, no escape of any
 * kind. Keys come from the routes, which build them; a request's path parts
 * reach this only through the routes' own stricter patterns.
 */
export const FILE_KEY =
  /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}){0,2}$/;

/** The largest file each bucket holds: what its upload route accepts. */
export const FILE_BUCKET_MAX_BYTES: Record<FileBucket, number> = {
  "board-images": BOARD_IMAGE_MAX_BYTES,
  "plan-previews": BOARD_IMAGE_MAX_BYTES,
  "feedback-files": 5 * 1024 * 1024,
};

const BUCKETS = new Set<string>(Object.keys(FILE_BUCKET_MAX_BYTES));

/** Where files live outside production when nothing is configured. */
const DEVELOPMENT_DIR = path.join("scratch", "local-db", "files");

export class FileKeyError extends Error {
  constructor() {
    super("Not a file key.");
    this.name = "FileKeyError";
  }
}

export class FileExistsError extends Error {
  constructor() {
    super("The file already exists.");
    this.name = "FileExistsError";
  }
}

export class FileTooLargeError extends Error {
  constructor() {
    super("The file is over its bucket's limit.");
    this.name = "FileTooLargeError";
  }
}

/** True when uploads have somewhere to go: `FILE_STORE_DIR`, or the development directory outside production. */
export function isFileStoreConfigured(): boolean {
  return Boolean(process.env.FILE_STORE_DIR?.trim()) || process.env.NODE_ENV !== "production";
}

function storeRoot(): string {
  const configured = process.env.FILE_STORE_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("FILE_STORE_DIR is not set: uploaded files have nowhere to go.");
  }
  return path.resolve(DEVELOPMENT_DIR);
}

/** The file's path, checked to sit inside its bucket's directory. */
function filePath(root: string, bucket: FileBucket, key: string): { dir: string; file: string } {
  if (!BUCKETS.has(bucket) || typeof key !== "string" || !FILE_KEY.test(key)) {
    throw new FileKeyError();
  }
  const dir = path.join(root, bucket);
  const file = path.resolve(dir, key);
  if (!file.startsWith(dir + path.sep)) {
    throw new FileKeyError();
  }
  return { dir, file };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A store rooted at `root`; the server's own is `getFileStore()`. */
export function fileStoreAt(root: string): FileStore {
  return {
    async put(bucket, key, bytes, { overwrite }) {
      const { dir, file } = filePath(root, bucket, key);
      if (bytes.byteLength > FILE_BUCKET_MAX_BYTES[bucket]) {
        throw new FileTooLargeError();
      }
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // Written whole beside the bucket, then renamed into place: a reader
      // never sees half a file, and a failed write leaves nothing under the key.
      const temp = path.join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
      try {
        // Inside the try: a write that fails partway (a full disk) leaves no temp file behind.
        await fs.writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
        if (!overwrite) {
          // link refuses an existing target, so two racing writes cannot both land.
          await fs.link(temp, file).catch((error: NodeJS.ErrnoException) => {
            throw error.code === "EEXIST" ? new FileExistsError() : error;
          });
        } else {
          await fs.rename(temp, file);
        }
      } finally {
        await fs.rm(temp, { force: true });
      }
    },

    async get(bucket, key) {
      const { file } = filePath(root, bucket, key);
      try {
        return await fs.readFile(file);
      } catch (error) {
        if (isMissing(error) || (error as NodeJS.ErrnoException).code === "EISDIR") {
          return undefined;
        }
        throw error;
      }
    },

    async remove(bucket, keys) {
      const files = keys.map((key) => filePath(root, bucket, key).file);
      await Promise.all(files.map((file) => fs.rm(file, { force: true })));
    },
  };
}

/** The server's store, rooted at `FILE_STORE_DIR` (read at each call). */
export function getFileStore(): FileStore {
  const store = (): FileStore => fileStoreAt(storeRoot());
  return {
    put: (bucket, key, bytes, options) => store().put(bucket, key, bytes, options),
    get: (bucket, key) => store().get(bucket, key),
    remove: (bucket, keys) => store().remove(bucket, keys),
  };
}
