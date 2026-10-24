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
 * must change the file, and only the running code can say how. They go under
 * `<dataset>/client/` at start (after the prewarm, in the background) and are
 * written only when missing, so a restart with the same code and data
 * compresses nothing. A file another release still names stays for
 * `STALE_CLIENT_FILE_MS` after the last start that named it.
 */

export { CLIENT_FILE_KINDS, CLIENT_FILE_NAME, CLIENT_FILES_DIRECTORY };
export type { ClientFileKind };

export interface ClientFileSpec {
  kind: ClientFileKind;
  /** The answer, exactly the JSON the API route would send. */
  produce: () => Promise<unknown>;
  /**
   * Whether a brotli copy is worth writing beside the gzip. Measured on 2.9
   * (M1, quality 11): the catalog, mobs and crops lists take under a second
   * each and shrink by half or more (crops 314 KB gzip, 29 KB brotli); the id
   * list takes 23 s and saves 13% (2.8 MB gzip, 2.4 MB brotli), so it ships
   * gzip only.
   */
  brotli: boolean;
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
    if (spec.brotli) {
      await ensureEncoded(
        directory,
        `${name}.br`,
        () =>
          brotliAsync(bytes, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
              [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
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
 * Starts (once per key) writing a version's files, and resolves when that is
 * done. A failure (an unwritable dataset directory, a dataset that does not
 * load) is logged and leaves the listing incomplete: the client then asks the
 * API for what is missing, so nothing a player sees depends on the files.
 */
export function ensureClientFiles(
  key: string,
  versionId: string,
  directory: string,
  specs: readonly ClientFileSpec[],
): Promise<void> {
  let state = states.get(key);
  if (!state) {
    state = { files: {}, complete: false };
    states.set(key, state);
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
  const state = states.get(key);
  return { complete: state?.complete ?? false, files: { ...state?.files } };
}

/** Test seam: forgets every version's state. */
export function resetClientFileStateForTests(): void {
  states.clear();
}
