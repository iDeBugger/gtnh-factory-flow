import { describe, expect, it } from "vitest";
import { APP_FONT_STORAGE_KEY, DEFAULT_APP_FONT } from "@/lib/app-font";
import { uiScaleBootScript } from "@/lib/ui-scale-boot";
import {
  COMPACT_MAX_HEIGHT,
  COMPACT_MAX_WIDTH,
  PHONE_MAX_HEIGHT,
  PHONE_MAX_WIDTH,
  SNUG_MAX_WIDTH,
} from "@/lib/viewport-breakpoints";
import { renderShell } from "./prerender";

describe("renderShell", () => {
  it("renders the shell with the page's boot scripts", () => {
    const { shell, bootScripts, structuredData } = renderShell();

    expect(bootScripts).toHaveLength(2);
    expect(bootScripts[0]).toBe(
      `try{var f=localStorage.getItem(${JSON.stringify(APP_FONT_STORAGE_KEY)});if(f&&f!==${JSON.stringify(
        DEFAULT_APP_FONT,
      )})document.documentElement.setAttribute("data-app-font",f)}catch(e){}`,
    );
    expect(bootScripts[1]).toBe(
      uiScaleBootScript({
        phoneMaxWidth: PHONE_MAX_WIDTH,
        phoneMaxHeight: PHONE_MAX_HEIGHT,
        compactMaxWidth: COMPACT_MAX_WIDTH,
        compactMaxHeight: COMPACT_MAX_HEIGHT,
        snugMaxWidth: SNUG_MAX_WIDTH,
      }),
    );

    // The app's own markup, the JS-less paragraph and the what's-new layer, in AppRoot.tsx's order.
    expect(shell).toContain('class="ui-scale-shell');
    expect(shell).toContain("<noscript>");
    expect(shell).toContain("The planner needs JavaScript to run.");
    expect(shell.indexOf("ui-scale-shell")).toBeLessThan(shell.indexOf("<noscript>"));
    expect(shell.indexOf("<noscript>")).toBeLessThan(shell.indexOf('class="ui-zoom"'));

    const data = JSON.parse(structuredData);
    expect(data["@context"]).toBe("https://schema.org");
    expect(data["@graph"][0]["@type"]).toBe("WebSite");
  });
});
