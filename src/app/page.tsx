import type { Metadata } from "next";
import { FactoryPlannerApp } from "@/components/FactoryPlannerApp";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { getPublicPlanRow } from "@/lib/server/services/plan-preview";
import { planHead } from "@/lib/server/site/head";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * A shared link unfurls as the plan it carries (`planHead`): its name and the
 * author's words (or the plan's numbers), over the site's own image. Any other
 * visit, and any plan a crawler may not see, falls through to the layout's
 * metadata untouched, as does every visit while the community library is
 * switched off.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  if (!isModAndCommunityOn()) {
    return {};
  }
  const params = await searchParams;
  const planId = typeof params.plan === "string" ? params.plan : undefined;
  const row = planId ? await getPublicPlanRow(planId) : undefined;
  if (!row) {
    return {};
  }

  const head = planHead(row);
  return {
    title: head.title,
    description: head.description,
    alternates: { canonical: head.canonical },
    openGraph: { ...head.openGraph },
    twitter: { ...head.twitter },
  };
}

export default function Home() {
  const community = isModAndCommunityOn();
  return (
    <>
      <FactoryPlannerApp />
      {/* The one paragraph a JS-less visitor (or crawler) gets. Renders
          nothing at all when the app itself is going to. */}
      <noscript>
        <h1>GTNH Planner</h1>
        <p>
          A free factory planner and recipe calculator for GregTech: New
          Horizons. Draw production chains on an interactive flowchart with
          full recipe data for GTNH 2.9 and 2.8.1, balance machine ratios,
          {community
            ? " compute power and throughput, and share plans with the community."
            : " and compute power and throughput."}{" "}
          The planner needs JavaScript to run.
        </p>
      </noscript>
    </>
  );
}
