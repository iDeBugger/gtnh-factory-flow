import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import {
  CLIENT_FILE_KINDS,
  CLIENT_FILE_NAME,
  CLIENT_FILES_DIRECTORY,
  type ClientFileKind,
  type ClientFileListingResponse,
} from "@/lib/datasets/client-file-kinds";

/**
 * Static, content-addressed copies of the dataset answers that are the same
 * for every player: the catalog, the crop and mob pickers' lists and the
 * recipe id list. The browser fetches these instead of the API, and because a
 * name holds the hash of its bytes, a name never means other bytes: the file
 * is immutable for a year at the browser and at Cloudflare, and the server
 * neither builds nor compresses the answer again for each player.
 *
 * The server writes them, not the pipeline: each is the dataset run through
 * the server's code (the catalog's merged machine resources and synthesized
 * icons, the pickers' hydrated summaries), so a deploy that changes that code
 * must change the file, and only the running code can say how. They go into
 * the site's own cache directory (`clientFilesRoot`, never the dataset tree,
 * which is the pipeline's bytes and may be mounted read-only) at start, after
 * the prewarm, in the background, and are written only when missing, so a
 * restart with the same code and data compresses nothing. A file another
 * release still names stays for `STALE_CLIENT_FILE_MS` after the last start
 * that named it. They are served at `/datasets/gtnh/<id>/client/<name>`
 * (dataset-path-gate.ts, the dataset-files route).
 */

export { CLIENT_FILE_KINDS, CLIENT_FILE_NAME, CLIENT_FILES_DIRECTORY };
export type { ClientFileKind };

/**
 * Where the client files live: `GTNH_CLIENT_FILES_DIR` (a writable volume in
 * a container), else `.cache/client-files` under the working directory
 * (gitignored). One directory per dataset version under it.
 */
export function clientFilesRoot(): string {
  const configured = process.env.GTNH_CLIENT_FILES_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), ".cache", "client-files");
}

/** A version's directory, or undefined for a version id that is not a plain name. */
export function clientFileDirectory(versionId: string): string | undefined {
  return isPlainName(versionId) ? path.join(clientFilesRoot(), versionId) : undefined;
}

/** One stored file (`<name>.gz` or `<name>.br`) of a version, or undefined for an unsafe name. */
export function resolveClientFilePath(versionId: string, fileName: string): string | undefined {
  const directory = clientFileDirectory(versionId);
  return directory && isPlainName(fileName) ? path.join(directory, fileName) : undefined;
}

function isPlainName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

export interface ClientFileSpec {
  kind: ClientFileKind;
  /** The answer, exactly the JSON the API route would send. */
  produce: () => Promise<unknown>;
  /**
   * The brotli copy written beside the gzip, or undefined for none. Measured
   * on 2.9 (M1, one pool thread, peak process RSS during the call): the
   * catalog, mobs and crops lists take under a second each at quality 11 and
   * shrink by half or more (crops 314 KB gzip, 29 KB brotli); a 7.6 MB input at
   * 11 holds +99 MB with a 16 MB window (24) and +72 MB with 4 MB (22) for the
   * same size, so 22. The 23 MB item search file: 10/24 is 1.74 MB in 14 s at
   * +201 MB, 9/24 is 1.96 MB in 1.1 s at +85 MB (gzip 2.77 MB), so 9/24 keeps
   * four fifths of the gain at under half the memory. The id list takes 23 s
   * at 11 to save 13% (2.8 MB gzip, 2.4 MB brotli) and ships gzip only.
   */
  brotli?: { quality: number; window: number };
}

export type ClientFileListing = ClientFileListingResponse;

/** How long a file no start has named stays on disk: an open tab's listing may still name it. */
export const STALE_CLIENT_FILE_MS = 30 * 24 * 60 * 60 * 1000;

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

export function clientFileName(kind: ClientFileKind, bytes: Buffer): string {
  return `${kind}.${createHash("sha256").update(bytes).digest("hex").slice(0, 20)}.json`;
}

/**
 * Writes each spec's file under `directory`, one after another, and reports
 * each name as soon as it is on disk. Compression runs on the thread pool, one
 * file at a time, so the request thread stays free and at most one pool thread
 * is held. A file already on disk is kept (its mtime refreshed, which is what
 * the stale-file sweep reads); one written now goes through a temporary name
 * and a rename, so a reader never sees half of it.
 */
