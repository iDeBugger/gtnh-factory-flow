import { renderToString } from "react-dom/server";
import { AppRoot } from "./AppRoot";
import { appFontBootScript, structuredData, uiScaleBoot } from "./boot";

export interface RenderedShell {
  /** The app's markup, hydrated by main.tsx. */
  shell: string;
  /** The inline scripts that run before first paint: the font, then the interface size. */
  bootScripts: string[];
  /** The JSON-LD text. */
  structuredData: string;
}

/**
 * The page's body at build: the app as it first renders, so the first paint
 * is the planner's frame before any script runs, plus the boot scripts that
 * set the saved font and size before that paint.
 */
export function renderShell(): RenderedShell {
  return {
    shell: renderToString(<AppRoot />),
    bootScripts: [appFontBootScript, uiScaleBoot],
    structuredData: JSON.stringify(structuredData()),
  };
}
