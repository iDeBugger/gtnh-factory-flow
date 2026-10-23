import { afterEach, beforeEach } from "vitest";

const NAME = "NEXT_PUBLIC_MOD_AND_COMMUNITY";

/**
 * Sets the variable for each test and puts back exactly what was there
 * afterwards. Only this one variable is touched: `vi.unstubAllEnvs()` here
 * would also drop stubs a file set up once in `beforeAll` (the live service
 * tests' database settings).
 */
function eachTest(value: string | undefined): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[NAME];
    if (value === undefined) {
      delete process.env[NAME];
    } else {
      process.env[NAME] = value;
    }
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env[NAME];
    } else {
      process.env[NAME] = saved;
    }
  });
}

/**
 * Turns the mod integration and the community library on for each test in
 * the calling file or describe. The suite runs with the deployment default
 * (off); only tests that exercise those features opt in.
 */
export function withModAndCommunityOn(): void {
  eachTest("on");
}

/** Removes the setting for each test, so "unset" is tested as truly absent, not as an empty string. */
export function withModAndCommunityUnset(): void {
  eachTest(undefined);
}
