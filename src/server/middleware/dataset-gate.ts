import type { RequestHandler } from "express";
import { decideDatasetPath } from "@/lib/server/dataset-path-gate";
import { canonicalParts } from "./normalize-path";

const REFUSED_BODY = JSON.stringify({ error: "Invalid dataset path." });

/**
 * The dataset path gate (dataset-path-gate.ts) on the canonical path: the WHATWG pathname Next's proxy saw, dot
 * segments resolved and every percent escape kept, so each encoded spelling is still refused.
 * - A refusal answers 400 no-store, varying on the encoding (`Vary: Accept-Encoding`), as the parity fixtures pin.
 * - A rewrite points the request at the dataset-files route, the original query kept. As Next's proxy did, the
 *   answer names the new path in `x-middleware-rewrite`.
 */
export function datasetGate(): RequestHandler {
  return (req, res, next) => {
    const { pathname, search } = canonicalParts(req);
    const decision = decideDatasetPath(pathname);
    if (decision.kind === "refuse") {
      res.statusCode = 400;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "application/json");
      res.setHeader("vary", "Accept-Encoding");
      res.end(REFUSED_BODY);
      return;
    }
    if (decision.kind === "rewrite") {
      const rewritten = decision.pathname + search;
      req.url = rewritten;
      req.canonicalUrl = rewritten;
      res.setHeader("x-middleware-rewrite", decision.pathname);
    }
    next();
  };
}
