import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT = import.meta.dirname;

/** The module specifiers a file imports, in source order (static imports and side-effect imports). */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["'];?/gm)].map(
    (match) => match[1]!,
  );
}

/**
 * Zod probes for eval when the first schema is built, and the page's policy reports that probe as a violation.
 * Modules run in import order, so each browser entry must import zod-jitless.ts before any module that could
 * build a schema: only entry-started.ts, which imports nothing, may come first.
 */
describe("the browser entries' first imports", () => {
  it.each(["main.tsx", "dev/clean-card/main.tsx"])(
    "%s switches Zod's compiler off first",
    (entry) => {
      const file = path.join(CLIENT, entry);
      const imports = importsOf(file).map((specifier) =>
        specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : specifier,
      );
      const jitless = imports.indexOf(path.join(CLIENT, "zod-jitless"));
      expect(jitless, "zod-jitless is imported").toBeGreaterThanOrEqual(0);
      expect(imports.slice(0, jitless)).toEqual(
        imports
          .slice(0, jitless)
          .filter((specifier) => specifier === path.join(CLIENT, "entry-started")),
      );
    },
  );

  it("lets entry-started.ts and zod-jitless.ts import nothing that could build a schema", () => {
    expect(importsOf(path.join(CLIENT, "entry-started.ts"))).toEqual([]);
    expect(importsOf(path.join(CLIENT, "zod-jitless.ts"))).toEqual(["zod"]);
  });
});
