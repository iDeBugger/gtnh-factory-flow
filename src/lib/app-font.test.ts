import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_FONTS, DEFAULT_APP_FONT, isAppFontId } from "./app-font";

describe("app fonts", () => {
  it("has unique ids and includes the default", () => {
    const ids = APP_FONTS.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_APP_FONT);
  });

  it("recognises exactly its own ids", () => {
    for (const option of APP_FONTS) {
      expect(isAppFontId(option.id)).toBe(true);
    }
    expect(isAppFontId("comic-sans")).toBe(false);
    expect(isAppFontId(null)).toBe(false);
  });

  // The stacks live twice on purpose: once here for the picker's previews and
  // once in globals.css as the rules the <html> attribute switches between.
  // This is the tripwire for editing one and not the other.
  it("matches the globals.css rules stack for stack", () => {
    const css = readFileSync(
      path.resolve(__dirname, "../client/globals.css"),
      "utf8",
    );

    for (const option of APP_FONTS) {
      if (option.id === DEFAULT_APP_FONT) {
        expect(css).toContain(`--app-font: ${option.stack};`);
        continue;
      }
      const rule = new RegExp(
        `html\\[data-app-font="${option.id}"\\]\\s*\\{\\s*--app-font:\\s*${escapeRegExp(
          option.stack,
        )};`,
      );
      expect(css).toMatch(rule);
    }
  });

  it("defaults to Inter", () => {
    expect(DEFAULT_APP_FONT).toBe("inter");
  });

  // The game's hard text shadow and unsmoothed edges suit the pixel font alone: under a vector face the shadow reads
  // as a blur and macOS draws unsmoothed text jagged.
  it("dresses the pixel font alone in its shadow and unsmoothed edges", () => {
    const globals = readFileSync(path.resolve(__dirname, "../client/globals.css"), "utf8");
    const pixelRule = /html\[data-app-font="minecraft"\]\s*\{([^}]*)\}/.exec(globals)?.[1] ?? "";
    expect(pixelRule).toMatch(/--pixel-text-shadow:\s*1px 1px 0 /);
    expect(pixelRule).toMatch(/--pixel-font-smoothing:\s*none;/);
    expect(globals).toMatch(/:root\s*\{[^}]*--pixel-text-shadow:\s*none;[^}]*--pixel-font-smoothing:\s*auto;/);

    // The board's cards, drawers and overview wear them through the variables.
    for (const file of ["clean.css", "drawer/drawer.css", "rail/rail.css"]) {
      const css = readFileSync(path.resolve(__dirname, "../components/flow/clean", file), "utf8");
      expect(css, file).not.toMatch(/-webkit-font-smoothing:\s*none/);
      expect(css, file).not.toMatch(/text-shadow:\s*1px 1px 0 color-mix/);
    }
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
