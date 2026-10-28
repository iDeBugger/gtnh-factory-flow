import type { RequestHandler } from "express";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { canonicalParts } from "../middleware/normalize-path";
import {
  pageOptionsAnswer,
  preloadLinkHeader,
  setPageHeaders,
  type PageTemplate,
} from "./template";

/**
 * `/community`: the hub lives inside the planner, so old links redirect. `/community?plan=x` goes to `/?plan=x`
 * and anything else (no plan, an empty or a repeated one) goes home, with Next's 307 from `redirect()` for every
 * method but OPTIONS. The body is empty: Next sent its error document, which a browser never shows. With the
 * community library switched off the path does not exist and falls through to the 404.
 */
export function communityRedirect(template: PageTemplate): RequestHandler {
  const link = preloadLinkHeader(template.fontPreloads);
  return (req, res, next) => {
    if (!isModAndCommunityOn()) {
      next();
      return;
    }
    if (req.method === "OPTIONS") {
      pageOptionsAnswer(res);
      return;
    }
    const plans = new URLSearchParams(canonicalParts(req).search.replace(/^\?/, "")).getAll("plan");
    const plan = plans.length === 1 ? plans[0] : undefined;
    res.statusCode = 307;
    setPageHeaders(res, link);
    res.setHeader("location", plan ? `/?plan=${encodeURIComponent(plan)}` : "/");
    res.end();
  };
}
