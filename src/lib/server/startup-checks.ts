import { assertLocalDbAllowed } from "./local-db/client";

/**
 * What the website's server checks as it starts (src/instrumentation.ts,
 * which exits the process when a check throws, so nothing serves
 * half-configured and systemd sees the failure):
 *
 * - LOCAL_DB=1 never runs in production: it throws.
 * - COMMUNITY_HASH_SALT missing or blank: it warns. The secret accessor in
 *   session.ts refuses to sign or check anything in production without it, so
 *   sign-in, the library and blueprints are off while the planner keeps
 *   serving; a throw here would take the planner down with them. A short
 *   value gets its own warning but is not refused: refusing would stop a
 *   running deployment, and rotating the value signs everyone out, which is
 *   the owner's call.
 * - GTNH_MAX_LOADED_RECIPE_SHARDS is no longer read (the shard cache is bounded
 *   by bytes): it warns and names GTNH_MAX_LOADED_RECIPE_SHARD_MB, so a unit
 *   that still sets it does not believe it is in effect.
 */
export const SHORT_SECRET_LENGTH = 16;

/**
 * The checks as the server runs them: a failure ends the process. A throw left
 * inside the instrumentation hook keeps the port bound and answers 500 to
 * every request, and a restart policy never notices a live process. Here
 * rather than in instrumentation.ts, which Next.js also compiles for the Edge
 * runtime, where process.exit does not exist.
 */
export function checkServerSetupOrExit(): void {
  try {
    checkServerSetup();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export function checkServerSetup(warn: (message: string) => void = console.warn): void {
  assertLocalDbAllowed();
  const salt = process.env.COMMUNITY_HASH_SALT;
  if (salt === undefined || salt.trim() === "") {
    warn(
      "[auth] COMMUNITY_HASH_SALT is not set: sign-in, the library and blueprints are off until it is set.",
    );
  } else if (salt.length < SHORT_SECRET_LENGTH) {
    warn(
      `[auth] COMMUNITY_HASH_SALT is shorter than ${SHORT_SECRET_LENGTH} characters: use a long random value (openssl rand -hex 32).`,
    );
  }
  if (process.env.GTNH_MAX_LOADED_RECIPE_SHARDS) {
    warn(
      "[datasets] GTNH_MAX_LOADED_RECIPE_SHARDS is ignored: the recipe shard cache is bounded in MB by GTNH_MAX_LOADED_RECIPE_SHARD_MB.",
    );
  }
}
