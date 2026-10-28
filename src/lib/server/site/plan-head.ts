import { isModAndCommunityOn } from "@/lib/deployment-features";
import type { PlanRow } from "@/lib/server/community-rows";
import { describePlanRow, getPublicPlanRow } from "@/lib/server/services/plan-preview";
import { SITE_IMAGE, SITE_NAME, siteHead, type PageHead } from "./head";

/** The head of `/` for a shared plan: the one place the page's head reads the database. */

/**
 * A shared plan's head: its name and the author's words (or the plan's
 * numbers), over the site's own image. Next merges a page's metadata into the
 * layout's per top-level key, so the plan's openGraph and twitter replace the
 * site's whole, and the image (a file convention, not a key) stays.
 */
export function planHead(row: PlanRow): PageHead {
  const description = describePlanRow(row);
  const planUrl = `/?plan=${encodeURIComponent(row.id)}`;
  return {
    title: `${row.name} | ${SITE_NAME}`,
    description,
    canonical: planUrl,
    openGraph: {
      title: row.name,
      description,
      siteName: SITE_NAME,
      type: "website",
      url: planUrl,
    },
    twitter: {
      card: "summary_large_image",
      title: row.name,
      description,
    },
    image: SITE_IMAGE,
  };
}

/**
 * The head of `/` for this query: a public plan's while the community library
 * is on, the site's for any other visit. Only a single `plan` parameter names
 * a plan, as in Next, where a repeated one arrives as a list.
 */
export async function headForRequest(search: URLSearchParams): Promise<PageHead> {
  if (!isModAndCommunityOn()) {
    return siteHead();
  }
  const plans = search.getAll("plan");
  const planId = plans.length === 1 ? plans[0] : undefined;
  const row = planId ? await getPublicPlanRow(planId) : undefined;
  return row ? planHead(row) : siteHead();
}
