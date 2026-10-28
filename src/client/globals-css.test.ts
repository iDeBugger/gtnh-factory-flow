import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tailwind scans src/ for class names (globals.css). A captured Next answer (`__fixtures__/next-*`) holds Next's
 * markup, not the app's: scanned, it adds classes no element uses (its 404 page's `inline-block`), and the CSS
 * stops matching. Every such file must sit in a folder an `@source not` line leaves out.
 */
const SRC = path.resolve(import.meta.dirname, "..");
const CSS = readFileSync(path.join(import.meta.dirname, "globals.css"), "utf8");

function capturedFixtures(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return capturedFixtures(full);
    return full.split(path.sep).includes("__fixtures__") && entry.name.startsWith("next-")
      ? [full]
      : [];
  });
}

describe("globals.css", () => {
  it("leaves every captured Next answer out of Tailwind's scan", () => {
    const excluded = [...CSS.matchAll(/^@source not "([^"*]+)";$/gm)].map((match) =>
      path.resolve(import.meta.dirname, match[1]!),
    );
    const fixtures = capturedFixtures(SRC);
    expect(fixtures.length).toBeGreaterThan(0);
    const scanned = fixtures.filter(
      (file) => !excluded.some((folder) => file.startsWith(`${folder}${path.sep}`)),
    );
    expect(scanned.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
