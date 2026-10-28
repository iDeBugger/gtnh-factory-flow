import { renderToString } from "react-dom/server";
import { APP_FONT_STORAGE_KEY, DEFAULT_APP_FONT } from "@/lib/app-font";
import { siteUrl } from "@/lib/site-url";
import { uiScaleBootScript } from "@/lib/ui-scale-boot";
import {
  COMPACT_MAX_HEIGHT,
  COMPACT_MAX_WIDTH,
  PHONE_MAX_HEIGHT,
  PHONE_MAX_WIDTH,
  SNUG_MAX_WIDTH,
} from "@/lib/viewport-breakpoints";
import { AppRoot } from "./AppRoot";

/*
 * Restamps the saved font choice before anything paints, so a reload never
 * flashes the default font. Unknown values match no CSS rule and land on the
 * default; setAppFont owns the real validation.
 */
const appFontBootScript = `try{var f=localStorage.getItem(${JSON.stringify(
  APP_FONT_STORAGE_KEY,
)});if(f&&f!==${JSON.stringify(
  DEFAULT_APP_FONT,
)})document.documentElement.setAttribute("data-app-font",f)}catch(e){}`;

/*
 * Stamps the interface size (ui-scale.ts) and the compact/snug viewport
 * attributes before first paint, for the same reason: a page that painted at
 * one size and snapped to another would flash on every load.
 */
const uiScaleBoot = uiScaleBootScript({
  phoneMaxWidth: PHONE_MAX_WIDTH,
  phoneMaxHeight: PHONE_MAX_HEIGHT,
  compactMaxWidth: COMPACT_MAX_WIDTH,
  compactMaxHeight: COMPACT_MAX_HEIGHT,
  snugMaxWidth: SNUG_MAX_WIDTH,
});

/**
 * What the site is, said in schema.org's terms for crawlers that read
 * structured data. Kept to claims a machine can verify: free, runs in a
 * browser, about GregTech: New Horizons.
 */
function structuredData() {
  const site = siteUrl();
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${site}/#website`,
        url: `${site}/`,
        name: "GTNH Planner",
      },
      {
        "@type": "WebApplication",
        "@id": `${site}/#app`,
        url: `${site}/`,
        name: "GTNH Planner",
        alternateName: "GregTech New Horizons Factory Planner",
        description:
          "Free factory planner and recipe calculator for GregTech: New Horizons. Draw production chains on a flowchart, balance machine ratios, compute power and throughput, and share plans.",
        applicationCategory: "GameApplication",
        operatingSystem: "Any",
        browserRequirements: "Requires JavaScript",
        image: `${site}/icon-512.png`,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        about: {
          "@type": "VideoGame",
          name: "GregTech: New Horizons",
          gamePlatform: "Minecraft",
        },
      },
    ],
  };
}

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
