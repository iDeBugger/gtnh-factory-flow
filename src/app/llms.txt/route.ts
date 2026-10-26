import { siteUrl } from "@/lib/site-url";
import {
  getCommunityDb,
  isCommunityConfigured,
  PLAN_SUMMARY_COLUMNS,
  type PlanRow,
} from "@/lib/server/community";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { describePlanRow, quietMarkdown } from "@/lib/server/plan-preview";
import { APP_VERSION } from "@/lib/version";

/**
 * The site as one page of markdown for language-model crawlers (the llms.txt
 * convention), which run no JavaScript and so see the planner as an empty
 * page. Top shared plans are linked because each plan URL server-renders its
 * name and summary into metadata. With the community library switched off,
 * neither the plans nor the community are mentioned.
 */
export const revalidate = 3600;

async function topPlans(base: string): Promise<string[]> {
  if (!isModAndCommunityOn() || !isCommunityConfigured()) {
    return [];
  }
  try {
    const { data } = await getCommunityDb()
      .from("community_plans")
      .select(PLAN_SUMMARY_COLUMNS)
      .or("is_public.eq.true,is_public.is.null")
      .order("score", { ascending: false })
      .limit(10)
      .returns<PlanRow[]>();
    // A name and a description are player text: one line each, with no markdown of their own.
    return (data ?? []).map(
      (row) =>
        `- [${quietMarkdown(row.name)}](${base}/?plan=${encodeURIComponent(row.id)}): ${quietMarkdown(describePlanRow(row))}`,
    );
  } catch {
    return [];
  }
}

export async function GET() {
  const base = siteUrl();
  const community = isModAndCommunityOn();
  const plans = await topPlans(base);

  const lines = [
    "# GTNH Planner",
    "",
    `> Free browser-based factory planner and recipe calculator for GregTech: New Horizons (GTNH), the Minecraft expert modpack. Draw production chains on an interactive flowchart, balance machine ratios, ${community ? "compute EU/t power draw and throughput, and share plans with the community" : "and compute EU/t power draw and throughput"}. No account and no install needed.`,
    "",
    "Key facts:",
    "",
    "- Carries full recipe data for GTNH 2.9 and 2.8.1, exported from the game itself (NEI/RecEx), including multiblock machines, ore dictionary alternatives, and programmed circuit settings.",
    "- Models GregTech mechanics faithfully: voltage tiers and overclocking, parallel processing on multiblocks, heat bonuses on the Electric Blast Furnace family, machine-specific speed and power coefficients.",
    "- A solver computes steady-state flow for the whole factory at once: what every machine produces and consumes per second, where the bottleneck is, and how full each machine runs.",
    "- Plans export as shareable links, JSON, PNG, or GIF. Opening a shared link loads the full plan, editable, with nothing to sign up for.",
    "- The planner is a client-side application. Pages carry little static HTML; a plan link's name and summary are server-rendered into its page metadata, so fetching a plan URL is the way to read a plan.",
    `- Version ${APP_VERSION} as of this file; ${base}/api/version reports what is live.`,
    "",
    "## Start here",
    "",
    `- [The planner](${base}/): the app itself. Everything happens on one page.`,
    community
      ? `- [Sitemap](${base}/sitemap.xml): the home page plus every public community plan.`
      : `- [Sitemap](${base}/sitemap.xml): the home page.`,
    "",
  ];

  if (plans.length > 0) {
    lines.push("## Popular community plans", "", ...plans, "");
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
