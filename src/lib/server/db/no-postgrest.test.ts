import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The site and the live service speak only to Postgres: no file under src/
 * or tools/ names the PostgREST client, its stand-in or their settings,
 * comments included, so nothing can quietly bring a second database path
 * back. The exceptions below still name them for a reason, and each one
 * that stops doing so fails here, so the list only shrinks.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", "scratch", "dist-live", "dist-db"]);
const THIS_FILE = "src/lib/server/db/no-postgrest.test.ts";
const NAMES = [/postgrest/i, /getCommunityDb/, /LOCAL_DB_URL/, /@supabase/];

const EXCEPTIONS: Record<string, string> = {
  // A deployment still holding the old variables is told they are not read.
  "src/lib/server/startup-checks.ts": "warns that the old variables are not read",
  "src/lib/server/startup-checks.test.ts": "pins those warnings",
  "src/lib/server/CLAUDE.md": "names this test and the variables the startup checks warn about",
  // A server's .env still holding PostgREST's variables is refused by name.
  "tools/deploy/check-env.mjs": "refuses a POSTGREST_ variable left in the env",
  "tools/deploy/check-env.test.mjs": "pins that refusal",
};

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...filesUnder(relative));
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }
  return found;
}

function mentions(file: string): boolean {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return NAMES.some((name) => name.test(text));
}

// Reads every file in the tree: slow under the full suite's load.
describe("no PostgREST", () => {
  const files = [...filesUnder("src"), ...filesUnder("tools")].filter((file) => file !== THIS_FILE);

  it("no file under src/ or tools/ names PostgREST, its client or the stand-in's settings", () => {
    const named = files.filter((file) => !(file in EXCEPTIONS) && mentions(file)).sort();
    expect(named).toEqual([]);
  }, 60_000);

  it("every exception still names one", () => {
    const stale = Object.keys(EXCEPTIONS)
      .filter((file) => !files.includes(file) || !mentions(file))
      .sort();
    expect(stale, "fixed: remove these from EXCEPTIONS").toEqual([]);
  }, 60_000);
});
