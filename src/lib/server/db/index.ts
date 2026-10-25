/**
 * The database entry: the client and what its failures say. Repositories
 * and the live service import the database through here.
 */
export {
  COMMUNITY_DB_TIMEOUT_MS,
  fetchWithDbTimeout,
  getCommunityDb,
  isCommunityConfigured,
  type DbClient,
} from "./rest";
export { DB_BREAKER_FAILURES, DB_BREAKER_OPEN_MS, resetDbBreaker } from "./breaker";
export {
  blueprintStorageErrorMessage,
  COMMUNITY_DB_DOWN_MESSAGE,
  communityStorageErrorMessage,
  isMissingColumnError,
  libraryStorageErrorMessage,
} from "./errors";

/** A transaction handle, which repositories take as their last argument; none exists yet. */
export type Tx = never;
