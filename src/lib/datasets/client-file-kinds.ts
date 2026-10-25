/**
 * The server's static, content-addressed dataset answers
 * (`src/lib/server/client-files.ts`), as the browser, the request gate and the
 * server all name them. No Node imports: the browser and the proxy read this.
 */
export const CLIENT_FILES_DIRECTORY = "client";

export const CLIENT_FILE_KINDS = ["catalog", "mobs", "crops", "recipe-ids", "items"] as const;
export type ClientFileKind = (typeof CLIENT_FILE_KINDS)[number];

/** `<kind>.<20 hex of the sha256 of the JSON>.json`: within the gate's [A-Za-z0-9._-]. */
export const CLIENT_FILE_NAME = new RegExp(
  `^(?:${CLIENT_FILE_KINDS.join("|")})\\.[0-9a-f]{20}\\.json$`,
);

/** What `/api/datasets/<id>/client-files` answers. */
export interface ClientFileListingResponse {
  /** Every kind is written: the listing will not change until the next deploy or publish. */
  complete: boolean;
  /** Each written kind's public path, under `/datasets/gtnh/<id>/client/`. */
  files: Partial<Record<ClientFileKind, string>>;
}
