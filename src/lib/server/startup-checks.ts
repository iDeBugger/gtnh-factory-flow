/**
 * What the website's server checks as it starts (src/instrumentation.ts,
 * which exits the process when a check throws, so nothing serves
 * half-configured and the restart policy sees the failure):
 *
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
 * - DATABASE_URL missing in production: it warns. Accounts, the library and
 *   blueprints answer that they are off while the planner keeps serving.
 * - A variable of an earlier database setup set (SUPABASE_URL,
 *   SUPABASE_SERVICE_ROLE_KEY, LOCAL_DB): it warns and names DATABASE_URL,
 *   the one variable the database client reads, so an old environment file
 *   does not leave the server without a database while looking configured.
 *   The deployed stack's env check refuses the REST client's variables by
 *   name before anything starts (tools/deploy/check-env.mjs).
 * - NEXT_PUBLIC_MOD_AND_COMMUNITY in the process says otherwise than the
 *   build's (modAndCommunityMismatch): it says so as an error line. The
 *   switch then stays off on the server (deployment-features.ts). Built on,
 *   the page still shows the mod and the library, whose routes answer 404;
 *   built off, both stay off and only the env disagrees. Not refused, as the
 *   deployment's fail-safe is to keep serving the planner.
 */
export const SHORT_SECRET_LENGTH = 16;

const isOn = (value: string | undefined) => value?.trim().toLowerCase() === "on";

/**
 * The line to log when the running process's NEXT_PUBLIC_MOD_AND_COMMUNITY
 * and the build's disagree, read the way deployment-features.ts reads them
 * (exactly "on", any case, trimmed); undefined when they agree.
 */
export function modAndCommunityMismatch(
  built: string | undefined,
  running: string | undefined,
): string | undefined {
  if (isOn(built) === isOn(running)) return undefined;
  if (isOn(built)) {
    return (
      "[mod-and-community] NEXT_PUBLIC_MOD_AND_COMMUNITY is off here but on in the build: the page shows the " +
      "mod link and the community library, and their routes answer 404. Start the server with it on, or rebuild with it off."
    );
  }
  return (
    "[mod-and-community] NEXT_PUBLIC_MOD_AND_COMMUNITY is on here but off in the build: the mod link and the " +
    "community library stay off, in the page and on the server. Rebuild with it on, or unset it here."
  );
}

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

/** Variables no database client reads any more. */
const UNREAD_DB_VARIABLES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "LOCAL_DB",
] as const;

export function checkServerSetup(
  warn: (message: string) => void = console.warn,
  error: (message: string) => void = console.error,
): void {
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
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
    warn("[db] DATABASE_URL is not set: accounts, the library and blueprints are off.");
  }
  for (const name of UNREAD_DB_VARIABLES) {
    if (process.env[name]) {
      warn(`[db] ${name} is not read: set DATABASE_URL.`);
    }
  }
  // The literal read is the build's value, inlined by the server build; the Reflect.get read is never inlined.
  const mismatch = modAndCommunityMismatch(
    process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY,
    Reflect.get(process.env, "NEXT_PUBLIC_MOD_AND_COMMUNITY") as string | undefined,
  );
  if (mismatch) {
    error(mismatch);
  }
}
