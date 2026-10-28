import { HEAD_LEAD, renderMetadataTags, siteHead } from "@/lib/server/site/head";
import { siteUrl } from "@/lib/site-url";
import { renderPage, type PageTemplate } from "./template";

/**
 * The not-found page as Next rendered it: the site's layout around Next's default not-found markup. Next put
 * `noindex` ahead of the layout's metadata, kept the whole site head (the site title first, so it is the
 * title a browser shows), and added the 404 title last. The body keeps the boot scripts and the JSON-LD, then
 * the not-found markup and the layout's zoom layer. The page runs no module script: there is no app to start.
 */
export const NOT_FOUND_ROBOTS = '<meta name="robots" content="noindex"/>';
export const NOT_FOUND_TITLE = "<title>404: This page could not be found.</title>";

/** Next's default not-found markup, byte for byte, then the layout's zoom layer. */
export const NOT_FOUND_BODY =
  '<div style="font-family:system-ui,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif,&quot;Apple Color Emoji&quot;,&quot;Segoe UI Emoji&quot;;height:100vh;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
  "<div><style>body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}</style>" +
  '<h1 class="next-error-h1" style="display:inline-block;margin:0 20px 0 0;padding:0 23px 0 0;font-size:24px;font-weight:500;vertical-align:top;line-height:49px">404</h1>' +
  '<div style="display:inline-block"><h2 style="font-size:14px;font-weight:400;line-height:49px;margin:0">This page could not be found.</h2></div>' +
  "</div></div>" +
  '<div class="ui-zoom"></div>';

const ROOT_OPEN = '<div id="root" style="display: contents">';
const MODULE_SCRIPT = /<script type="module"[^>]*>[\s\S]*?<\/script>/g;

/** The not-found head after the charset and viewport: `noindex`, the site's metadata, the 404 title. */
export function notFoundHead(versions: PageTemplate["assetVersions"] = {}): string {
  return NOT_FOUND_ROBOTS + renderMetadataTags(siteHead(), siteUrl(), versions) + NOT_FOUND_TITLE;
}

/**
 * The not-found page. With the built page, its stylesheet, font preload, boot scripts and JSON-LD stay, its
 * module scripts go, and the not-found markup takes the root's place. Without one (a bare app in tests), the
 * same head and markup on their own.
 */
export function renderNotFoundPage(template?: PageTemplate): string {
  if (!template) {
    return (
      `<!doctype html><html lang="en" class="h-full"><head>${HEAD_LEAD}${notFoundHead()}</head>` +
      `<body class="min-h-full">${NOT_FOUND_BODY}</body></html>`
    );
  }
  const page = renderPage(template, notFoundHead(template.assetVersions));
  const withoutScripts = page.replace(MODULE_SCRIPT, "");
  if (withoutScripts === page) throw new Error("The page template holds no module script.");
  const open = withoutScripts.indexOf(ROOT_OPEN);
  const bodyEnd = withoutScripts.lastIndexOf("</body>");
  const close = withoutScripts.lastIndexOf("</div>", bodyEnd);
  if (open < 0 || close < open) throw new Error(`The page template must hold ${ROOT_OPEN}.`);
  return (
    withoutScripts.slice(0, open + ROOT_OPEN.length) + NOT_FOUND_BODY + withoutScripts.slice(close)
  );
}
