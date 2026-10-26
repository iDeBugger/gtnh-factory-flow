import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The live service's start-up checks, run as the process itself. */

function start(env: Record<string, string>) {
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const { PATH, HOME } = process.env;
  return spawnSync(tsx, [path.join("src", "live", "main.ts")], {
    cwd: process.cwd(),
    env: { PATH: PATH ?? "", HOME: HOME ?? "", NODE_ENV: "development", LIVE_PORT: "0", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("the live service's start", () => {
  it("refuses to start without DATABASE_URL, saying so in one line", () => {
    const run = start({
      COMMUNITY_HASH_SALT: "main-test-salt",
      POSTGREST_URL: "http://127.0.0.1:9",
      POSTGREST_SERVICE_TOKEN: "token",
    });
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(
      "[live] DATABASE_URL is not set: the live service reads and writes plans in the database.",
    );
  }, 30_000);
});
