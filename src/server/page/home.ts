import type { RequestHandler } from "express";
import { renderMetadataTags } from "@/lib/server/site/head";
import { headForRequest } from "@/lib/server/site/plan-head";
import { siteUrl } from "@/lib/site-url";
import { canonicalParts } from "../middleware/normalize-path";
import {
  pageOptionsAnswer,
  preloadLinkHeader,
  renderPage,
  setPageHeaders,
  type PageTemplate,
} from "./template";

/**
 * `/`: the prerendered page with the head for this visit (a public plan's, or the site's), every method but
 * OPTIONS, as Next rendered its page for any method. HEAD gets the headers only.
 */
export function homePage(template: PageTemplate): RequestHandler {
  const link = preloadLinkHeader(template.fontPreloads);
  return async (req, res, next) => {
    if (req.method === "OPTIONS") {
      pageOptionsAnswer(res);
      return;
    }
    try {
      const search = new URLSearchParams(canonicalParts(req).search.replace(/^\?/, ""));
      const head = await headForRequest(search);
      const html = renderPage(
        template,
        renderMetadataTags(head, siteUrl(), template.assetVersions),
      );
      res.statusCode = 200;
      setPageHeaders(res, link);
      res.end(html);
    } catch (error) {
      next(error);
    }
  };
}
