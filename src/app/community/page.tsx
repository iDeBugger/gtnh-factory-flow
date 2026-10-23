import { notFound, redirect } from "next/navigation";
import { isModAndCommunityOn } from "@/lib/deployment-features";

/**
 * The community hub lives inside the planner. Legacy /community links
 * redirect: /community?plan=x becomes /?plan=x, everything else goes home.
 * With the community library switched off the path does not exist.
 */
export default async function CommunityRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isModAndCommunityOn()) {
    notFound();
  }
  const params = await searchParams;
  const plan = typeof params.plan === "string" ? params.plan : undefined;
  redirect(plan ? `/?plan=${encodeURIComponent(plan)}` : "/");
}
