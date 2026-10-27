/**
 * The server the Postgres race tests (`services/*-postgres.test.ts`) make
 * and drop their databases on: GTNH_TEST_POSTGRES_URL. They are the only
 * tests where transactions overlap (on PGlite they never do), so CI runs
 * them against its postgres service. Without the URL a local run skips
 * them; under CI a missing URL is an error, so the service cannot be
 * dropped from the workflow unnoticed.
 */
export function realPostgresUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const url = env.GTNH_TEST_POSTGRES_URL || undefined;
  if (!url && env.CI) {
    throw new Error(
      "CI runs the Postgres race tests: GTNH_TEST_POSTGRES_URL is not set (the CI workflow's postgres service).",
    );
  }
  return url;
}
