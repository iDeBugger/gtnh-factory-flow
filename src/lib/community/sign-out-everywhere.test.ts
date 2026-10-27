import { afterEach, describe, expect, it, vi } from "vitest";
import { logoutCommunityUser, signOutEverywhereMessage } from "./client";

const DOWN = "The community database is not responding. Try again in a few minutes.";
const FIXED = "Could not sign out everywhere. Try again.";

/** The sentence a failed sign-out everywhere leaves the player. */
async function messageFor(answer: () => Promise<Response>): Promise<string> {
  vi.stubGlobal("fetch", vi.fn(answer));
  const error = await logoutCommunityUser({ everywhere: true }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeDefined();
  return signOutEverywhereMessage(error);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a failed sign-out everywhere", () => {
  it("says the server's sentence when it sends one, else the fixed one", async () => {
    expect(await messageFor(async () => Response.json({ error: DOWN }, { status: 503 }))).toBe(
      DOWN,
    );
    expect(await messageFor(async () => Response.json({ error: FIXED }, { status: 503 }))).toBe(
      FIXED,
    );
    expect(
      await messageFor(async () => new Response("<html>Bad gateway</html>", { status: 502 })),
    ).toBe(FIXED);
    expect(await messageFor(async () => Response.json({}, { status: 500 }))).toBe(FIXED);
    // A network failure's own text never shows.
    expect(
      await messageFor(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).toBe(FIXED);
  });
});
