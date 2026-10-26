import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { realPostgresUrl } from "./real-postgres";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("the Postgres race tests' server", () => {
  it("is skipped locally without a URL and is an error under CI", () => {
    expect(realPostgresUrl({})).toBeUndefined();
    expect(() => realPostgresUrl({ CI: "true" })).toThrow(/GTNH_TEST_POSTGRES_URL is not set/);
    expect(realPostgresUrl({ CI: "true", GTNH_TEST_POSTGRES_URL: "postgres://x@h/db" })).toBe(
      "postgres://x@h/db",
    );
  });

  it("is CI's postgres service, the compose file's image by digest, named to the test step", () => {
    const composeImage = /^\s+image: (postgres:\S+@sha256:[0-9a-f]{64})$/m.exec(
      read("tools/deploy/docker-compose.yml"),
    )?.[1];
    expect(composeImage).toBeDefined();
    const ci = read(".github/workflows/ci.yml");
    const testJob = ci.slice(ci.indexOf("\n  test:\n"), ci.indexOf("\n  icon-browsers:\n"));
    expect(testJob).toContain(`\n    services:\n      postgres:\n        image: ${composeImage}\n`);
    const password = /POSTGRES_PASSWORD: (\S+)/.exec(testJob)?.[1];
    expect(testJob).toMatch(
      new RegExp(
        `- run: npm run test\\n        env:\\n          GTNH_TEST_POSTGRES_URL: postgres://postgres:${password}@127\\.0\\.0\\.1:5432/postgres\\n`,
      ),
    );
  });
});