export async function writeClientFiles(
  directory: string,
  specs: readonly ClientFileSpec[],
  onWritten: (kind: ClientFileKind, name: string) => void,
  now = Date.now(),
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const current = new Set<string>();
  for (const spec of specs) {
    const bytes = Buffer.from(JSON.stringify(await spec.produce()));
    const name = clientFileName(spec.kind, bytes);
    await ensureEncoded(directory, `${name}.gz`, () => gzipAsync(bytes, { level: 9 }), now);
    current.add(`${name}.gz`);
    const brotli = spec.brotli;
    if (brotli) {
      await ensureEncoded(
        directory,
        `${name}.br`,
        () =>
          brotliAsync(bytes, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: brotli.quality,
              [zlibConstants.BROTLI_PARAM_LGWIN]: brotli.window,
              [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
            },
          }),
        now,
      );
      current.add(`${name}.br`);
    }
    onWritten(spec.kind, name);
  }
  await removeStaleClientFiles(directory, current, now);
}

async function ensureEncoded(
  directory: string,
  fileName: string,
  encode: () => Promise<Buffer>,
  now: number,
): Promise<void> {
  const filePath = path.join(directory, fileName);
  const stamp = new Date(now);
  try {
    const stats = await fs.stat(filePath);
    if (stats.isFile() && stats.size > 0) {
      await fs.utimes(filePath, stamp, stamp);
      return;
    }
  } catch {
    // Not there yet: write it below.
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, await encode());
  await fs.utimes(temporary, stamp, stamp);
  await fs.rename(temporary, filePath);
}

/** Removes what no start has named for `STALE_CLIENT_FILE_MS`, and leftover temporaries. */
async function removeStaleClientFiles(
  directory: string,
  current: Set<string>,
  now: number,
): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || current.has(entry.name)) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    const stats = await fs.stat(filePath).catch(() => undefined);
    const maxAge = entry.name.endsWith(".tmp") ? 24 * 60 * 60 * 1000 : STALE_CLIENT_FILE_MS;
    if (stats && now - stats.mtimeMs > maxAge) {
      await fs.rm(filePath, { force: true });
    }
  }
}

/**
 * One version's files as this process knows them, kept on `globalThis`: Next.js
 * bundles `instrumentation.ts` apart from the routes, and the start-up write
 * must fill the listing the route reads.
 */
interface VersionClientFiles {
  files: Partial<Record<ClientFileKind, string>>;
  complete: boolean;
  writing?: Promise<void>;
}

const CLIENT_FILE_STATE = Symbol.for("gtnh-factory-flow.client-files");
const stateHost = globalThis as { [CLIENT_FILE_STATE]?: Map<string, VersionClientFiles> };
const states = (stateHost[CLIENT_FILE_STATE] ??= new Map());

/**
 * Outside production each load of this module keys its own states: a dev
 * reload of changed answer code must not keep listing the files the old code
 * wrote. In production the code never changes under a process, and the
 * start-up write (another bundle's copy of this module) must fill the listing
 * the route reads.
 */
const MODULE_GENERATION =
  process.env.NODE_ENV === "production" ? "" : `:${Math.random().toString(36).slice(2)}`;

/**
 * Starts (once per key) writing a version's files, and resolves when that is
 * done. A failure (an unwritable cache directory, a dataset that does not
 * load) is logged and leaves the listing incomplete: the client then asks the
 * API for what is missing, so nothing a player sees depends on the files.
 */
export function ensureClientFiles(
  key: string,
  versionId: string,
  directory: string,
  specs: readonly ClientFileSpec[],
): Promise<void> {
  let state = states.get(key + MODULE_GENERATION);
  if (!state) {
    state = { files: {}, complete: false };
    states.set(key + MODULE_GENERATION, state);
  }
  if (!state.writing) {
    const target = state;
    target.writing = writeClientFiles(directory, specs, (kind, name) => {
      target.files[kind] = `/datasets/gtnh/${versionId}/${CLIENT_FILES_DIRECTORY}/${name}`;
    }).then(
      () => {
        target.complete = true;
      },
      (error) => {
        console.error(`GTNH dataset ${versionId} client files were not written.`, error);
      },
    );
  }
  return state.writing;
}

/** What is written so far for `key`, starting the write when nothing has asked yet. */
export function clientFileListing(
  key: string,
  versionId: string,
  directory: string,
  specs: readonly ClientFileSpec[],
): ClientFileListing {
  void ensureClientFiles(key, versionId, directory, specs);
  const state = states.get(key + MODULE_GENERATION);
  return { complete: state?.complete ?? false, files: { ...state?.files } };
}

/** Test seam: forgets every version's state. */
export function resetClientFileStateForTests(): void {
  states.clear();
}
